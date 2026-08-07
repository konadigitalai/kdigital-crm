// Gmail send API. Mounted at /gmail behind authMiddleware.
//
// Reuses the messaging.* permissions rather than minting email.* ones — email
// is a channel in the same inbox as SMS/WhatsApp, and every group that can
// message a lead should be able to email one. Nothing to re-configure.
//
// Sender resolution (the "advisor default, shared fallback" the product asked
// for): the caller's own connected mailbox if they have one, else the shared
// mailbox (GMAIL_SHARED_ACCOUNT_EMAIL), else 503 with a code the UI turns into
// a "Connect Gmail" prompt.
//
// Consent: email is bootstrapped at lead-create (see routes/leads.ts) and on
// any inbound reply, and one-off human-initiated sends are NOT gated — the
// same policy /twilio/send already follows. The campaign engine is where a
// gate belongs, and it already applies one.

import { Router } from "@/server/http";
import { sql } from "drizzle-orm";
import { withTenant, tenantExec } from "../db/app";
import { requirePermission } from "../middleware/require";
import { resolveActorPartyId } from "../lib/party/resolve";
import {
  readGoogleConfig, GoogleNotConfigured, accessTokenFor, sendRaw,
  type GmailAccountRow,
} from "../lib/gmail/client";
import { buildMime, type Attachment } from "../lib/gmail/mime";
import { recordOutboundEmail } from "../lib/gmail/ingest";
import {
  matchOrCreatePartyByEmail, upsertConversation, insertActivityForMessage,
  type DbExec,
} from "../lib/twilio/inbox";
import { bootstrapConsent } from "../lib/party/consent";

export const gmailRouter = Router();

const MAX_ATTACHMENTS   = 10;
// Gmail's hard limit is 35 MB of raw (base64-encoded) MIME. Base64 inflates by
// ~33%, so we cap the pre-encoding payload at 25 MB to stay clear of it.
const MAX_ATTACH_BYTES  = 25 * 1024 * 1024;

// ─── POST /gmail/send ────────────────────────────────────────────────────
// {
//   to,                      // email address OR a lead number like "LEAD-9865"
//   subject, body, bodyHtml?, cc?,
//   mediaAssetIds?,          // attachments, from the media library
//   inReplyToMessageId?      // a tw_message.id — makes this a threaded reply
// }
gmailRouter.post("/send", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const b = req.body as {
      to?: string; subject?: string; body?: string; bodyHtml?: string;
      cc?: string[]; mediaAssetIds?: string[]; inReplyToMessageId?: string;
    };
    const to   = String(b.to ?? "").trim();
    const text = String(b.body ?? "");
    const cc   = Array.isArray(b.cc)
      ? b.cc.map((x) => String(x).trim().toLowerCase()).filter((x) => x.includes("@")).slice(0, 20)
      : [];
    const mediaAssetIds = Array.isArray(b.mediaAssetIds)
      ? b.mediaAssetIds.slice(0, MAX_ATTACHMENTS)
      : [];
    const inReplyToMessageId = String(b.inReplyToMessageId ?? "").trim() || null;

    if (!to) return res.status(400).json({ error: "to is required" });
    if (!text.trim() && !b.bodyHtml && mediaAssetIds.length === 0) {
      return res.status(400).json({ error: "body, bodyHtml, or mediaAssetIds is required" });
    }

    let cfg;
    try { cfg = readGoogleConfig(); }
    catch (e) {
      if (e instanceof GoogleNotConfigured) {
        return res.status(503).json({ error: e.message, code: "gmail_not_configured" });
      }
      throw e;
    }

    // Three-phase: resolve + build the MIME, COMMIT, then talk to Google with
    // no transaction held, then record. Token refresh and the Gmail send are
    // both network calls; leaving them inside the transaction pinned a pool
    // connection for the round trip. See the contract on withTenant in
    // db/app.ts.
    const prep = await withTenant(req.tenantId!, async (db) => {
      const account = await resolveSenderAccount(db, req.userId!);
      if (!account) return { kind: "no-account" as const };

      const target = await resolveToEmail(db, to);
      if (!target) return { kind: "no-email" as const };

      // Threaded reply: inherit the parent's Gmail thread, its Message-ID (so
      // the RECIPIENT's client threads our reply, not just ours), and its
      // subject. Gmail's threadId alone does nothing for the other end.
      let threadId: string | null = null;
      let inReplyTo: string | null = null;
      let references: string[] = [];
      let subject = String(b.subject ?? "").trim();

      if (inReplyToMessageId) {
        const p = await db.execute(sql`
          SELECT provider_thread_id AS "threadId",
                 rfc822_message_id  AS "rfc822",
                 subject
          FROM tw_message
          WHERE id = ${inReplyToMessageId} AND channel = 'email'
          LIMIT 1
        `);
        const parent = p.rows[0] as
          { threadId: string | null; rfc822: string | null; subject: string | null } | undefined;
        if (!parent) return { kind: "bad-parent" as const };
        threadId  = parent.threadId;
        inReplyTo = parent.rfc822;
        if (parent.rfc822) references = [parent.rfc822];
        if (!subject) {
          const s = parent.subject ?? "";
          subject = /^re:/i.test(s) ? s : `Re: ${s}`;
        }
      }
      if (!subject) subject = "(no subject)";

      const attachments = await loadAttachments(db, mediaAssetIds);
      if (attachments.kind === "missing") return attachments;
      if (attachments.kind === "too-big") return attachments;

      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);

      const mime = buildMime({
        fromEmail:   account.email,
        fromName:    req.user?.name ?? null,
        to:          [target.email],
        cc,
        subject,
        bodyText:    text,
        bodyHtml:    b.bodyHtml ?? null,
        attachments: attachments.files,
        inReplyTo,
        references,
      });

      return {
        kind: "ready" as const,
        account, target, threadId, inReplyTo, subject, attachments, actorPartyId, mime,
      };
    });

    switch (prep.kind) {
      case "no-account":
        return res.status(503).json({
          code: "no_gmail_account",
          error: "No Gmail account is connected. Connect yours in Settings, or ask an admin to connect the shared mailbox.",
        });
      case "no-email":
        return res.status(400).json({ code: "no_email", error: `No email address on file for ${to}` });
      case "bad-parent":
        return res.status(400).json({ error: "inReplyToMessageId does not refer to an email message" });
      case "missing":
        return res.status(400).json({ error: `Unknown media asset: ${prep.assetId}` });
      case "too-big":
        return res.status(400).json({
          error: `Attachments total ${Math.round(prep.bytes / 1024 / 1024)} MB — Gmail's limit is 25 MB.`,
        });
    }

    const { account, target, threadId, inReplyTo, subject, attachments, actorPartyId } = prep;

    // Network phase — no transaction open. accessTokenFor may itself write a
    // refreshed token back, so it gets the per-statement handle rather than a
    // held transaction.
    const token = await accessTokenFor(tenantExec(req.tenantId!), account);
    const send  = await sendRaw(token, prep.mime, threadId);

    // Bookkeeping phase — the mail has already left Google's side.
    const result = await withTenant(req.tenantId!, async (db) => {
      const conv = await upsertConversation(
        db, target.partyId, "email", target.workItemId == null,
      );
      const messageId = await recordOutboundEmail(db, {
        conversationId:    conv.id,
        gmailAccountId:    account.id,
        fromAddr:          account.email,
        toAddrs:           [target.email],
        ccAddrs:           cc,
        subject,
        bodyText:          text,
        bodyHtml:          b.bodyHtml ?? null,
        senderUserPartyId: actorPartyId,
        inReplyTo,
        mediaAssetIds,
        send,
      });

      if (send.ok) {
        // Emailing someone is not consent, but it does establish the channel —
        // bootstrapConsent only fills a gap, it never overrides an opt-out.
        await bootstrapConsent(db, target.partyId, ["email"], "outbound_email");
        await insertActivityForMessage(db, {
          workItemId:   target.workItemId,
          partyId:      target.partyId,
          actorType:    "user",
          actorPartyId,
          actorName:    req.user?.name ?? account.email,
          direction:    "outbound",
          channel:      "email",
          body:         text,
          subject,
          mediaCount:   attachments.files.length,
          mediaMimes:   attachments.files.map((f) => f.mimeType),
        });
      }

      return {
        kind: "sent" as const,
        ok: send.ok,
        messageId,
        conversationId: conv.id,
        from: account.email,
        to: target.email,
        error: send.errorMessage,
      };
    });

    // The validation branches are handled off `prep` above, before the send —
    // by this point the only outcome left is whether Gmail accepted it.
    if (!result.ok) return res.status(502).json({ error: result.error ?? "Gmail send failed" });
    return res.json(result);
  } catch (e) { next(e); }
});

// ─── Sender resolution ───────────────────────────────────────────────────

/** The caller's own connected mailbox, else the shared fallback, else null. */
async function resolveSenderAccount(db: DbExec, userId: string): Promise<GmailAccountRow | null> {
  const cols = sql`
    id, email, refresh_token AS "refreshToken", access_token AS "accessToken",
    expires_at AS "expiresAt", history_id AS "historyId",
    app_user_id AS "appUserId", is_shared AS "isShared"
  `;
  const mine = await db.execute(sql`
    SELECT ${cols} FROM gmail_account
    WHERE app_user_id = ${userId} AND revoked_at IS NULL
    LIMIT 1
  `);
  if (mine.rows[0]) return mine.rows[0] as unknown as GmailAccountRow;

  const shared = await db.execute(sql`
    SELECT ${cols} FROM gmail_account
    WHERE is_shared = true AND revoked_at IS NULL
    LIMIT 1
  `);
  return (shared.rows[0] as unknown as GmailAccountRow) ?? null;
}

// ─── Recipient resolution ────────────────────────────────────────────────

interface EmailTarget {
  partyId:    string;
  email:      string;
  workItemId: string | null;
}

/**
 * `to` is either a raw email address or a lead number ("LEAD-9865"), matching
 * the convenience /twilio/send already offers.
 */
async function resolveToEmail(db: DbExec, to: string): Promise<EmailTarget | null> {
  if (to.includes("@")) {
    const lookup = await matchOrCreatePartyByEmail(db, to);
    return { partyId: lookup.partyId, email: to.toLowerCase(), workItemId: lookup.leadWorkItemId };
  }

  // Lead number → party → their primary email (contact_point first, then the
  // legacy inline party.email column).
  const r = await db.execute(sql`
    SELECT wi.id AS "workItemId", p.id AS "partyId",
           COALESCE(
             (SELECT cp.value FROM contact_point cp
              WHERE cp.party_id = p.id AND cp.kind = 'email' AND cp.valid_to IS NULL
              ORDER BY cp.is_primary DESC
              LIMIT 1),
             p.email
           ) AS email
    FROM work_item wi
    JOIN party p ON p.id = wi.party_id
    WHERE wi.number = ${to.toUpperCase()} AND wi.type = 'lead'
    LIMIT 1
  `);
  const row = r.rows[0] as
    { workItemId: string; partyId: string; email: string | null } | undefined;
  if (!row?.email) return null;
  return { partyId: row.partyId, email: row.email.toLowerCase(), workItemId: row.workItemId };
}

// ─── Attachments ─────────────────────────────────────────────────────────

type LoadResult =
  | { kind: "ok"; files: Attachment[] }
  | { kind: "missing"; assetId: string; files: Attachment[] }
  | { kind: "too-big"; bytes: number; files: Attachment[] };

/**
 * Download the chosen media assets so they can be inlined into the MIME body.
 * Unlike Twilio (which fetches a signed URL from us), Gmail wants the bytes
 * embedded in the message, so we have to pull them ourselves.
 */
async function loadAttachments(db: DbExec, assetIds: string[]): Promise<LoadResult> {
  const files: Attachment[] = [];
  let total = 0;
  for (const assetId of assetIds) {
    const r = await db.execute(sql`
      SELECT filename, content_type AS "contentType", blob_url AS "blobUrl"
      FROM media_asset
      WHERE id = ${assetId} AND deleted_at IS NULL
      LIMIT 1
    `);
    const row = r.rows[0] as
      { filename: string; contentType: string; blobUrl: string } | undefined;
    if (!row) return { kind: "missing", assetId, files };

    const resp = await fetch(row.blobUrl);
    if (!resp.ok) return { kind: "missing", assetId, files };
    const buf = Buffer.from(await resp.arrayBuffer());
    total += buf.byteLength;
    if (total > MAX_ATTACH_BYTES) return { kind: "too-big", bytes: total, files };

    files.push({ filename: row.filename, mimeType: row.contentType, content: buf });
  }
  return { kind: "ok", files };
}
