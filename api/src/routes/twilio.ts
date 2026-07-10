// Twilio messaging API — outbound send + inbox reads.
//
// Mounted at /twilio behind authMiddleware. Each handler enforces its own
// permission gate (messaging.read for reads, messaging.send for sends,
// leads.write for promote-to-lead).
//
// The public inbound webhook lives in routes/twilio-webhook.ts and is
// mounted with a raw-body parser BEFORE the global express.json in
// api/src/index.ts — do NOT move handlers between the two files.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { requirePermission } from "../middleware/require.js";
import { resolveActorPartyId } from "../lib/party/resolve.js";
import {
  readTwilioConfig, sendMessage, TwilioNotConfigured,
} from "../lib/twilio/client.js";
import type { TwChannel } from "../lib/twilio/phone.js";
import { toE164 } from "../lib/twilio/phone.js";
import {
  matchOrCreatePartyByPhone,
  upsertConversation,
  recordOutbound,
  insertActivityForMessage,
} from "../lib/twilio/inbox.js";
import { validateMediaForChannel } from "../lib/twilio/media.js";
import { signMediaFetchUrl } from "./media.js";

// Public API base URL — used to build signed media-fetch URLs Twilio can
// download. Derived from TWILIO_WEBHOOK_URL (already set + validated at
// send time) so we don't need another env var. Example:
//   TWILIO_WEBHOOK_URL=https://api-dev.example.com/webhooks/twilio
//   → API base https://api-dev.example.com
function apiBaseFromWebhook(webhookUrl: string): string {
  try {
    const u = new URL(webhookUrl);
    return `${u.protocol}//${u.host}`;
  } catch { return ""; }
}

export const twilioRouter = Router();

const CHANNELS: TwChannel[] = ["sms", "whatsapp"];

// ─── POST /twilio/send ───────────────────────────────────────────────────
// { channel, to (E.164 OR lead number), body }
//
// Convenience: `to` may be a lead number like "LEAD-9865" — we'll resolve
// it to the lead's party phone. Or a raw E.164 like "+919876543210".

twilioRouter.post("/send", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const body = req.body as { channel?: string; to?: string; body?: string; mediaAssetIds?: string[] };
    const channel = body.channel as TwChannel;
    if (!CHANNELS.includes(channel)) return res.status(400).json({ error: "channel must be 'sms' or 'whatsapp'" });
    const text = String(body.body ?? "").trim();
    const to   = String(body.to ?? "").trim();
    if (!to)   return res.status(400).json({ error: "to is required" });
    const mediaAssetIds = Array.isArray(body.mediaAssetIds) ? body.mediaAssetIds.slice(0, 10) : [];
    // Twilio requires SOMETHING to send — either body or at least one media.
    if (!text && mediaAssetIds.length === 0) {
      return res.status(400).json({ error: "body or mediaAssetIds is required" });
    }

    // Ensure Twilio is configured before we ever touch the DB.
    let cfg;
    try { cfg = readTwilioConfig(); }
    catch (e) {
      if (e instanceof TwilioNotConfigured) return res.status(503).json({ error: e.message });
      throw e;
    }

    const result = await withTenant(req.tenantId!, async (db) => {
      const { partyId, partyPhone, workItemId } = await resolveToParty(db, to);
      if (!partyPhone) return { kind: "no-phone" as const };

      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);

      // Resolve media assets: must be owned by the actor OR in the library.
      // Enforce per-channel caps server-side. Collect blob URLs in order.
      const mediaUrls: string[] = [];
      const mediaMimes: string[] = [];
      if (mediaAssetIds.length) {
        const apiBase = apiBaseFromWebhook(cfg.webhookUrl);
        if (!apiBase) {
          return { kind: "bad-media" as const, reason: "Server misconfigured — TWILIO_WEBHOOK_URL is not a valid URL, can't build media fetch URLs." };
        }
        for (const assetId of mediaAssetIds) {
          const r = await db.execute(sql`
            SELECT id, filename, content_type AS "contentType", size_bytes AS "sizeBytes",
                   blob_url AS "blobUrl", is_library AS "isLibrary",
                   uploaded_by AS "uploadedBy", provider_hosted AS "providerHosted"
            FROM media_asset
            WHERE id = ${assetId} AND deleted_at IS NULL
            LIMIT 1
          `);
          const asset = r.rows[0] as
            | { id: string; contentType: string; sizeBytes: string | number; blobUrl: string;
                isLibrary: boolean; uploadedBy: string | null; providerHosted: boolean }
            | undefined;
          if (!asset) return { kind: "bad-media" as const, reason: `Unknown media asset ${assetId}` };
          if (!asset.isLibrary && asset.uploadedBy !== actorPartyId) {
            return { kind: "bad-media" as const, reason: "You can only attach your own uploads or library assets." };
          }
          const size = typeof asset.sizeBytes === "string" ? Number(asset.sizeBytes) : asset.sizeBytes;
          const check = validateMediaForChannel(channel, asset.contentType, size);
          if (!check.ok) return { kind: "bad-media" as const, reason: check.reason };
          // Signed URL, not raw blob URL — Twilio will download via our
          // proxy, which serves Content-Disposition with the clean filename.
          mediaUrls.push(signMediaFetchUrl(asset.id, apiBase));
          mediaMimes.push(asset.contentType);
        }
      }

      const send = await sendMessage(channel, partyPhone, text, cfg, mediaUrls);

      const conv = await upsertConversation(db, partyId, channel, workItemId == null);
      const msgId = await recordOutbound(db, conv.id, {
        channel,
        fromE164: channel === "whatsapp" ? cfg.waFrom : cfg.smsFrom,
        toE164:   partyPhone,
        body:     text,
        senderUserPartyId: actorPartyId,
        mediaAssetIds,
        send,
      });
      await insertActivityForMessage(db, {
        workItemId,
        partyId,
        actorType:    "user",
        actorPartyId,
        actorName:    req.user?.name ?? "You",
        direction:    "outbound",
        channel,
        body:         text,
        mediaCount:   mediaAssetIds.length,
        mediaMimes,
      });

      return {
        kind: "ok" as const,
        conversationId: conv.id,
        messageId: msgId,
        ok: send.ok,
        providerMessageId: send.providerMessageId,
        errorCode: send.errorCode,
        errorMessage: send.errorMessage,
      };
    });

    if (result.kind === "no-phone") {
      return res.status(400).json({ error: `No phone number for ${to}` });
    }
    if (result.kind === "bad-media") {
      return res.status(400).json({ error: result.reason });
    }
    return res.json(result);
  } catch (err) { next(err); }
});

// ─── GET /twilio/conversations ───────────────────────────────────────────
// Query: ?channel=sms|whatsapp&assignee=me|unassigned|<userId>&q=<text>&limit=100

twilioRouter.get("/conversations", requirePermission("messaging.read"), async (req, res, next) => {
  try {
    const q        = String(req.query.q ?? "").trim();
    const channel  = String(req.query.channel ?? "").trim().toLowerCase();
    const assignee = String(req.query.assignee ?? "").trim();
    const limit    = Math.min(Number(req.query.limit ?? 200), 500);

    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          c.id, c.channel, c.status,
          c.assigned_user_id AS "assignedUserId",
          c.last_message_text AS "lastMessageText",
          c.last_message_at   AS "lastMessageAt",
          c.last_inbound_at   AS "lastInboundAt",
          c.unread_count      AS "unreadCount",
          c.is_unlinked       AS "isUnlinked",
          c.updated_at        AS "updatedAt",
          p.id                AS "partyId",
          p.name              AS "partyName",
          p.phone             AS "partyPhone",
          wi.number           AS "leadNumber"
        FROM tw_conversation c
        JOIN party p ON p.id = c.party_id
        LEFT JOIN LATERAL (
          SELECT number FROM work_item
          WHERE party_id = p.id AND type = 'lead'
          ORDER BY created_at DESC LIMIT 1
        ) wi ON TRUE
        WHERE (${channel} = '' OR c.channel = ${channel})
          AND (${assignee} = '' OR
               (${assignee} = 'unassigned' AND c.assigned_user_id IS NULL) OR
               (${assignee} = 'me' AND c.assigned_user_id IS NOT NULL AND c.assigned_user_id = (
                  SELECT party_id FROM app_user WHERE id = ${req.userId!}
               )) OR
               c.assigned_user_id::text = ${assignee})
          AND (${q} = '' OR p.name ILIKE ${"%" + q + "%"} OR p.phone ILIKE ${"%" + q + "%"} OR c.last_message_text ILIKE ${"%" + q + "%"})
        ORDER BY c.last_message_at DESC NULLS LAST, c.updated_at DESC
        LIMIT ${limit}
      `);
      return r.rows;
    });
    return res.json({ conversations: rows });
  } catch (err) { next(err); }
});

// ─── GET /twilio/conversations/:id ──────────────────────────────────────

twilioRouter.get("/conversations/:id", requirePermission("messaging.read"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const out = await withTenant(req.tenantId!, async (db) => {
      const cR = await db.execute(sql`
        SELECT
          c.id, c.channel, c.status,
          c.assigned_user_id AS "assignedUserId",
          c.last_message_text AS "lastMessageText",
          c.last_message_at   AS "lastMessageAt",
          c.last_inbound_at   AS "lastInboundAt",
          c.unread_count      AS "unreadCount",
          c.is_unlinked       AS "isUnlinked",
          c.created_at        AS "createdAt",
          c.updated_at        AS "updatedAt",
          p.id    AS "partyId",
          p.name  AS "partyName",
          p.phone AS "partyPhone",
          p.email AS "partyEmail",
          p.city  AS "partyCity",
          wi.number AS "leadNumber"
        FROM tw_conversation c
        JOIN party p ON p.id = c.party_id
        LEFT JOIN LATERAL (
          SELECT number FROM work_item
          WHERE party_id = p.id AND type = 'lead'
          ORDER BY created_at DESC LIMIT 1
        ) wi ON TRUE
        WHERE c.id = ${id}
        LIMIT 1
      `);
      const conv = cR.rows[0] as Record<string, unknown> | undefined;
      if (!conv) return null;
      const mR = await db.execute(sql`
        SELECT
          m.id, m.direction, m.channel,
          m.from_number  AS "fromNumber",
          m.to_number    AS "toNumber",
          m.body,
          m.provider_message_id AS "providerMessageId",
          m.status, m.error_code AS "errorCode", m.error_message AS "errorMessage",
          m.sender_user_id AS "senderUserId",
          m.sent_at AS "sentAt", m.delivered_at AS "deliveredAt",
          COALESCE(
            (
              SELECT jsonb_agg(
                       jsonb_build_object(
                         'assetId', a.id,
                         'filename', a.filename,
                         'contentType', a.content_type,
                         'sizeBytes', a.size_bytes,
                         'providerHosted', a.provider_hosted,
                         'ordinal', mm.ordinal
                       )
                       ORDER BY mm.ordinal
                     )
              FROM tw_message_media mm
              JOIN media_asset a ON a.id = mm.asset_id
              WHERE mm.message_id = m.id
            ),
            '[]'::jsonb
          ) AS "media"
        FROM tw_message m
        WHERE m.conversation_id = ${id}
        ORDER BY m.sent_at ASC
        LIMIT 500
      `);
      return { conversation: conv, messages: mR.rows };
    });
    if (!out) return res.status(404).json({ error: "Not found" });
    return res.json(out);
  } catch (err) { next(err); }
});

// ─── POST /twilio/conversations/:id/messages ────────────────────────────
// Send a message within an existing thread. Uses the thread's channel.

twilioRouter.post("/conversations/:id/messages", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const id   = String(req.params.id);
    const text = String((req.body?.body ?? "") as string).trim();
    const mediaAssetIds = Array.isArray(req.body?.mediaAssetIds) ? (req.body.mediaAssetIds as string[]).slice(0, 10) : [];
    if (!text && mediaAssetIds.length === 0) {
      return res.status(400).json({ error: "body or mediaAssetIds is required" });
    }

    let cfg;
    try { cfg = readTwilioConfig(); }
    catch (e) {
      if (e instanceof TwilioNotConfigured) return res.status(503).json({ error: e.message });
      throw e;
    }

    const result = await withTenant(req.tenantId!, async (db) => {
      const cR = await db.execute(sql`
        SELECT
          c.id,
          c.channel,
          c.party_id AS "partyId",
          p.phone_country_code AS "cc",
          p.phone    AS "phone",
          wi.id      AS "workItemId"
        FROM tw_conversation c
        JOIN party p ON p.id = c.party_id
        LEFT JOIN LATERAL (
          SELECT id FROM work_item WHERE party_id = p.id AND type = 'lead'
          ORDER BY created_at DESC LIMIT 1
        ) wi ON TRUE
        WHERE c.id = ${id}
        LIMIT 1
      `);
      const row = cR.rows[0] as
        | { id: string; channel: TwChannel; partyId: string; cc: string | null; phone: string | null; workItemId: string | null }
        | undefined;
      if (!row) return { kind: "not-found" as const };
      const partyPhone = composePartyPhone(row.cc, row.phone);
      if (!partyPhone) return { kind: "no-phone" as const };
      const conv = { ...row, partyPhone };

      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);

      // Resolve media (same rules as /send): must be owned by actor or in library.
      const mediaUrls: string[] = [];
      const mediaMimes: string[] = [];
      if (mediaAssetIds.length) {
        const apiBase = apiBaseFromWebhook(cfg.webhookUrl);
        if (!apiBase) {
          return { kind: "bad-media" as const, reason: "Server misconfigured — TWILIO_WEBHOOK_URL is not a valid URL, can't build media fetch URLs." };
        }
        for (const assetId of mediaAssetIds) {
          const r = await db.execute(sql`
            SELECT id, content_type AS "contentType", size_bytes AS "sizeBytes",
                   blob_url AS "blobUrl", is_library AS "isLibrary",
                   uploaded_by AS "uploadedBy"
            FROM media_asset WHERE id = ${assetId} AND deleted_at IS NULL LIMIT 1
          `);
          const asset = r.rows[0] as
            | { id: string; contentType: string; sizeBytes: string | number; blobUrl: string; isLibrary: boolean; uploadedBy: string | null }
            | undefined;
          if (!asset) return { kind: "bad-media" as const, reason: `Unknown media asset ${assetId}` };
          if (!asset.isLibrary && asset.uploadedBy !== actorPartyId) {
            return { kind: "bad-media" as const, reason: "You can only attach your own uploads or library assets." };
          }
          const size = typeof asset.sizeBytes === "string" ? Number(asset.sizeBytes) : asset.sizeBytes;
          const check = validateMediaForChannel(conv.channel, asset.contentType, size);
          if (!check.ok) return { kind: "bad-media" as const, reason: check.reason };
          mediaUrls.push(signMediaFetchUrl(asset.id, apiBase));
          mediaMimes.push(asset.contentType);
        }
      }

      const send = await sendMessage(conv.channel, conv.partyPhone, text, cfg, mediaUrls);
      const msgId = await recordOutbound(db, conv.id, {
        channel: conv.channel,
        fromE164: conv.channel === "whatsapp" ? cfg.waFrom : cfg.smsFrom,
        toE164:   conv.partyPhone,
        body:     text,
        senderUserPartyId: actorPartyId,
        mediaAssetIds,
        send,
      });
      await insertActivityForMessage(db, {
        workItemId: conv.workItemId,
        partyId:    conv.partyId,
        actorType:  "user",
        actorPartyId,
        actorName:  req.user?.name ?? "You",
        direction:  "outbound",
        channel:    conv.channel,
        body:       text,
        mediaCount: mediaAssetIds.length,
        mediaMimes,
      });

      return {
        kind: "ok" as const,
        messageId: msgId,
        ok: send.ok,
        providerMessageId: send.providerMessageId,
        errorCode: send.errorCode,
        errorMessage: send.errorMessage,
      };
    });

    if (result.kind === "not-found") return res.status(404).json({ error: "Conversation not found" });
    if (result.kind === "no-phone")  return res.status(400).json({ error: "This contact has no phone number" });
    if (result.kind === "bad-media") return res.status(400).json({ error: result.reason });
    return res.json(result);
  } catch (err) { next(err); }
});

// ─── POST /twilio/conversations/:id/read ────────────────────────────────

twilioRouter.post("/conversations/:id/read", requirePermission("messaging.read"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    await withTenant(req.tenantId!, async (db) => {
      await db.execute(sql`UPDATE tw_conversation SET unread_count = 0, updated_at = now() WHERE id = ${id}`);
    });
    return res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── POST /twilio/conversations/:id/assign ──────────────────────────────

twilioRouter.post("/conversations/:id/assign", requirePermission("messaging.read"), async (req, res, next) => {
  try {
    const id     = String(req.params.id);
    const userId = req.body?.userId ? String(req.body.userId) : null;
    const out = await withTenant(req.tenantId!, async (db) => {
      // userId is an app_user.id — resolve to party_id for the assignment column
      let partyId: string | null = null;
      if (userId) {
        const r = await db.execute(sql`SELECT party_id AS "partyId" FROM app_user WHERE id = ${userId} LIMIT 1`);
        const row = r.rows[0] as { partyId: string | null } | undefined;
        if (!row) return { kind: "user-not-found" as const };
        partyId = row.partyId;
      }
      await db.execute(sql`
        UPDATE tw_conversation SET assigned_user_id = ${partyId}, updated_at = now() WHERE id = ${id}
      `);
      return { kind: "ok" as const };
    });
    if (out.kind === "user-not-found") return res.status(404).json({ error: "User not found" });
    return res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── POST /twilio/conversations/:id/promote-to-lead ─────────────────────
// Create a work_item(type='lead') + lead row for a conversation whose
// party has no lead yet. Perm: leads.write (this is a real record creation).

twilioRouter.post("/conversations/:id/promote-to-lead", requirePermission("leads.write"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const out = await withTenant(req.tenantId!, async (db) => {
      const cR = await db.execute(sql`
        SELECT c.id, c.party_id AS "partyId", p.name, p.phone
        FROM tw_conversation c JOIN party p ON p.id = c.party_id
        WHERE c.id = ${id}
      `);
      const conv = cR.rows[0] as { id: string; partyId: string; name: string; phone: string | null } | undefined;
      if (!conv) return { kind: "not-found" as const };

      const existing = await db.execute(sql`
        SELECT number FROM work_item WHERE party_id = ${conv.partyId} AND type = 'lead' ORDER BY created_at DESC LIMIT 1
      `);
      const already = existing.rows[0] as { number: string } | undefined;
      if (already) {
        await db.execute(sql`UPDATE tw_conversation SET is_unlinked = false, updated_at = now() WHERE id = ${id}`);
        return { kind: "ok" as const, number: already.number, alreadyLead: true };
      }

      const numR = await db.execute(sql`SELECT nextval('seq_lead')::text AS n`);
      const number = `LEAD-${(numR.rows[0] as { n: string }).n}`;
      const wiR = await db.execute(sql`
        INSERT INTO work_item (tenant_id, number, type, party_id, state, priority, attributes)
        VALUES (current_tenant(), ${number}, 'lead', ${conv.partyId}, 'open', 3,
                ${JSON.stringify({ source: "inbound_message", sourceLabel: "Inbound message" })}::jsonb)
        RETURNING id
      `);
      const wiId = (wiR.rows[0] as { id: string }).id;
      await db.execute(sql`
        INSERT INTO lead (
          work_item_id, tenant_id, source, source_label, score, rating, stage, stage_label,
          heat, avatar, initials, description, nba_label, nba_icon
        )
        VALUES (
          ${wiId}, current_tenant(), 'inbound_message', 'Inbound message', 50, 'new lead',
          'new', 'New inbound', 'warm', 'blue', ${initialsOf(conv.name)},
          'Promoted from inbox', 'Reach out today', 'send'
        )
      `);
      await db.execute(sql`
        INSERT INTO party_role (tenant_id, party_id, role, valid_from)
        VALUES (current_tenant(), ${conv.partyId}, 'lead', current_date)
        ON CONFLICT (party_id, role, valid_from) DO NOTHING
      `);
      await db.execute(sql`UPDATE tw_conversation SET is_unlinked = false, updated_at = now() WHERE id = ${id}`);
      return { kind: "ok" as const, number, alreadyLead: false };
    });

    if (out.kind === "not-found") return res.status(404).json({ error: "Conversation not found" });
    return res.json(out);
  } catch (err) { next(err); }
});

// ─── helpers ─────────────────────────────────────────────────────────────

// Resolve `to` (either a raw E.164 like "+919..." or a lead number like
// "LEAD-9865") to a party + optional lead work_item.
//
// Discriminator: lead numbers contain letters (LEAD-XXXX / CASE-XXXX shape),
// phones are digits with an optional leading '+'. Do NOT rely on
// startsWith('+') after normalization — toE164() prepends '+' to whatever
// digits it finds, so "LEAD-9864" would look like a phone "+9864".
async function resolveToParty(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  to: string,
): Promise<{ partyId: string; partyPhone: string | null; workItemId: string | null }> {
  const trimmed = to.trim();
  const looksLikePhone = /^\+?\d[\d\s\-()]*$/.test(trimmed);
  if (looksLikePhone) {
    const asPhone = toE164(trimmed);
    if (!asPhone || asPhone.length < 8) {
      throw new Error(`Invalid phone number: ${to}`);
    }
    const lookup = await matchOrCreatePartyByPhone(db, asPhone);
    return {
      partyId: lookup.partyId,
      partyPhone: asPhone,
      workItemId: lookup.leadWorkItemId,
    };
  }
  // lead number → look up the party's phone. The CRM splits phone into
  // (phone_country_code, phone) — e.g. ('+91', '9963039919'). We must
  // concatenate before sending to Twilio, otherwise the bare local number
  // becomes an unroutable "+9963039919".
  const r = await db.execute(sql`
    SELECT
      wi.id       AS "workItemId",
      wi.party_id AS "partyId",
      p.phone_country_code AS "cc",
      p.phone     AS "phone"
    FROM work_item wi JOIN party p ON p.id = wi.party_id
    WHERE wi.number = ${trimmed} AND wi.type = 'lead'
    LIMIT 1
  `);
  const row = r.rows[0] as {
    workItemId: string; partyId: string; cc: string | null; phone: string | null
  } | undefined;
  if (!row) throw new Error(`Unknown lead number or invalid phone: ${to}`);
  return {
    workItemId: row.workItemId,
    partyId:    row.partyId,
    partyPhone: composePartyPhone(row.cc, row.phone),
  };
}

/**
 * Combine (phone_country_code, phone) into E.164. Handles the pre-Phase-3
 * legacy state where `phone` might already include the country code (some
 * imported rows have "+919963039919" in the phone column and null cc).
 */
function composePartyPhone(cc: string | null, phone: string | null): string | null {
  const rawPhone = (phone ?? "").trim();
  if (!rawPhone) return null;
  // If the phone already starts with '+' and has more than 10 digits, assume
  // it's fully formatted E.164 and leave it alone.
  const phoneDigits = rawPhone.replace(/\D/g, "");
  if (rawPhone.startsWith("+") && phoneDigits.length > 10) {
    return `+${phoneDigits}`;
  }
  const ccDigits = (cc ?? "").replace(/\D/g, "");
  if (ccDigits) return `+${ccDigits}${phoneDigits}`;
  // No country code stored — fall back to bare number with '+'. Twilio will
  // reject it downstream, which surfaces as a clear "invalid To number" error
  // instead of a silent failure.
  return `+${phoneDigits}`;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0]![0]! + (parts[1]?.[0] ?? "")).toUpperCase();
}
