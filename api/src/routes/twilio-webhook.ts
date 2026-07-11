// Public Twilio webhook — inbound messages + status callbacks.
//
// Mounted at /webhooks/twilio in api/src/index.ts, with express.urlencoded()
// running BEFORE the global express.json(). Twilio POSTs
// application/x-www-form-urlencoded bodies.
//
// Request flow:
//   1. Per-IP rate limit (120/min).
//   2. Verify X-Twilio-Signature (HMAC-SHA1 of URL + sorted form params).
//   3. Parse form → inbound message or status callback.
//   4. For inbound: match/create party by phone → upsert conversation →
//      idempotent insert (ON CONFLICT provider_message_id DO NOTHING) →
//      timeline activity.
//   5. For status: UPDATE tw_message.status by provider_message_id.
//   6. ALWAYS 200 OK on ambiguous / duplicate to avoid Twilio retries.
//      Only 403 on signature failure, 429 on rate-limit trip.
//
// We resolve tenant from DEFAULT_TENANT_ID env or the newest tenant row —
// same trick as routes/intake.ts. Multi-tenant deployments will need to
// disambiguate via the "To" number in a follow-up.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { appPool, withTenant } from "../db/app.js";
import { readTwilioAuthToken, readTwilioConfig, TwilioNotConfigured } from "../lib/twilio/client.js";
import { parseTwilioWebhook, verifyTwilioSignature, isOptOutMessage, isOptInMessage } from "../lib/twilio/webhook.js";
import { setConsent, type Channel as ConsentChannel } from "../lib/party/consent.js";
import {
  matchOrCreatePartyByPhone,
  upsertConversation,
  insertInboundMessage,
  applyStatusUpdate,
  insertActivityForMessage,
} from "../lib/twilio/inbox.js";
import { resolveSentinelPartyId } from "../lib/party/resolve.js";

export const twilioWebhookRouter = Router();

// ─── Per-IP rate limit ────────────────────────────────────────────────────

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
const rateHits = new Map<string, number[]>();

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const arr = (rateHits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    rateHits.set(ip, arr);
    return false;
  }
  arr.push(now);
  rateHits.set(ip, arr);
  return true;
}

function clientIp(req: import("express").Request): string {
  const xf = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  return xf || req.socket.remoteAddress || "unknown";
}

// ─── Tenant resolution (mirrors routes/intake.ts) ─────────────────────────

let cachedTenantId: string | null = null;
async function resolveDefaultTenantId(): Promise<string | null> {
  if (cachedTenantId) return cachedTenantId;
  const fromEnv = process.env.DEFAULT_TENANT_ID?.trim();
  if (fromEnv && /^[0-9a-fA-F-]{36}$/.test(fromEnv)) {
    cachedTenantId = fromEnv;
    return cachedTenantId;
  }
  const r = await appPool.query<{ id: string }>(
    `SELECT id FROM tenant ORDER BY created_at DESC LIMIT 1`,
  );
  cachedTenantId = r.rows[0]?.id ?? null;
  return cachedTenantId;
}

// ─── POST /webhooks/twilio ────────────────────────────────────────────────

twilioWebhookRouter.post("/", async (req, res) => {
  // TEMP DEBUG — remove once inbound is verified on hosted envs.
  console.log(`[twilio-webhook] hit ip=${clientIp(req)} bodyKeys=${Object.keys(req.body ?? {}).join(",")}`);

  // 1) Rate limit BEFORE HMAC to keep DoS cheap.
  if (!rateLimit(clientIp(req))) {
    console.warn(`[twilio-webhook] rate-limited ip=${clientIp(req)}`);
    return res.status(429).type("text/plain").send("rate limited");
  }

  // 2) Signature verify. Read auth token separately so we can 403 clearly
  //    even when send-side env vars aren't set (webhook still works for reads).
  const token = readTwilioAuthToken();
  if (!token) {
    console.error("[twilio-webhook] TWILIO_AUTH_TOKEN not set");
    return res.status(503).type("text/plain").send("twilio not configured");
  }
  let expectedUrl: string;
  try { expectedUrl = readTwilioConfig().webhookUrl; }
  catch (e) {
    if (e instanceof TwilioNotConfigured) {
      console.error("[twilio-webhook]", e.message);
      return res.status(503).type("text/plain").send("twilio not configured");
    }
    throw e;
  }

  const form = coerceFormBody(req.body);
  const sig = req.header("x-twilio-signature") ?? req.header("X-Twilio-Signature");
  if (!verifyTwilioSignature(sig, expectedUrl, form, token)) {
    console.warn("[twilio-webhook] signature mismatch — url=%s ip=%s", expectedUrl, clientIp(req));
    return res.status(403).type("text/plain").send("forbidden");
  }

  // 3) Parse
  const parsed = parseTwilioWebhook(form);
  if (parsed.kind === "ignore") return res.status(200).type("text/plain").send("");

  const tenantId = await resolveDefaultTenantId();
  if (!tenantId) {
    console.error("[twilio-webhook] no tenant to route to");
    return res.status(200).type("text/plain").send("");
  }

  // TEMP DEBUG — remove once inbound is verified on hosted envs.
  console.log(`[twilio-webhook] parsed kind=${parsed.kind} sid=${(parsed as { providerMessageId?: string }).providerMessageId ?? "?"} from=${(parsed as { fromE164?: string }).fromE164 ?? "?"} body=${JSON.stringify((parsed as { body?: string }).body ?? null).slice(0, 80)}`);
  try {
    if (parsed.kind === "inbound") {
      await withTenant(tenantId, async (db) => {
        console.log(`[twilio-webhook] → matchOrCreatePartyByPhone("${parsed.fromE164}")`);
        const lookup = await matchOrCreatePartyByPhone(db, parsed.fromE164);
        console.log(`[twilio-webhook] ← party=${lookup.partyId} isNew=${lookup.isNew} lead=${lookup.leadNumber ?? "none"}`);
        const conv = await upsertConversation(db, lookup.partyId, parsed.channel, lookup.leadWorkItemId == null);
        console.log(`[twilio-webhook] ← conversation=${conv.id}`);
        const inserted = await insertInboundMessage(db, conv.id, parsed);
        console.log(`[twilio-webhook] ← inserted=${inserted ?? "(duplicate)"}`);
        if (!inserted) return; // duplicate — nothing more to do

        // Persist inbound media (if any) — one media_asset row per URL,
        // then a tw_message_media join row in ordinal order. We store the
        // Twilio-hosted URL as-is (provider_hosted=true); the /media/proxy
        // route re-fetches it with Basic auth when the FE renders.
        for (const [ordinal, m] of parsed.media.entries()) {
          const assetR = await db.execute(sql`
            INSERT INTO media_asset (
              tenant_id, uploaded_by, filename,
              content_type, size_bytes, blob_url,
              is_library, source, provider_hosted
            )
            VALUES (
              current_tenant(), NULL,
              ${extractFilenameFromMedia(m.url, m.contentType, ordinal)},
              ${m.contentType}, 0, ${m.url},
              false, 'twilio_inbound', true
            )
            RETURNING id
          `);
          const assetId = (assetR.rows[0] as { id: string }).id;
          await db.execute(sql`
            INSERT INTO tw_message_media (message_id, asset_id, ordinal)
            VALUES (${inserted}, ${assetId}, ${ordinal})
          `);
        }

        const sentinel = await resolveSentinelPartyId(db, tenantId);
        await insertActivityForMessage(db, {
          workItemId: lookup.leadWorkItemId,
          partyId:    lookup.partyId,
          actorType:  "system",
          actorPartyId: sentinel,
          actorName:  parsed.profileName ?? "Contact",
          direction:  "inbound",
          channel:    parsed.channel,
          body:       parsed.body,
          mediaCount: parsed.media.length,
          mediaMimes: parsed.media.map((m) => m.contentType),
        });
        console.log(`[twilio-webhook] ← activity inserted (media=${parsed.media.length}), done.`);

        // STOP / UNSUBSCRIBE / CANCEL etc. → flip party_consent to false.
        // Meta-side WhatsApp will also auto-block on STOP, but we own our
        // side of the record so future campaigns skip this party.
        //
        // SAVEPOINT-guarded — a setConsent failure must NOT abort the
        // transaction the inbound insert already committed to. If we
        // skipped this guard, the JS catch would silently succeed while
        // Postgres flags the txn aborted and the outer commit fails.
        const optOut = parsed.body ? isOptOutMessage(parsed.body) : false;
        const optIn  = parsed.body && !optOut ? isOptInMessage(parsed.body) : false;
        if (optOut || (optIn && parsed.channel === "sms")) {
          try {
            await db.execute(sql`SAVEPOINT consent_sp`);
            try {
              if (optOut) {
                await setConsent(
                  db, lookup.partyId, parsed.channel as ConsentChannel,
                  false, "inbound_stop_keyword", null,
                );
                console.log(`[twilio-webhook] opt-out recorded party=${lookup.partyId} channel=${parsed.channel}`);
              } else {
                await setConsent(
                  db, lookup.partyId, "sms",
                  true, "inbound_start_keyword", null,
                );
              }
              await db.execute(sql`RELEASE SAVEPOINT consent_sp`);
            } catch (inner) {
              await db.execute(sql`ROLLBACK TO SAVEPOINT consent_sp`);
              throw inner;
            }
          } catch (e) {
            console.error("[twilio-webhook] setConsent failed:", (e as Error).message);
          }
        }
      });
    } else {
      await withTenant(tenantId, async (db) => {
        const applied = await applyStatusUpdate(db, parsed);
        console.log(`[twilio-webhook] status update applied=${applied} sid=${parsed.providerMessageId} status=${parsed.status}`);

        // Mirror the delivery lifecycle onto campaign_recipient if this
        // Twilio message came from a campaign.
        if (parsed.status === "delivered" || parsed.status === "read") {
          await db.execute(sql`
            UPDATE campaign_recipient cr
            SET status = ${parsed.status},
                delivered_at = CASE WHEN cr.delivered_at IS NULL THEN NOW() ELSE cr.delivered_at END
            FROM tw_message m
            WHERE cr.tw_message_id = m.id
              AND m.provider_message_id = ${parsed.providerMessageId}
              AND cr.status IN ('sent','delivered')
          `);
        } else if (parsed.status === "failed") {
          await db.execute(sql`
            UPDATE campaign_recipient cr
            SET status = 'failed',
                error_code    = COALESCE(${parsed.errorCode},   cr.error_code),
                error_message = COALESCE(${parsed.errorMessage}, cr.error_message)
            FROM tw_message m
            WHERE cr.tw_message_id = m.id
              AND m.provider_message_id = ${parsed.providerMessageId}
          `);
        }
      });
    }
  } catch (err) {
    // Never 5xx to Twilio — they retry, we'd double-insert on the second try.
    // Log loudly with full stack this time.
    console.error("[twilio-webhook] handler error (swallowed):", err);
  }
  return res.status(200).type("text/plain").send("");
});

// ─── helpers ──────────────────────────────────────────────────────────────

/** Twilio's MediaUrl is opaque — no filename. Best we can do is derive
 *  from the MIME type + ordinal so the CRM has something to render. */
function extractFilenameFromMedia(url: string, contentType: string, ordinal: number): string {
  const ext = mimeToExt(contentType);
  return `whatsapp-${ordinal + 1}${ext ? `.${ext}` : ""}`;
}

function mimeToExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m === "image/jpeg") return "jpg";
  if (m === "image/png")  return "png";
  if (m === "image/gif")  return "gif";
  if (m === "image/webp") return "webp";
  if (m === "video/mp4")  return "mp4";
  if (m === "video/3gpp") return "3gp";
  if (m === "audio/mpeg") return "mp3";
  if (m === "audio/mp4")  return "m4a";
  if (m === "audio/amr")  return "amr";
  if (m === "audio/ogg")  return "ogg";
  if (m === "application/pdf") return "pdf";
  if (m === "application/zip" || m === "application/x-zip-compressed") return "zip";
  if (m === "application/msword") return "doc";
  if (m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (m === "application/vnd.ms-excel") return "xls";
  if (m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (m === "text/plain") return "txt";
  return "";
}

function coerceFormBody(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (body && typeof body === "object") {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
      else if (v != null) out[k] = String(v);
    }
  }
  return out;
}
