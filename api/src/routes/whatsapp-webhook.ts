/**
 * Public WhatsApp webhook.
 *
 * Mounted with express.raw at /webhooks/whatsapp in index.ts (BEFORE
 * express.json + authMiddleware) — Meta signs the raw body with HMAC,
 * so any reformatting would break signature verification.
 *
 * GET   — Meta's verify handshake. Looks up wa_config rows; returns
 *         hub.challenge if any tenant's webhook_verify_token matches.
 * POST  — every inbound event:
 *           1. read raw bytes
 *           2. parse JSON, find waba_id from entry[0].id
 *           3. look up the matching tenant's wa_config (no current_tenant
 *              context yet — direct pool query)
 *           4. verify HMAC against THAT tenant's app_secret
 *           5. ACK 200 immediately (Meta retries on non-200; we have <5s
 *              budget anyway)
 *           6. processWebhook in setImmediate so the work happens out of
 *              band — failures here don't trigger Meta retries that would
 *              dup-insert (we're idempotent on provider_message_id anyway,
 *              but no point making Meta's job harder)
 *
 * Multi-tenant routing is by waba_id, which is in the body. The GET
 * handshake doesn't have a body, so it scans all rows — fine because
 * webhook_verify_token is a secret unique to the tenant that set it.
 */

import { Router, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { appPool, withTenant } from "../db/app.js";
import {
  parseWebhookPayload, readMetaCreds, verifyWebhookSignature,
  type MetaCreds, type ParsedWebhookPayload,
} from "../lib/whatsapp/meta.js";
import {
  applyStatusUpdate, bumpConversationOnInbound, insertInboundMessage,
  matchOrCreatePartyByPhone, upsertConversation,
} from "../lib/whatsapp/inbox.js";
import { runAutomations } from "../lib/whatsapp/automations.js";

export const whatsappWebhookRouter = Router();

// ─── GET — verify handshake ──────────────────────────────────────────────

whatsappWebhookRouter.get("/", async (req: Request, res: Response) => {
  const mode      = String(req.query["hub.mode"] ?? "");
  const token     = String(req.query["hub.verify_token"] ?? "");
  const challenge = String(req.query["hub.challenge"] ?? "");

  if (mode !== "subscribe" || !token || !challenge) {
    return res.status(400).type("text/plain").send("bad request");
  }

  const client = await appPool.connect();
  try {
    const r = await client.query<{
      tenant_id: string; phone_number_id: string | null; waba_id: string | null;
      app_id: string | null; app_secret: string | null; system_user_token: string | null;
      webhook_verify_token: string | null;
    }>(
      `SELECT tenant_id, phone_number_id, waba_id, app_id, app_secret,
              system_user_token, webhook_verify_token
         FROM wa_config
        WHERE status = 'connected'`,
    );
    for (const row of r.rows) {
      const creds = readMetaCreds(row);
      if (!creds) continue;
      if (creds.webhook_verify_token === token) {
        return res.status(200).type("text/plain").send(challenge);
      }
    }
    return res.status(403).type("text/plain").send("invalid verify token");
  } catch (err) {
    console.error("[whatsapp-webhook] verify lookup error:", (err as Error).message);
    return res.status(500).type("text/plain").send("internal error");
  } finally {
    client.release();
  }
});

// ─── POST — events (inbound messages + status callbacks) ────────────────

whatsappWebhookRouter.post("/", async (req: Request, res: Response) => {
  // express.raw populates req.body as a Buffer. Defensively handle text/JSON
  // pass-throughs in case middleware order ever shifts.
  const raw: Buffer | null =
    Buffer.isBuffer(req.body) ? req.body :
    typeof req.body === "string" ? Buffer.from(req.body, "utf8") :
    null;
  if (!raw) {
    return res.status(400).type("text/plain").send("expected raw body");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).type("text/plain").send("invalid json");
  }

  const wabaIdFromBody = pickWabaId(parsedJson);
  if (!wabaIdFromBody) {
    // Some Meta keepalives / heartbeats. Ack so they don't retry.
    return res.status(200).type("text/plain").send("ok");
  }

  // Find the tenant whose wa_config.waba_id matches.
  const match = await findTenantByWaba(wabaIdFromBody);
  if (!match) {
    // Unknown WABA. Ack so Meta stops retrying.
    console.warn(`[whatsapp-webhook] unknown waba_id ${wabaIdFromBody} — dropping`);
    return res.status(200).type("text/plain").send("ok");
  }

  // HMAC verify with THIS tenant's app_secret.
  const sigHeader = req.header("x-hub-signature-256") ?? null;
  if (!verifyWebhookSignature(raw, sigHeader, match.creds.app_secret)) {
    return res.status(401).type("text/plain").send("invalid signature");
  }

  // Ack first; process async. Meta's 5s budget is for the ack, not the work.
  res.status(200).type("text/plain").send("ok");

  setImmediate(() => {
    processWebhook(match.tenantId, parsedJson).catch((err) =>
      console.error("[whatsapp-webhook] processWebhook error:", (err as Error).message),
    );
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickWabaId(body: any): string | null {
  if (!body || typeof body !== "object") return null;
  const entries = Array.isArray(body.entry) ? body.entry : [];
  for (const e of entries) {
    if (e && typeof e === "object" && typeof e.id === "string") return e.id;
  }
  return null;
}

async function findTenantByWaba(wabaId: string): Promise<{ tenantId: string; creds: MetaCreds } | null> {
  const client = await appPool.connect();
  try {
    const r = await client.query<{
      tenant_id: string; phone_number_id: string | null; waba_id: string | null;
      app_id: string | null; app_secret: string | null; system_user_token: string | null;
      webhook_verify_token: string | null;
    }>(
      `SELECT tenant_id, phone_number_id, waba_id, app_id, app_secret,
              system_user_token, webhook_verify_token
         FROM wa_config
        WHERE waba_id = $1`,
      [wabaId],
    );
    const row = r.rows[0];
    if (!row) return null;
    const creds = readMetaCreds(row);
    if (!creds) return null;
    return { tenantId: row.tenant_id, creds };
  } finally {
    client.release();
  }
}

async function processWebhook(tenantId: string, parsedJson: unknown): Promise<void> {
  const parsed: ParsedWebhookPayload = parseWebhookPayload(parsedJson);

  await withTenant(tenantId, async (db) => {
    // ── Status updates first. They may reference outbound messages we
    // already have; updating before processing inbound prevents an
    // out-of-order "read" on a not-yet-recorded outbound from getting lost.
    for (const s of parsed.statuses) {
      try {
        await applyStatusUpdate(db, s);
      } catch (err) {
        console.error("[whatsapp-webhook] applyStatusUpdate error:", (err as Error).message);
      }
    }

    // ── Inbound messages.
    for (const m of parsed.messages) {
      try {
        const { partyId, created: partyCreated } = await matchOrCreatePartyByPhone(db, m.fromPhone);
        const { conversationId } = await upsertConversation(db, partyId);

        const { messageId, deduped } = await insertInboundMessage(
          db, conversationId, m, parsedJson,
        );

        // Skip the conversation-bump on dedup so retried webhooks don't
        // multiply unread_count.
        if (!deduped && messageId) {
          await bumpConversationOnInbound(db, conversationId, m);
        }

        // Don't fire automations on dedup — webhook retries shouldn't
        // re-trigger work like sending replies.
        if (!deduped && messageId) {
          // new_contact fires once per first-seen party. Independent of body.
          if (partyCreated) {
            try {
              await runAutomations(db, { kind: "new_contact", partyId, conversationId });
            } catch (err) {
              console.error("[whatsapp-webhook] new_contact automation error:", (err as Error).message);
            }
          }
          // inbound_message_keyword fires per message. Body is text content
          // for content_type=text, or caption for media (parser populates m.body).
          const body = (m.body ?? "").toString();
          try {
            await runAutomations(db, {
              kind: "inbound_message",
              partyId, conversationId, body,
              inWindow: true, // by definition — we just received an inbound
            });
          } catch (err) {
            console.error("[whatsapp-webhook] inbound automation error:", (err as Error).message);
          }
        }
      } catch (err) {
        console.error("[whatsapp-webhook] inbound persist error:", (err as Error).message);
      }
    }
  });
}
