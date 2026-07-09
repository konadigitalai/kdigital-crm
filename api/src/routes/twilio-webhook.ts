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
import { appPool, withTenant } from "../db/app.js";
import { readTwilioAuthToken, readTwilioConfig, TwilioNotConfigured } from "../lib/twilio/client.js";
import { parseTwilioWebhook, verifyTwilioSignature } from "../lib/twilio/webhook.js";
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
  // 1) Rate limit BEFORE HMAC to keep DoS cheap.
  if (!rateLimit(clientIp(req))) {
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

  // Verbose debug tracing left commented — flip back on when diagnosing
  // "message arrived at Twilio but not in CRM" mysteries.
  // console.log(`[twilio-webhook] kind=${parsed.kind} sid=${(parsed as { providerMessageId?: string }).providerMessageId ?? "?"} from=${(parsed as { fromE164?: string }).fromE164 ?? "?"} body=${JSON.stringify((parsed as { body?: string }).body ?? null).slice(0, 80)}`);
  try {
    if (parsed.kind === "inbound") {
      await withTenant(tenantId, async (db) => {
        const lookup = await matchOrCreatePartyByPhone(db, parsed.fromE164);
        const conv = await upsertConversation(db, lookup.partyId, parsed.channel, lookup.leadWorkItemId == null);
        const inserted = await insertInboundMessage(db, conv.id, parsed);
        if (!inserted) return; // duplicate — nothing more to do
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
        });
      });
    } else {
      await withTenant(tenantId, async (db) => {
        await applyStatusUpdate(db, parsed);
      });
    }
  } catch (err) {
    // Never 5xx to Twilio — they retry, we'd double-insert on the second try.
    // Log loudly.
    console.error("[twilio-webhook] handler error (swallowed):", (err as Error).message);
  }
  return res.status(200).type("text/plain").send("");
});

// ─── helpers ──────────────────────────────────────────────────────────────

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
