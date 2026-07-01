/**
 * WhatsApp routes — Phase 1: connection config only.
 *
 * Mounted at /whatsapp; every handler requires auth. Permission gates
 * are applied per-handler so a regular advisor can't change credentials.
 *
 * Phase 2 adds /conversations + /messages; Phase 3 adds /templates and
 * /broadcasts; Phase 4 adds /automations.
 */

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { requirePermission } from "../middleware/require.js";
import {
  listTemplates, readMetaCreds, registerPhoneNumber, renderTemplateBody,
  sendTemplate, sendText, subscribeWaba, verifyPhoneNumber,
  type MetaCreds,
} from "../lib/whatsapp/meta.js";
import { recordOutbound } from "../lib/whatsapp/inbox.js";
import { partyIdFromAppUserId } from "../lib/party/resolve.js";
import { filterConsentedRecipients } from "../lib/party/consent.js";

export const whatsappRouter = Router();

const REQUIRED_FIELDS = [
  "phone_number_id", "waba_id", "app_id", "app_secret",
  "system_user_token", "webhook_verify_token",
] as const;

// Mask creds when returning config — never echo full secrets back.
function maskCreds(c: MetaCreds): Record<string, string> {
  const tail = (s: string) => (s.length <= 4 ? "****" : `…${s.slice(-4)}`);
  return {
    phone_number_id:      c.phone_number_id,
    waba_id:              c.waba_id,
    app_id:               c.app_id,
    app_secret:           tail(c.app_secret),
    system_user_token:    tail(c.system_user_token),
    webhook_verify_token: tail(c.webhook_verify_token),
  };
}

// ─── GET /whatsapp/config ────────────────────────────────────────────────

whatsappRouter.get("/config", requirePermission("whatsapp.read"), async (req, res, next) => {
  try {
    const out = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          id, phone_number_id, waba_id, app_id, app_secret,
          system_user_token, webhook_verify_token,
          display_phone_number AS "displayPhoneNumber",
          verified_name AS "verifiedName",
          quality_rating AS "qualityRating",
          status,
          connected_at  AS "connectedAt",
          registered_at AS "registeredAt",
          subscribed_at AS "subscribedAt",
          created_at    AS "createdAt",
          updated_at    AS "updatedAt"
        FROM wa_config
        LIMIT 1
      `);
      return r.rows[0] as Record<string, unknown> | undefined;
    });

    if (!out) {
      return res.json({
        configured: false,
        status: "disconnected",
        connectedAt: null, registeredAt: null, subscribedAt: null,
        credentials: null,
        displayPhoneNumber: null, verifiedName: null, qualityRating: null,
      });
    }
    const creds = readMetaCreds(out);
    res.json({
      configured: !!creds,
      status: out.status,
      connectedAt:  out.connectedAt,
      registeredAt: out.registeredAt,
      subscribedAt: out.subscribedAt,
      credentials: creds ? maskCreds(creds) : null,
      displayPhoneNumber: out.displayPhoneNumber ?? null,
      verifiedName:       out.verifiedName ?? null,
      qualityRating:      out.qualityRating ?? null,
    });
  } catch (err) { next(err); }
});

// ─── POST /whatsapp/config (upsert credentials) ─────────────────────────
//
// Body:
//   { credentials: { phone_number_id, waba_id, app_id, app_secret,
//                    system_user_token, webhook_verify_token } }
//
// On save we immediately call verifyPhoneNumber against Meta. If that
// succeeds we record the resulting display_phone_number / verified_name /
// quality_rating columns and flip status='connected'. If it fails we
// still save the credentials (so the user can correct them) but leave
// status='disconnected' and surface the Meta error in the response.
//
// /register and /subscribe live on separate endpoints below — they need
// extra inputs (the 2FA PIN) and we don't want a single Save button to
// silently do all three.

whatsappRouter.post("/config", requirePermission("whatsapp.manage"), async (req, res, next) => {
  try {
    const credsRaw = (req.body?.credentials && typeof req.body.credentials === "object")
      ? req.body.credentials as Record<string, unknown>
      : null;
    if (!credsRaw) return res.status(400).json({ error: "credentials object is required" });

    // Validate every field is a non-empty string.
    const cleaned: Record<string, string> = {};
    for (const k of REQUIRED_FIELDS) {
      const v = credsRaw[k];
      if (typeof v !== "string" || !v.trim()) {
        return res.status(400).json({ error: `credentials.${k} is required` });
      }
      cleaned[k] = v.trim();
    }
    if (/\s/.test(cleaned.webhook_verify_token!)) {
      return res.status(400).json({ error: "webhook_verify_token must not contain whitespace" });
    }

    // Verify against Meta before persisting status='connected'. We still
    // save creds even on verify failure so the user can edit and retry.
    const verify = await verifyPhoneNumber({
      phoneNumberId: cleaned.phone_number_id!,
      accessToken: cleaned.system_user_token!,
    });

    const newStatus = verify.ok ? "connected" : "disconnected";
    const display    = verify.data?.display_phone_number ?? null;
    const verified   = verify.data?.verified_name ?? null;
    const quality    = verify.data?.quality_rating ?? null;

    await withTenant(req.tenantId!, async (db) => {
      await db.execute(sql`
        INSERT INTO wa_config (
          tenant_id, phone_number_id, waba_id, app_id, app_secret,
          system_user_token, webhook_verify_token,
          display_phone_number, verified_name, quality_rating,
          status, connected_at
        )
        VALUES (
          current_tenant(),
          ${cleaned.phone_number_id}, ${cleaned.waba_id}, ${cleaned.app_id}, ${cleaned.app_secret},
          ${cleaned.system_user_token}, ${cleaned.webhook_verify_token},
          ${display}, ${verified}, ${quality},
          ${newStatus},
          ${verify.ok ? sql`NOW()` : sql`NULL`}
        )
        ON CONFLICT (tenant_id) DO UPDATE
        SET phone_number_id      = EXCLUDED.phone_number_id,
            waba_id              = EXCLUDED.waba_id,
            app_id               = EXCLUDED.app_id,
            app_secret           = EXCLUDED.app_secret,
            system_user_token    = EXCLUDED.system_user_token,
            webhook_verify_token = EXCLUDED.webhook_verify_token,
            display_phone_number = EXCLUDED.display_phone_number,
            verified_name        = EXCLUDED.verified_name,
            quality_rating       = EXCLUDED.quality_rating,
            status               = EXCLUDED.status,
            connected_at         = COALESCE(EXCLUDED.connected_at, wa_config.connected_at),
            -- Reset register/subscribe state on credential change. The user
            -- has to redo those calls because the new creds may be a different
            -- phone number / WABA entirely.
            registered_at        = NULL,
            subscribed_at        = NULL
      `);
    });

    res.json({
      ok: verify.ok,
      status: newStatus,
      verify: {
        ok: verify.ok,
        httpStatus: verify.httpStatus,
        data: verify.data,
        error: verify.error,
      },
    });
  } catch (err) { next(err); }
});

// ─── DELETE /whatsapp/config ─────────────────────────────────────────────

whatsappRouter.delete("/config", requirePermission("whatsapp.manage"), async (req, res, next) => {
  try {
    await withTenant(req.tenantId!, async (db) => {
      await db.execute(sql`DELETE FROM wa_config`);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── POST /whatsapp/config/verify ────────────────────────────────────────
//
// Re-runs the GET /{phone_number_id} health check using the saved token.
// Used by the "Test connection" button. Doesn't write status — only
// surfaces the result. (Save flow above writes status; we want this
// button to never lie about persisted state.)

whatsappRouter.post("/config/verify", requirePermission("whatsapp.manage"), async (req, res, next) => {
  try {
    const out = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT phone_number_id, system_user_token FROM wa_config LIMIT 1
      `);
      return r.rows[0] as { phone_number_id?: string; system_user_token?: string } | undefined;
    });
    if (!out?.phone_number_id || !out?.system_user_token) {
      return res.status(409).json({ error: "WhatsApp is not configured." });
    }
    const r = await verifyPhoneNumber({
      phoneNumberId: out.phone_number_id,
      accessToken:   out.system_user_token,
    });
    // Keep wa_config display fields in sync if Meta returned new info.
    if (r.ok && r.data) {
      const display  = r.data.display_phone_number ?? null;
      const verified = r.data.verified_name ?? null;
      const quality  = r.data.quality_rating ?? null;
      await withTenant(req.tenantId!, async (db) => {
        await db.execute(sql`
          UPDATE wa_config
            SET display_phone_number = ${display},
                verified_name        = ${verified},
                quality_rating       = ${quality},
                status               = 'connected',
                connected_at         = COALESCE(connected_at, NOW())
        `);
      });
    }
    res.json(r);
  } catch (err) { next(err); }
});

// ─── POST /whatsapp/config/register ──────────────────────────────────────
//
// Body: { pin: "123456" }
// Calls POST /{phone_number_id}/register with the saved access token.
// Without this, inbound webhooks may silently route to whichever app
// last claimed the number. Idempotent on Meta's side — calling again
// after success is harmless.

whatsappRouter.post("/config/register", requirePermission("whatsapp.manage"), async (req, res, next) => {
  try {
    const pin = String(req.body?.pin ?? "").trim();
    if (!/^\d{6}$/.test(pin)) {
      return res.status(400).json({ error: "pin must be 6 digits (set in Meta WhatsApp Manager → Two-step verification)" });
    }
    const out = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT phone_number_id, system_user_token FROM wa_config LIMIT 1
      `);
      return r.rows[0] as { phone_number_id?: string; system_user_token?: string } | undefined;
    });
    if (!out?.phone_number_id || !out?.system_user_token) {
      return res.status(409).json({ error: "WhatsApp is not configured. Save credentials first." });
    }
    const r = await registerPhoneNumber({
      phoneNumberId: out.phone_number_id,
      accessToken:   out.system_user_token,
      pin,
    });
    // Meta's newer SMB onboarding flow auto-registers the number when it's
    // added to the WABA — the /register endpoint returns "Register endpoint
    // is not available for SMB businesses." for these accounts. Treat that
    // as success since the number is already effectively registered.
    const smbAutoRegistered = !r.ok && /not available for SMB/i.test(r.error ?? "");
    if (r.ok || smbAutoRegistered) {
      await withTenant(req.tenantId!, async (db) => {
        await db.execute(sql`UPDATE wa_config SET registered_at = NOW()`);
      });
      if (smbAutoRegistered) {
        return res.json({
          ok: true,
          httpStatus: r.httpStatus,
          smbAutoRegistered: true,
          info: "SMB account — number is auto-registered when added to the WABA. No manual /register needed.",
        });
      }
    }
    res.json(r);
  } catch (err) { next(err); }
});

// ─── POST /whatsapp/config/subscribe ─────────────────────────────────────
//
// POST /{waba_id}/subscribed_apps. Idempotent. Required exactly once per
// WABA but cheap to call on every save / re-config.

whatsappRouter.post("/config/subscribe", requirePermission("whatsapp.manage"), async (req, res, next) => {
  try {
    const out = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT waba_id, system_user_token FROM wa_config LIMIT 1
      `);
      return r.rows[0] as { waba_id?: string; system_user_token?: string } | undefined;
    });
    if (!out?.waba_id || !out?.system_user_token) {
      return res.status(409).json({ error: "WhatsApp is not configured. Save credentials first." });
    }
    const r = await subscribeWaba({
      wabaId:      out.waba_id,
      accessToken: out.system_user_token,
    });
    if (r.ok) {
      await withTenant(req.tenantId!, async (db) => {
        await db.execute(sql`UPDATE wa_config SET subscribed_at = NOW()`);
      });
    }
    res.json(r);
  } catch (err) { next(err); }
});

// ─── Conversations: list ─────────────────────────────────────────────────
//
// Inbox query. Filters:
//   ?status=open|pending|closed   (default: open)
//   ?assignee=me|unassigned|<userId>
//   ?q=<search>                   (matches party.name, phone, last_message_text)
//   ?limit=<n>                    (default 50, max 200)

whatsappRouter.get("/conversations", requirePermission("whatsapp.read"), async (req, res, next) => {
  try {
    const status   = typeof req.query.status   === "string" ? req.query.status : "open";
    const assignee = typeof req.query.assignee === "string" ? req.query.assignee : "";
    const q        = typeof req.query.q        === "string" ? req.query.q.trim() : "";
    const limit    = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);

    if (status !== "all" && !["open", "pending", "closed"].includes(status)) {
      return res.status(400).json({ error: "invalid status" });
    }

    const rows = await withTenant(req.tenantId!, async (db) => {
      const conditions: ReturnType<typeof sql>[] = [];
      if (status !== "all") conditions.push(sql`c.status = ${status}`);
      // Phase 2: c.assigned_user_id stores party.id; resolve app_user.id → party.id.
      if (assignee === "me") {
        const mePartyId = await partyIdFromAppUserId(db, req.userId!);
        conditions.push(sql`c.assigned_user_id = ${mePartyId}`);
      } else if (assignee === "unassigned") {
        conditions.push(sql`c.assigned_user_id IS NULL`);
      } else if (assignee && /^[0-9a-fA-F-]{36}$/.test(assignee)) {
        const partyId = await partyIdFromAppUserId(db, assignee);
        conditions.push(sql`c.assigned_user_id = ${partyId}`);
      }
      if (q) {
        const like = `%${q}%`;
        conditions.push(sql`(p.name ILIKE ${like} OR p.phone ILIKE ${like} OR c.last_message_text ILIKE ${like})`);
      }
      const where = conditions.length ? sql` WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

      const r = await db.execute(sql`
        SELECT
          c.id, c.party_id AS "partyId", c.status,
          u.id               AS "assignedUserId",  -- app_user.id via party_id (Phase 2)
          u.name AS "assignedUserName",
          c.last_message_text  AS "lastMessageText",
          c.last_message_at    AS "lastMessageAt",
          c.last_inbound_at    AS "lastInboundAt",
          c.unread_count       AS "unreadCount",
          c.labels,
          c.updated_at         AS "updatedAt",
          p.name  AS "partyName",
          p.phone AS "partyPhone",
          p.phone_country_code AS "partyPhoneCc",
          -- if this party has a current lead role, surface its number for deep-link
          (
            SELECT wi.number FROM work_item wi
            WHERE wi.party_id = p.id AND wi.type = 'lead'
            ORDER BY wi.created_at DESC LIMIT 1
          ) AS "leadNumber",
          -- learner deep-link uses partyId directly, but expose the role
          EXISTS (
            SELECT 1 FROM party_role pr
            WHERE pr.party_id = p.id AND pr.role = 'learner' AND pr.valid_to IS NULL
          ) AS "isLearner"
        FROM wa_conversation c
        JOIN party p ON p.id = c.party_id
        LEFT JOIN app_user u ON u.party_id = c.assigned_user_id
        ${where}
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT ${limit}
      `);
      return r.rows;
    });

    res.json({ conversations: rows });
  } catch (err) { next(err); }
});

// ─── Conversations: detail (with last 50 messages + tags) ────────────────

whatsappRouter.get("/conversations/:id", requirePermission("whatsapp.read"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "invalid id" });

    const data = await withTenant(req.tenantId!, async (db) => {
      const convR = await db.execute(sql`
        SELECT
          c.id, c.party_id AS "partyId", c.status,
          u.id               AS "assignedUserId",  -- app_user.id via party_id (Phase 2)
          u.name AS "assignedUserName",
          c.last_message_at AS "lastMessageAt",
          c.last_inbound_at AS "lastInboundAt",
          c.unread_count    AS "unreadCount",
          c.labels,
          c.created_at AS "createdAt",
          c.updated_at AS "updatedAt",
          p.id    AS "partyIdAgain",
          p.name  AS "partyName",
          p.email AS "partyEmail",
          p.phone AS "partyPhone",
          p.phone_country_code AS "partyPhoneCc",
          p.city  AS "partyCity",
          (
            SELECT wi.number FROM work_item wi
            WHERE wi.party_id = p.id AND wi.type = 'lead'
            ORDER BY wi.created_at DESC LIMIT 1
          ) AS "leadNumber",
          EXISTS (
            SELECT 1 FROM party_role pr
            WHERE pr.party_id = p.id AND pr.role = 'learner' AND pr.valid_to IS NULL
          ) AS "isLearner"
        FROM wa_conversation c
        JOIN party p ON p.id = c.party_id
        LEFT JOIN app_user u ON u.party_id = c.assigned_user_id
        WHERE c.id = ${id}
        LIMIT 1
      `);
      const conv = convR.rows[0] as Record<string, unknown> | undefined;
      if (!conv) return null;

      const msgsR = await db.execute(sql`
        SELECT
          id, direction, sender_type AS "senderType",
          (SELECT au.id FROM app_user au WHERE au.party_id = sender_user_id LIMIT 1) AS "senderUserId", -- Phase 2: app_user.id via party

          content_type AS "contentType", body, media_url AS "mediaUrl", media_mime AS "mediaMime",
          template_name AS "templateName", template_variables AS "templateVariables",
          provider_message_id AS "providerMessageId",
          status, error_code AS "errorCode", error_message AS "errorMessage",
          in_reply_to_provider_id AS "inReplyToProviderId",
          sent_at AS "sentAt", delivered_at AS "deliveredAt", read_at AS "readAt"
        FROM wa_message
        WHERE conversation_id = ${id}
        ORDER BY sent_at DESC
        LIMIT 50
      `);
      // Reverse so the UI shows oldest-first.
      const messages = msgsR.rows.slice().reverse();

      const tagsR = await db.execute(sql`
        SELECT t.id, t.name, t.color
        FROM wa_party_tag pt
        JOIN wa_tag t ON t.id = pt.tag_id
        WHERE pt.party_id = ${conv.partyId as string}
        ORDER BY lower(t.name)
      `);

      return { conversation: conv, messages, tags: tagsR.rows };
    });

    if (!data) return res.status(404).json({ error: "Conversation not found" });
    res.json(data);
  } catch (err) { next(err); }
});

// ─── Conversations: assign ───────────────────────────────────────────────

whatsappRouter.post("/conversations/:id/assign", requirePermission("whatsapp.send"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "invalid id" });
    const userIdRaw = req.body?.userId;
    const userId =
      userIdRaw === null || userIdRaw === ""
        ? null
        : (typeof userIdRaw === "string" && /^[0-9a-fA-F-]{36}$/.test(userIdRaw) ? userIdRaw : undefined);
    if (userId === undefined) {
      return res.status(400).json({ error: "userId must be a UUID or null" });
    }

    await withTenant(req.tenantId!, async (db) => {
      // Phase 2: assigned_user_id stores party.id; resolve.
      const partyId = userId ? await partyIdFromAppUserId(db, userId) : null;
      await db.execute(sql`
        UPDATE wa_conversation SET assigned_user_id = ${partyId} WHERE id = ${id}
      `);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Conversations: status ───────────────────────────────────────────────

whatsappRouter.post("/conversations/:id/status", requirePermission("whatsapp.send"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "invalid id" });
    const status = String(req.body?.status ?? "");
    if (!["open", "pending", "closed"].includes(status)) {
      return res.status(400).json({ error: "status must be open|pending|closed" });
    }
    await withTenant(req.tenantId!, async (db) => {
      await db.execute(sql`UPDATE wa_conversation SET status = ${status} WHERE id = ${id}`);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Conversations: mark-read ────────────────────────────────────────────

whatsappRouter.post("/conversations/:id/read", requirePermission("whatsapp.read"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "invalid id" });
    await withTenant(req.tenantId!, async (db) => {
      await db.execute(sql`UPDATE wa_conversation SET unread_count = 0 WHERE id = ${id}`);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Conversations: send message ─────────────────────────────────────────
//
// Body — exactly one of:
//   { body: "text..." }                         text reply (24h window only)
//   { templateId: "uuid", variables?: {...} }   template send (any time)
//
// Server-side enforces:
//   - text path requires last_inbound_at within 24h (Meta will reject otherwise,
//     but we want a clean 422 with a clear message instead of a Meta error
//     bubbling up).
//   - template path requires the template's status='approved'.

whatsappRouter.post("/conversations/:id/messages", requirePermission("whatsapp.send"), async (req, res, next) => {
  try {
    const conversationId = String(req.params.id ?? "");
    if (!/^[0-9a-fA-F-]{36}$/.test(conversationId)) return res.status(400).json({ error: "invalid id" });

    const b = req.body ?? {};
    const body       = typeof b.body === "string" ? b.body : null;
    const templateId = typeof b.templateId === "string" ? b.templateId : null;
    const variables  = b.variables && typeof b.variables === "object" ? b.variables as Record<string, string> : {};

    if (!body && !templateId) {
      return res.status(400).json({ error: "Either body (text) or templateId is required." });
    }
    if (body && templateId) {
      return res.status(400).json({ error: "Pick one of body or templateId, not both." });
    }

    const result = await withTenant(req.tenantId!, async (db) => {
      // Load creds + conversation context in one shot.
      const ctxR = await db.execute(sql`
        SELECT
          c.id AS "conversationId", c.party_id AS "partyId",
          c.last_inbound_at AS "lastInboundAt",
          p.phone AS "partyPhone",
          p.phone_country_code AS "partyPhoneCc",
          cfg.phone_number_id, cfg.waba_id, cfg.app_id, cfg.app_secret,
          cfg.system_user_token, cfg.webhook_verify_token,
          cfg.status AS "configStatus"
        FROM wa_conversation c
        JOIN party p ON p.id = c.party_id
        LEFT JOIN wa_config cfg ON cfg.tenant_id = c.tenant_id
        WHERE c.id = ${conversationId}
        LIMIT 1
      `);
      const ctx = ctxR.rows[0] as
        | {
            conversationId: string; partyId: string;
            lastInboundAt: string | null;
            partyPhone: string | null;
            partyPhoneCc: string | null;
            phone_number_id: string | null;
            waba_id: string | null;
            app_id: string | null;
            app_secret: string | null;
            system_user_token: string | null;
            webhook_verify_token: string | null;
            configStatus: string;
          }
        | undefined;
      if (!ctx) return { kind: "not-found" as const };
      const creds = readMetaCreds(ctx);
      if (!creds || ctx.configStatus !== "connected") {
        return { kind: "not-configured" as const };
      }
      const to =
        (ctx.partyPhoneCc ?? "").replace(/\D/g, "") +
        (ctx.partyPhone ?? "").replace(/\D/g, "");
      if (!to) return { kind: "no-phone" as const };

      // ── Text path
      if (body) {
        const last = ctx.lastInboundAt ? new Date(ctx.lastInboundAt) : null;
        const within24h = last ? Date.now() - last.getTime() < 24 * 60 * 60 * 1000 : false;
        if (!within24h) {
          return { kind: "out-of-window" as const };
        }
        const send = await sendText({ creds, to, body });
        const msgId = await recordOutbound(db, {
          conversationId,
          senderUserId: req.userId ?? null,
          contentType: "text",
          body,
          providerMessageId: send.messageId ?? null,
          status: send.ok ? "sent" : "failed",
          httpStatus: send.httpStatus,
          errorCode:    send.errorCode ?? null,
          errorMessage: send.error ?? null,
        });
        return { kind: "ok" as const, messageId: msgId, send };
      }

      // ── Template path
      const tplR = await db.execute(sql`
        SELECT id, template_name AS "templateName", language, status, body_text AS "bodyText", variable_count AS "variableCount"
        FROM wa_template
        WHERE id = ${templateId}
      `);
      const tpl = tplR.rows[0] as
        | { templateName: string; language: string; status: string; bodyText: string; variableCount: number }
        | undefined;
      if (!tpl) return { kind: "template-missing" as const };
      if (tpl.status !== "approved") {
        return { kind: "template-not-approved" as const, status: tpl.status };
      }

      const variableArr: string[] = [];
      for (let i = 1; i <= tpl.variableCount; i++) {
        const v = variables[String(i)];
        variableArr.push(typeof v === "string" ? v : "");
      }
      const rendered = renderTemplateBody(tpl.bodyText, variableArr);

      const send = await sendTemplate({
        creds, to,
        templateName: tpl.templateName,
        language:     tpl.language,
        variables:    variableArr,
      });
      const msgId = await recordOutbound(db, {
        conversationId,
        senderUserId: req.userId ?? null,
        contentType: "template",
        body: rendered,
        templateName: tpl.templateName,
        templateVariables: variableArr.length > 0
          ? Object.fromEntries(variableArr.map((v, i) => [String(i + 1), v]))
          : null,
        providerMessageId: send.messageId ?? null,
        status: send.ok ? "sent" : "failed",
        httpStatus: send.httpStatus,
        errorCode:    send.errorCode ?? null,
        errorMessage: send.error ?? null,
      });
      return { kind: "ok" as const, messageId: msgId, send };
    });

    if (result.kind === "not-found")            return res.status(404).json({ error: "Conversation not found" });
    if (result.kind === "not-configured")       return res.status(409).json({ error: "WhatsApp is not configured for this tenant." });
    if (result.kind === "no-phone")             return res.status(409).json({ error: "Conversation party has no phone number." });
    if (result.kind === "out-of-window")        return res.status(422).json({ error: "Outside the 24-hour service window. Send a template instead." });
    if (result.kind === "template-missing")     return res.status(404).json({ error: "Template not found." });
    if (result.kind === "template-not-approved") return res.status(422).json({ error: `Template is ${result.status} — only approved templates can be sent.` });

    if (!result.send.ok) {
      return res.status(502).json({
        error: result.send.error ?? "Send failed.",
        messageId: result.messageId,
        httpStatus: result.send.httpStatus,
      });
    }
    res.json({ ok: true, messageId: result.messageId, providerMessageId: result.send.messageId });
  } catch (err) { next(err); }
});

// ─── Conversations: promote-to-lead ──────────────────────────────────────
// If the party currently has no lead role (and no learner role, since
// learner is downstream), insert one. Returns the LEAD-#### number for
// the UI to deep-link.

whatsappRouter.post("/conversations/:id/promote-to-lead", requirePermission("whatsapp.send"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "invalid id" });

    const result = await withTenant(req.tenantId!, async (db) => {
      const cR = await db.execute(sql`
        SELECT c.party_id AS "partyId", p.name FROM wa_conversation c
        JOIN party p ON p.id = c.party_id
        WHERE c.id = ${id} LIMIT 1
      `);
      const c = cR.rows[0] as { partyId: string; name: string } | undefined;
      if (!c) return { kind: "not-found" as const };

      // Already a lead? Return the existing number.
      const existR = await db.execute(sql`
        SELECT wi.id, wi.number FROM work_item wi
        JOIN party_role pr ON pr.party_id = wi.party_id AND pr.role = 'lead' AND pr.valid_to IS NULL
        WHERE wi.party_id = ${c.partyId} AND wi.type = 'lead'
        ORDER BY wi.created_at DESC LIMIT 1
      `);
      const exist = existR.rows[0] as { id: string; number: string } | undefined;
      if (exist) return { kind: "already" as const, number: exist.number };

      // Already a learner? Don't promote — they're past leads.
      const lr = await db.execute(sql`
        SELECT 1 FROM party_role
        WHERE party_id = ${c.partyId} AND role = 'learner' AND valid_to IS NULL
      `);
      if (lr.rows[0]) return { kind: "is-learner" as const };

      // Insert a lead role + a work_item + a minimal lead row.
      // (Mirrors leads.ts POST / but without the agent / signal seeding —
      // those run on real lead create from the New Lead dialog. This is
      // just "make this contact appear in /leads".)
      await db.execute(sql`
        INSERT INTO party_role (tenant_id, party_id, role)
        VALUES (current_tenant(), ${c.partyId}, 'lead')
        ON CONFLICT DO NOTHING
      `);

      const numR = await db.execute(sql`SELECT nextval('seq_lead')::text AS n`);
      const number = `LEAD-${(numR.rows[0] as { n: string }).n}`;

      const wiR = await db.execute(sql`
        INSERT INTO work_item (tenant_id, number, type, party_id, state)
        VALUES (current_tenant(), ${number}, 'lead', ${c.partyId}, 'open')
        RETURNING id
      `);
      const wiId = (wiR.rows[0] as { id: string }).id;

      await db.execute(sql`
        INSERT INTO lead (
          work_item_id, tenant_id,
          source, source_label, score, score_label, score_desc, heat, rating,
          stage, stage_label, avatar, initials, nba_icon, nba_label, nba_ghost
        ) VALUES (
          ${wiId}, current_tenant(),
          'whatsapp', 'WhatsApp inbox', 50, 'Warm lead',
          'Promoted from WhatsApp inbox — pending qualification.', 'warm', 'new lead',
          'new', 'New inbound', 'violet', ${c.name.slice(0, 2).toUpperCase()},
          'send', 'Reach out', false
        )
      `);

      return { kind: "ok" as const, number };
    });

    if (result.kind === "not-found")  return res.status(404).json({ error: "Conversation not found" });
    if (result.kind === "is-learner") return res.status(409).json({ error: "Party is already a learner — they're past the lead stage." });
    if (result.kind === "already")    return res.json({ ok: true, number: result.number, alreadyLead: true });
    res.json({ ok: true, number: result.number, alreadyLead: false });
  } catch (err) { next(err); }
});

// ─── Tags ────────────────────────────────────────────────────────────────

whatsappRouter.get("/tags", requirePermission("whatsapp.read"), async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`SELECT id, name, color, created_at AS "createdAt" FROM wa_tag ORDER BY lower(name)`);
      return r.rows;
    });
    res.json({ tags: rows });
  } catch (err) { next(err); }
});

whatsappRouter.post("/tags", requirePermission("whatsapp.manage"), async (req, res, next) => {
  try {
    const name  = String(req.body?.name ?? "").trim();
    const color = String(req.body?.color ?? "#3b82f6").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    if (name.length > 40) return res.status(400).json({ error: "name max 40 chars" });
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: "color must be a #RRGGBB hex" });
    try {
      const created = await withTenant(req.tenantId!, async (db) => {
        const r = await db.execute(sql`
          INSERT INTO wa_tag (tenant_id, name, color)
          VALUES (current_tenant(), ${name}, ${color})
          RETURNING id, name, color, created_at AS "createdAt"
        `);
        return r.rows[0];
      });
      res.status(201).json({ tag: created });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("wa_tag_tenant_name_key")) {
        return res.status(409).json({ error: "A tag with that name already exists." });
      }
      throw err;
    }
  } catch (err) { next(err); }
});

whatsappRouter.delete("/tags/:id", requirePermission("whatsapp.manage"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "invalid id" });
    await withTenant(req.tenantId!, async (db) => {
      await db.execute(sql`DELETE FROM wa_tag WHERE id = ${id}`);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Attach / detach a tag on a conversation's party.
whatsappRouter.post("/conversations/:id/tag", requirePermission("whatsapp.send"), async (req, res, next) => {
  try {
    const id    = String(req.params.id ?? "");
    const tagId = String(req.body?.tagId ?? "");
    if (!/^[0-9a-fA-F-]{36}$/.test(id))    return res.status(400).json({ error: "invalid conversation id" });
    if (!/^[0-9a-fA-F-]{36}$/.test(tagId)) return res.status(400).json({ error: "invalid tagId" });
    const ok = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`SELECT party_id FROM wa_conversation WHERE id = ${id}`);
      const conv = r.rows[0] as { party_id: string } | undefined;
      if (!conv) return false;
      await db.execute(sql`
        INSERT INTO wa_party_tag (tenant_id, party_id, tag_id)
        VALUES (current_tenant(), ${conv.party_id}, ${tagId})
        ON CONFLICT DO NOTHING
      `);
      return true;
    });
    if (!ok) return res.status(404).json({ error: "Conversation not found" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

whatsappRouter.delete("/conversations/:id/tag/:tagId", requirePermission("whatsapp.send"), async (req, res, next) => {
  try {
    const id    = String(req.params.id ?? "");
    const tagId = String(req.params.tagId ?? "");
    if (!/^[0-9a-fA-F-]{36}$/.test(id))    return res.status(400).json({ error: "invalid conversation id" });
    if (!/^[0-9a-fA-F-]{36}$/.test(tagId)) return res.status(400).json({ error: "invalid tagId" });
    await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`SELECT party_id FROM wa_conversation WHERE id = ${id}`);
      const conv = r.rows[0] as { party_id: string } | undefined;
      if (!conv) return;
      await db.execute(sql`
        DELETE FROM wa_party_tag
        WHERE party_id = ${conv.party_id} AND tag_id = ${tagId}
      `);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Templates: list (local cache) ───────────────────────────────────────

whatsappRouter.get("/templates", requirePermission("whatsapp.read"), async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          id, template_name AS "templateName", language, category,
          header_type AS "headerType", header_content AS "headerContent",
          body_text AS "bodyText", footer_text AS "footerText",
          buttons, variable_count AS "variableCount",
          status, last_synced_at AS "lastSyncedAt",
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM wa_template
        ORDER BY status, lower(template_name), language
      `);
      return r.rows;
    });
    res.json({ templates: rows });
  } catch (err) { next(err); }
});

// ─── Templates: sync from Meta ──────────────────────────────────────────
//
// Calls Meta's GET /{waba_id}/message_templates and upserts each row.
// Templates removed on Meta's side stay in our table but get marked
// status='paused' so a stale rule doesn't try to send them. We don't
// hard-delete because they may still be referenced by historical
// wa_message rows.

whatsappRouter.post("/templates/sync", requirePermission("whatsapp.manage"), async (req, res, next) => {
  try {
    const out = await withTenant(req.tenantId!, async (db) => {
      const cfgR = await db.execute(sql`
        SELECT phone_number_id, waba_id, app_id, app_secret,
               system_user_token, webhook_verify_token
        FROM wa_config LIMIT 1
      `);
      const cfg = cfgR.rows[0] as Record<string, unknown> | undefined;
      const creds = readMetaCreds(cfg);
      if (!creds) return { kind: "no-config" as const };

      const list = await listTemplates({ creds });
      if (!list.ok) return { kind: "meta-error" as const, error: list.error, httpStatus: list.httpStatus };

      let inserted = 0, updated = 0;
      for (const t of list.templates) {
        const r = await db.execute(sql`
          INSERT INTO wa_template (
            tenant_id, template_name, language, category,
            header_type, header_content, body_text, footer_text,
            buttons, variable_count, status, last_synced_at
          )
          VALUES (
            current_tenant(), ${t.name}, ${t.language}, ${t.category},
            ${t.headerType}, ${t.headerContent}, ${t.bodyText}, ${t.footerText},
            ${t.buttons ? sql`${JSON.stringify(t.buttons)}::jsonb` : sql`NULL`},
            ${t.variableCount}, ${t.status}, NOW()
          )
          ON CONFLICT (tenant_id, template_name, language) DO UPDATE
          SET category       = EXCLUDED.category,
              header_type    = EXCLUDED.header_type,
              header_content = EXCLUDED.header_content,
              body_text      = EXCLUDED.body_text,
              footer_text    = EXCLUDED.footer_text,
              buttons        = EXCLUDED.buttons,
              variable_count = EXCLUDED.variable_count,
              status         = EXCLUDED.status,
              last_synced_at = NOW()
          RETURNING (xmax = 0) AS inserted
        `);
        const wasInsert = (r.rows[0] as { inserted: boolean }).inserted;
        if (wasInsert) inserted++; else updated++;
      }
      return { kind: "ok" as const, inserted, updated, total: list.templates.length };
    });

    if (out.kind === "no-config") return res.status(409).json({ error: "WhatsApp is not configured." });
    if (out.kind === "meta-error") return res.status(502).json({ error: `Meta error: ${out.error ?? "unknown"} (HTTP ${out.httpStatus})` });
    res.json({ ok: true, inserted: out.inserted, updated: out.updated, total: out.total });
  } catch (err) { next(err); }
});

// ────────────────────────────────────────────────────────────────────────
// Broadcasts (Phase 3.4)
// ────────────────────────────────────────────────────────────────────────
//
// Lifecycle: draft → (recipients added) → sending → completed / cancelled.
// Only flipping draft→sending is the "send now" call; the worker drains
// pending recipients after that. /cancel flips sending→cancelled and
// also marks any still-pending recipients cancelled so the worker stops.

// ─── GET /whatsapp/broadcasts ───────────────────────────────────────────

whatsappRouter.get("/broadcasts", requirePermission("whatsapp.read"), async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT b.id, b.name, b.status, b.template_id AS "templateId",
               t.template_name AS "templateName", t.language AS "templateLanguage",
               b.scheduled_at AS "scheduledAt", b.started_at AS "startedAt",
               b.finished_at AS "finishedAt",
               b.total_recipients AS "totalRecipients",
               b.sent_count AS "sentCount",
               b.delivered_count AS "deliveredCount",
               b.read_count AS "readCount",
               b.failed_count AS "failedCount",
               b.created_at AS "createdAt",
               u.id         AS "createdBy",  -- app_user.id via party_id (Phase 2)
               u.name AS "createdByName"
        FROM wa_broadcast b
        LEFT JOIN wa_template t ON t.id = b.template_id
        LEFT JOIN app_user u ON u.party_id = b.created_by
        ORDER BY b.created_at DESC
        LIMIT 200
      `);
      return r.rows;
    });
    res.json({ broadcasts: rows });
  } catch (err) { next(err); }
});

// ─── POST /whatsapp/broadcasts (create draft) ───────────────────────────

whatsappRouter.post("/broadcasts", requirePermission("whatsapp.broadcast"), async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const templateId = String(req.body?.templateId ?? "").trim();
    const defaultVariables = (req.body?.defaultVariables ?? {}) as Record<string, unknown>;
    const scheduledAtRaw = req.body?.scheduledAt as string | null | undefined;

    if (name.length < 1 || name.length > 120) {
      return res.status(400).json({ error: "name must be 1-120 chars" });
    }
    if (!templateId) return res.status(400).json({ error: "templateId is required" });

    let scheduledAt: Date | null = null;
    if (scheduledAtRaw) {
      const d = new Date(scheduledAtRaw);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "scheduledAt is not a valid datetime" });
      scheduledAt = d;
    }

    const out = await withTenant(req.tenantId!, async (db) => {
      // Verify template exists + is approved.
      const tplR = await db.execute(sql`
        SELECT id, status FROM wa_template WHERE id = ${templateId}
      `);
      const tpl = tplR.rows[0] as { id: string; status: string } | undefined;
      if (!tpl) return { kind: "tpl-missing" as const };
      if (tpl.status !== "approved") return { kind: "tpl-not-approved" as const, status: tpl.status };

      // Phase 2: created_by stores party.id.
      const creatorPartyId = req.userId ? await partyIdFromAppUserId(db, req.userId) : null;
      const r = await db.execute(sql`
        INSERT INTO wa_broadcast (tenant_id, name, template_id, created_by, default_variables, status, scheduled_at)
        VALUES (current_tenant(), ${name}, ${templateId}, ${creatorPartyId},
                ${sql`${JSON.stringify(defaultVariables)}::jsonb`},
                ${scheduledAt ? "scheduled" : "draft"},
                ${scheduledAt})
        RETURNING id
      `);
      return { kind: "ok" as const, id: (r.rows[0] as { id: string }).id };
    });

    if (out.kind === "tpl-missing") return res.status(404).json({ error: "Template not found" });
    if (out.kind === "tpl-not-approved") return res.status(409).json({ error: `Template is ${out.status}; only approved templates can be sent.` });
    res.status(201).json({ id: out.id });
  } catch (err) { next(err); }
});

// ─── GET /whatsapp/broadcasts/:id (detail) ─────────────────────────────

whatsappRouter.get("/broadcasts/:id", requirePermission("whatsapp.read"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    const out = await withTenant(req.tenantId!, async (db) => {
      const bR = await db.execute(sql`
        SELECT b.id, b.name, b.status, b.template_id AS "templateId",
               t.template_name AS "templateName", t.language AS "templateLanguage",
               t.body_text AS "templateBodyText", t.variable_count AS "templateVariableCount",
               b.default_variables AS "defaultVariables",
               b.scheduled_at AS "scheduledAt", b.started_at AS "startedAt",
               b.finished_at AS "finishedAt",
               b.total_recipients AS "totalRecipients",
               b.sent_count AS "sentCount",
               b.delivered_count AS "deliveredCount",
               b.read_count AS "readCount",
               b.failed_count AS "failedCount",
               b.created_at AS "createdAt", b.updated_at AS "updatedAt",
               u.id         AS "createdBy",  -- app_user.id via party_id (Phase 2)
               u.name AS "createdByName"
        FROM wa_broadcast b
        LEFT JOIN wa_template t ON t.id = b.template_id
        LEFT JOIN app_user u ON u.party_id = b.created_by
        WHERE b.id = ${id}
      `);
      const broadcast = bR.rows[0] as Record<string, unknown> | undefined;
      if (!broadcast) return null;

      const rR = await db.execute(sql`
        SELECT r.id, r.party_id AS "partyId", r.to_phone AS "toPhone",
               r.variables, r.status,
               r.provider_message_id AS "providerMessageId",
               r.error_code AS "errorCode", r.error_message AS "errorMessage",
               r.queued_at AS "queuedAt", r.sent_at AS "sentAt",
               r.delivered_at AS "deliveredAt", r.read_at AS "readAt",
               p.name AS "partyName"
        FROM wa_broadcast_recipient r
        LEFT JOIN party p ON p.id = r.party_id
        WHERE r.broadcast_id = ${id}
        ORDER BY r.queued_at
        LIMIT 500
      `);
      return { broadcast, recipients: rR.rows };
    });

    if (!out) return res.status(404).json({ error: "Broadcast not found" });
    res.json(out);
  } catch (err) { next(err); }
});

// ─── POST /whatsapp/broadcasts/:id/recipients (bulk add) ────────────────
//
// Accepts EITHER `partyIds: string[]` (preferred — server resolves to phones)
// OR `entries: { phone: string, variables?: Record<string,string> }[]` (raw
// phone fallback for CSV uploads). Dedup by (broadcast_id, party_id) UNIQUE
// index — re-adding a known party is a no-op via ON CONFLICT.

whatsappRouter.post("/broadcasts/:id/recipients", requirePermission("whatsapp.broadcast"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    const partyIds = Array.isArray(req.body?.partyIds) ? (req.body.partyIds as unknown[]).map(String).filter(Boolean) : [];
    const entries = Array.isArray(req.body?.entries) ? req.body.entries as Array<{ phone?: string; variables?: Record<string, string> }> : [];

    if (partyIds.length === 0 && entries.length === 0) {
      return res.status(400).json({ error: "Provide partyIds[] or entries[]" });
    }

    const out = await withTenant(req.tenantId!, async (db) => {
      // Must be in a draft or scheduled broadcast (don't add to one already sending).
      const bR = await db.execute(sql`SELECT status FROM wa_broadcast WHERE id = ${id}`);
      const b = bR.rows[0] as { status: string } | undefined;
      if (!b) return { kind: "missing" as const };
      if (!["draft", "scheduled"].includes(b.status)) return { kind: "bad-state" as const, status: b.status };

      // Phase 4: strict consent gate. Filter partyIds by opt_in=true on the
      // whatsapp channel before we touch the recipient table.
      const consent = await filterConsentedRecipients(db, "whatsapp", partyIds);
      const allowedPartyIds = new Set(consent.allowed);

      let added = 0;
      const skipped: Array<{ partyId: string; reason: string }> = [];
      // Any inbound partyId that filterConsentedRecipients discarded up
      // front (bad UUID) gets a reason too, so the caller sees a full list.
      for (const pid of partyIds) {
        if (!allowedPartyIds.has(pid)) {
          const reason = consent.blocked.find((c) => c.partyId === pid)?.reason ?? "no_consent";
          skipped.push({ partyId: pid, reason });
        }
      }

      // Path A: partyIds — resolve each ALLOWED party to a phone using the
      // party's phone + phone_country_code columns (matches inbox.ts convention).
      for (const pid of consent.allowed) {
        const pR = await db.execute(sql`
          SELECT id,
                 NULLIF(regexp_replace(COALESCE(phone_country_code, ''), '[^0-9]', '', 'g')
                        || regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), '') AS digits
          FROM party WHERE id = ${pid}
        `);
        const p = pR.rows[0] as { id: string; digits: string | null } | undefined;
        if (!p?.digits) {
          skipped.push({ partyId: pid, reason: "no_phone" });
          continue;
        }
        const e164 = `+${p.digits}`;
        const ins = await db.execute(sql`
          INSERT INTO wa_broadcast_recipient (tenant_id, broadcast_id, party_id, to_phone)
          VALUES (current_tenant(), ${id}, ${p.id}, ${e164})
          ON CONFLICT (broadcast_id, party_id) WHERE party_id IS NOT NULL DO NOTHING
          RETURNING id
        `);
        if (ins.rows.length > 0) added++;
      }
      // Path B: raw entries. Consent unchecked — no party to check against.
      // Ops takes responsibility for these; we return a warning below.
      for (const e of entries) {
        const phone = String(e?.phone ?? "").trim();
        if (!phone) continue;
        const variables = e?.variables ?? {};
        await db.execute(sql`
          INSERT INTO wa_broadcast_recipient (tenant_id, broadcast_id, party_id, to_phone, variables)
          VALUES (current_tenant(), ${id}, NULL, ${phone},
                  ${sql`${JSON.stringify(variables)}::jsonb`})
        `);
        added++;
      }

      // Update total_recipients count (counts all recipient rows, not just new ones).
      await db.execute(sql`
        UPDATE wa_broadcast SET total_recipients = (
          SELECT COUNT(*)::int FROM wa_broadcast_recipient WHERE broadcast_id = ${id}
        )
        WHERE id = ${id}
      `);

      const warnings: string[] = [];
      if (entries.length > 0) {
        warnings.push(
          "raw phone entries were added without consent check — ops responsibility",
        );
      }
      return { kind: "ok" as const, added, skipped, warnings };
    });

    if (out.kind === "missing") return res.status(404).json({ error: "Broadcast not found" });
    if (out.kind === "bad-state") return res.status(409).json({ error: `Cannot add recipients to a ${out.status} broadcast` });
    res.json({ ok: true, added: out.added, skipped: out.skipped, warnings: out.warnings });
  } catch (err) { next(err); }
});

// ─── DELETE /whatsapp/broadcasts/:id/recipients/:rid ────────────────────

whatsappRouter.delete("/broadcasts/:id/recipients/:rid", requirePermission("whatsapp.broadcast"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    const rid = String(req.params.rid ?? "");
    const out = await withTenant(req.tenantId!, async (db) => {
      const bR = await db.execute(sql`SELECT status FROM wa_broadcast WHERE id = ${id}`);
      const b = bR.rows[0] as { status: string } | undefined;
      if (!b) return { kind: "missing" as const };
      if (!["draft", "scheduled"].includes(b.status)) return { kind: "bad-state" as const, status: b.status };
      await db.execute(sql`DELETE FROM wa_broadcast_recipient WHERE id = ${rid} AND broadcast_id = ${id}`);
      await db.execute(sql`
        UPDATE wa_broadcast SET total_recipients = (
          SELECT COUNT(*)::int FROM wa_broadcast_recipient WHERE broadcast_id = ${id}
        )
        WHERE id = ${id}
      `);
      return { kind: "ok" as const };
    });
    if (out.kind === "missing") return res.status(404).json({ error: "Broadcast not found" });
    if (out.kind === "bad-state") return res.status(409).json({ error: `Cannot edit a ${out.status} broadcast` });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── POST /whatsapp/broadcasts/:id/send ────────────────────────────────
// Transitions draft|scheduled → sending. The worker drains pending rows.

whatsappRouter.post("/broadcasts/:id/send", requirePermission("whatsapp.broadcast"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    const out = await withTenant(req.tenantId!, async (db) => {
      const bR = await db.execute(sql`
        SELECT b.status, b.total_recipients,
               t.status AS "templateStatus"
        FROM wa_broadcast b
        LEFT JOIN wa_template t ON t.id = b.template_id
        WHERE b.id = ${id}
      `);
      const b = bR.rows[0] as { status: string; total_recipients: number; templateStatus: string | null } | undefined;
      if (!b) return { kind: "missing" as const };
      if (!["draft", "scheduled"].includes(b.status)) return { kind: "bad-state" as const, status: b.status };
      if ((b.total_recipients ?? 0) === 0) return { kind: "no-recipients" as const };
      if (b.templateStatus !== "approved") return { kind: "tpl-bad" as const, status: b.templateStatus };

      // Verify config is connected before flipping — better to fail fast than have the worker fail.
      const cfgR = await db.execute(sql`SELECT status FROM wa_config LIMIT 1`);
      const cfg = cfgR.rows[0] as { status: string } | undefined;
      if (!cfg || cfg.status !== "connected") return { kind: "no-config" as const };

      await db.execute(sql`
        UPDATE wa_broadcast
          SET status = 'sending', started_at = COALESCE(started_at, NOW())
          WHERE id = ${id}
      `);
      return { kind: "ok" as const };
    });

    if (out.kind === "missing") return res.status(404).json({ error: "Broadcast not found" });
    if (out.kind === "bad-state") return res.status(409).json({ error: `Cannot send a ${out.status} broadcast` });
    if (out.kind === "no-recipients") return res.status(409).json({ error: "Add recipients before sending" });
    if (out.kind === "tpl-bad") return res.status(409).json({ error: `Template is ${out.status ?? "missing"}; only approved templates can send` });
    if (out.kind === "no-config") return res.status(409).json({ error: "WhatsApp is not connected" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── POST /whatsapp/broadcasts/:id/cancel ──────────────────────────────

whatsappRouter.post("/broadcasts/:id/cancel", requirePermission("whatsapp.broadcast"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    const out = await withTenant(req.tenantId!, async (db) => {
      const bR = await db.execute(sql`SELECT status FROM wa_broadcast WHERE id = ${id}`);
      const b = bR.rows[0] as { status: string } | undefined;
      if (!b) return { kind: "missing" as const };
      if (!["draft", "scheduled", "sending"].includes(b.status)) {
        return { kind: "bad-state" as const, status: b.status };
      }
      // Cancel any still-pending recipients so the worker stops draining.
      await db.execute(sql`
        UPDATE wa_broadcast_recipient
          SET status = 'cancelled'
          WHERE broadcast_id = ${id} AND status = 'pending'
      `);
      await db.execute(sql`
        UPDATE wa_broadcast
          SET status = 'cancelled', finished_at = COALESCE(finished_at, NOW())
          WHERE id = ${id}
      `);
      return { kind: "ok" as const };
    });
    if (out.kind === "missing") return res.status(404).json({ error: "Broadcast not found" });
    if (out.kind === "bad-state") return res.status(409).json({ error: `Cannot cancel a ${out.status} broadcast` });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── DELETE /whatsapp/broadcasts/:id (only when draft) ─────────────────

whatsappRouter.delete("/broadcasts/:id", requirePermission("whatsapp.broadcast"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    const out = await withTenant(req.tenantId!, async (db) => {
      const bR = await db.execute(sql`SELECT status FROM wa_broadcast WHERE id = ${id}`);
      const b = bR.rows[0] as { status: string } | undefined;
      if (!b) return { kind: "missing" as const };
      if (b.status !== "draft") return { kind: "bad-state" as const, status: b.status };
      // CASCADE drops recipients.
      await db.execute(sql`DELETE FROM wa_broadcast WHERE id = ${id}`);
      return { kind: "ok" as const };
    });
    if (out.kind === "missing") return res.status(404).json({ error: "Broadcast not found" });
    if (out.kind === "bad-state") return res.status(409).json({ error: `Only draft broadcasts can be deleted (this is ${out.status}); cancel it instead` });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ────────────────────────────────────────────────────────────────────────
// Automations (Phase 4.5)
// ────────────────────────────────────────────────────────────────────────
//
// Trigger types: 'inbound_message_keyword' | 'new_contact' | 'lead_created'
// Action types: 'send_template' | 'send_text' | 'add_tag' | 'assign_user' | 'set_status'
// Validation lives in validateAutomation; the engine is in lib/whatsapp/automations.ts.

const TRIGGER_TYPES = new Set(["inbound_message_keyword", "new_contact", "lead_created"]);
const ACTION_TYPES = new Set(["send_template", "send_text", "add_tag", "assign_user", "set_status"]);

function validateAutomation(body: unknown): { ok: true; value: { name: string; description: string | null; trigger: unknown; actions: unknown[]; enabled: boolean } } | { ok: false; error: string } {
  const b = body as Record<string, unknown>;
  const name = String(b?.name ?? "").trim();
  if (name.length < 1 || name.length > 120) return { ok: false, error: "name must be 1-120 chars" };

  const description = b?.description != null ? String(b.description) : null;

  const trigger = b?.trigger as { type?: string; config?: unknown } | undefined;
  if (!trigger || typeof trigger.type !== "string" || !TRIGGER_TYPES.has(trigger.type)) {
    return { ok: false, error: `trigger.type must be one of: ${Array.from(TRIGGER_TYPES).join(", ")}` };
  }

  const actions = Array.isArray(b?.actions) ? (b.actions as unknown[]) : [];
  for (const a of actions) {
    const action = a as { type?: string; config?: unknown };
    if (typeof action.type !== "string" || !ACTION_TYPES.has(action.type)) {
      return { ok: false, error: `action.type must be one of: ${Array.from(ACTION_TYPES).join(", ")}` };
    }
  }

  const enabled = !!b?.enabled;
  return { ok: true, value: { name, description, trigger, actions, enabled } };
}

// ─── GET /whatsapp/automations ──────────────────────────────────────────

whatsappRouter.get("/automations", requirePermission("whatsapp.read"), async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT a.id, a.name, a.description,
               a.trigger, a.actions, a.enabled,
               u.id         AS "createdBy",  -- app_user.id via party_id (Phase 2)
               u.name AS "createdByName",
               a.created_at AS "createdAt",
               a.updated_at AS "updatedAt",
               (SELECT COUNT(*)::int FROM wa_automation_run r WHERE r.automation_id = a.id) AS "runCount"
        FROM wa_automation a
        LEFT JOIN app_user u ON u.party_id = a.created_by
        ORDER BY a.created_at DESC
      `);
      return r.rows;
    });
    res.json({ automations: rows });
  } catch (err) { next(err); }
});

// ─── POST /whatsapp/automations ─────────────────────────────────────────

whatsappRouter.post("/automations", requirePermission("whatsapp.manage"), async (req, res, next) => {
  try {
    const v = validateAutomation(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const { name, description, trigger, actions, enabled } = v.value;

    const id = await withTenant(req.tenantId!, async (db) => {
      // Phase 2: created_by stores party.id.
      const creatorPartyId = req.userId ? await partyIdFromAppUserId(db, req.userId) : null;
      const r = await db.execute(sql`
        INSERT INTO wa_automation (tenant_id, name, description, trigger, actions, enabled, created_by)
        VALUES (
          current_tenant(), ${name}, ${description},
          ${sql`${JSON.stringify(trigger)}::jsonb`},
          ${sql`${JSON.stringify(actions)}::jsonb`},
          ${enabled}, ${creatorPartyId}
        )
        RETURNING id
      `);
      return (r.rows[0] as { id: string }).id;
    });
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

// ─── GET /whatsapp/automations/:id ──────────────────────────────────────

whatsappRouter.get("/automations/:id", requirePermission("whatsapp.read"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    const out = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT a.id, a.name, a.description, a.trigger, a.actions, a.enabled,
               u.id         AS "createdBy",  -- app_user.id via party_id (Phase 2)
               u.name AS "createdByName",
               a.created_at AS "createdAt",
               a.updated_at AS "updatedAt"
        FROM wa_automation a
        LEFT JOIN app_user u ON u.party_id = a.created_by
        WHERE a.id = ${id}
      `);
      return r.rows[0] as Record<string, unknown> | undefined;
    });
    if (!out) return res.status(404).json({ error: "Automation not found" });
    res.json({ automation: out });
  } catch (err) { next(err); }
});

// ─── PATCH /whatsapp/automations/:id ────────────────────────────────────

whatsappRouter.patch("/automations/:id", requirePermission("whatsapp.manage"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    const v = validateAutomation(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const { name, description, trigger, actions, enabled } = v.value;

    const out = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        UPDATE wa_automation
          SET name = ${name},
              description = ${description},
              trigger = ${sql`${JSON.stringify(trigger)}::jsonb`},
              actions = ${sql`${JSON.stringify(actions)}::jsonb`},
              enabled = ${enabled},
              updated_at = NOW()
          WHERE id = ${id}
          RETURNING id
      `);
      return r.rows[0] as { id: string } | undefined;
    });
    if (!out) return res.status(404).json({ error: "Automation not found" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── PATCH /whatsapp/automations/:id/enabled (toggle) ───────────────────

whatsappRouter.patch("/automations/:id/enabled", requirePermission("whatsapp.manage"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    const enabled = !!req.body?.enabled;
    const out = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        UPDATE wa_automation SET enabled = ${enabled}, updated_at = NOW()
        WHERE id = ${id} RETURNING id
      `);
      return r.rows[0] as { id: string } | undefined;
    });
    if (!out) return res.status(404).json({ error: "Automation not found" });
    res.json({ ok: true, enabled });
  } catch (err) { next(err); }
});

// ─── DELETE /whatsapp/automations/:id ───────────────────────────────────

whatsappRouter.delete("/automations/:id", requirePermission("whatsapp.manage"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    await withTenant(req.tenantId!, async (db) => {
      await db.execute(sql`DELETE FROM wa_automation WHERE id = ${id}`);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── GET /whatsapp/automations/:id/runs ────────────────────────────────

whatsappRouter.get("/automations/:id/runs", requirePermission("whatsapp.read"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) | 0, 1), 200);
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT r.id, r.party_id AS "partyId", r.conversation_id AS "conversationId",
               r.status, r.context, r.actions_log AS "actionsLog",
               r.error_message AS "errorMessage",
               r.started_at AS "startedAt", r.completed_at AS "completedAt",
               p.name AS "partyName"
        FROM wa_automation_run r
        LEFT JOIN party p ON p.id = r.party_id
        WHERE r.automation_id = ${id}
        ORDER BY r.started_at DESC
        LIMIT ${limit}
      `);
      return r.rows;
    });
    res.json({ runs: rows });
  } catch (err) { next(err); }
});

