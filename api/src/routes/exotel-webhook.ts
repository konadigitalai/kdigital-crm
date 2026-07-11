// Public Exotel webhook — outbound StatusCallback + inbound Passthru.
//
// Mounted at /webhooks/exotel in api/src/index.ts, with express.urlencoded()
// + express.json() BOTH running BEFORE the global express.json(6mb).
// Exotel posts JSON for StatusCallback (we set the header) and form-urlencoded
// for Passthru. Both parsers land the body as `req.body: object`.
//
// Two sub-paths (segments after /webhooks/exotel):
//   /status   — outbound-api call completed / answered
//   /inbound  — customer called our ExoPhone (Passthru applet fires this)
//
// Exotel does NOT sign webhooks. Defence:
//   1. Optional IP allowlist via EXOTEL_ALLOWED_IPS env.
//   2. Per-IP rate limit (120/min) before parsing.
//   3. Always 200 OK on ambiguous / duplicate to avoid Exotel retries.
//   4. Payload can't do anything security-relevant — party lookup goes
//      through matchOrCreatePartyByPhone which won't attach random E.164s
//      to real parties without contact_point evidence.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { appPool, withTenant } from "../db/app.js";
import { readExotelConfig, ExotelNotConfigured } from "../lib/exotel/client.js";
import { parseExotelCallback, isIpAllowed, type ExotelParsedCall } from "../lib/exotel/webhook.js";
import {
  matchOrCreatePartyByPhone,
  upsertConversation,
  insertInboundMessage,
  insertActivityForMessage,
} from "../lib/twilio/inbox.js";
import { bootstrapConsent } from "../lib/party/consent.js";
import { resolveSentinelPartyId } from "../lib/party/resolve.js";

export const exotelWebhookRouter = Router();

// ─── Per-IP rate limit (same as Twilio webhook) ──────────────────────────
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
const rateHits = new Map<string, number[]>();
function rateLimit(ip: string): boolean {
  const now = Date.now();
  const arr = (rateHits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) { rateHits.set(ip, arr); return false; }
  arr.push(now);
  rateHits.set(ip, arr);
  return true;
}
function clientIp(req: import("express").Request): string {
  const xf = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  return xf || req.socket.remoteAddress || "unknown";
}

// ─── Tenant resolution (mirror routes/twilio-webhook.ts) ─────────────────
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

// ─── Shared entry ────────────────────────────────────────────────────────
async function handle(req: import("express").Request, res: import("express").Response): Promise<void> {
  const ip = clientIp(req);
  // Exotel's Passthru applet sends params via query string on GET, not a
  // POST body — despite what their docs suggest. StatusCallback on outbound
  // Connect API calls DOES send JSON POST though. Read from wherever the
  // data actually is: query first, body second.
  const params: Record<string, unknown> = {
    ...(req.query ?? {}) as Record<string, unknown>,
    ...(req.body ?? {}) as Record<string, unknown>,
  };
  console.log(`[exotel-webhook] hit ip=${ip} method=${req.method} path=${req.path} keys=${Object.keys(params).join(",")}`);

  if (!rateLimit(ip)) {
    console.warn(`[exotel-webhook] rate-limited ip=${ip}`);
    res.status(429).type("text/plain").send("rate limited");
    return;
  }

  // Optional IP allowlist. Missing config = allow all (dev-friendly).
  let allowedIps = "";
  try { allowedIps = readExotelConfig().allowedIps; }
  catch (e) {
    if (e instanceof ExotelNotConfigured) {
      console.warn(`[exotel-webhook] Exotel not configured — accepting anyway for observability`);
    } else { throw e; }
  }
  if (allowedIps && !isIpAllowed(ip, allowedIps)) {
    console.warn(`[exotel-webhook] ip not in allowlist ip=${ip}`);
    res.status(403).type("text/plain").send("forbidden");
    return;
  }

  const parsed = parseExotelCallback(params);
  if (parsed.kind === "ignore") {
    console.warn(`[exotel-webhook] unparseable body`);
    res.status(200).type("text/plain").send("");
    return;
  }

  const tenantId = await resolveDefaultTenantId();
  if (!tenantId) {
    console.error(`[exotel-webhook] no tenant to route to`);
    res.status(200).type("text/plain").send("");
    return;
  }

  try {
    if (parsed.kind === "inbound_missed") {
      await handleInbound(tenantId, parsed);
    } else {
      await handleTerminal(tenantId, parsed);
    }
  } catch (err) {
    // Never 5xx to Exotel — they retry.
    console.error("[exotel-webhook] handler error (swallowed):", err);
  }
  res.status(200).type("text/plain").send("");
}

// ─── Inbound: customer called our ExoPhone ───────────────────────────────
async function handleInbound(
  tenantId: string,
  parsed: ExotelParsedCall,
): Promise<void> {
  if (!parsed.fromE164) {
    console.warn(`[exotel-webhook] inbound missing From — skipping`);
    return;
  }
  const toE164 = parsed.toE164 ?? "";
  await withTenant(tenantId, async (db) => {
    console.log(`[exotel-webhook] → matchOrCreatePartyByPhone("${parsed.fromE164}")`);
    const lookup = await matchOrCreatePartyByPhone(db, parsed.fromE164!);
    console.log(`[exotel-webhook] ← party=${lookup.partyId} isNew=${lookup.isNew} lead=${lookup.leadNumber ?? "none"}`);
    const conv = await upsertConversation(db, lookup.partyId, "voice", lookup.leadWorkItemId == null);
    console.log(`[exotel-webhook] ← conversation=${conv.id}`);
    // Reuse insertInboundMessage's shape by faking a ParsedInboundMessage.
    // Voice has no `body` — leave null; media array empty.
    const inserted = await insertInboundMessage(db, conv.id, {
      kind: "inbound",
      providerMessageId: parsed.callSid,
      channel: "voice",
      fromE164: parsed.fromE164!,
      toE164,
      body: "",
      profileName: null,
      numMedia: 0,
      media: [],
      raw: parsed.raw as Record<string, string>,
    });
    console.log(`[exotel-webhook] ← inserted=${inserted ?? "(duplicate)"}`);
    if (!inserted) return;

    // Persist recording (if any) — same shape as Twilio inbound media.
    if (parsed.recordingUrl) {
      const assetR = await db.execute(sql`
        INSERT INTO media_asset (
          tenant_id, uploaded_by, filename,
          content_type, size_bytes, blob_url,
          is_library, source, provider_hosted
        )
        VALUES (
          current_tenant(), NULL,
          ${`call-${parsed.callSid}.mp3`},
          'audio/mpeg', 0, ${parsed.recordingUrl},
          false, 'exotel_recording', true
        )
        RETURNING id
      `);
      const assetId = (assetR.rows[0] as { id: string }).id;
      await db.execute(sql`
        INSERT INTO tw_message_media (message_id, asset_id, ordinal)
        VALUES (${inserted}, ${assetId}, 0)
      `);
    }

    // Log a call_event row.
    await db.execute(sql`
      INSERT INTO tw_call_event (tenant_id, tw_message_id, call_sid, event_type, status, duration_seconds, recording_url, legs, raw)
      VALUES (current_tenant(), ${inserted}, ${parsed.callSid}, 'inbound_missed', ${parsed.status},
              ${parsed.durationSeconds}, ${parsed.recordingUrl},
              ${parsed.legs ? JSON.stringify(parsed.legs) : null}::jsonb,
              ${JSON.stringify(truncateRaw(parsed.raw))}::jsonb)
      ON CONFLICT (tw_message_id, event_type) DO NOTHING
    `);

    const sentinel = await resolveSentinelPartyId(db, tenantId);
    await insertActivityForMessage(db, {
      workItemId: lookup.leadWorkItemId,
      partyId:    lookup.partyId,
      actorType:  "system",
      actorPartyId: sentinel,
      actorName:  "Contact",
      direction:  "inbound",
      channel:    "voice",
      body:       parsed.durationSeconds
                    ? `Call · ${formatDuration(parsed.durationSeconds)}`
                    : `Missed call`,
      mediaCount: parsed.recordingUrl ? 1 : 0,
      mediaMimes: parsed.recordingUrl ? ["audio/mpeg"] : [],
    });

    // Inbound = strong opt-in signal (customer initiated). Grant consent
    // on calls + whatsapp + sms so future outreach is unblocked.
    try {
      await db.execute(sql`SAVEPOINT consent_sp`);
      try {
        await bootstrapConsent(db, lookup.partyId, ["whatsapp", "sms", "calls"], "inbound_call");
        await db.execute(sql`RELEASE SAVEPOINT consent_sp`);
      } catch (inner) {
        await db.execute(sql`ROLLBACK TO SAVEPOINT consent_sp`);
        throw inner;
      }
    } catch (e) {
      console.error("[exotel-webhook] bootstrapConsent failed:", (e as Error).message);
    }
  });
}

// ─── Terminal / answered: outbound call event ────────────────────────────
async function handleTerminal(
  tenantId: string,
  parsed: ExotelParsedCall,
): Promise<void> {
  await withTenant(tenantId, async (db) => {
    // Find the tw_message we inserted when the outbound was fired.
    const mR = await db.execute(sql`
      SELECT id FROM tw_message WHERE provider_message_id = ${parsed.callSid} LIMIT 1
    `);
    const msg = mR.rows[0] as { id: string } | undefined;
    if (!msg) {
      // Late callback for a call we don't have — could happen if the outbound
      // record insert failed. Log and drop; nothing safe to attach to.
      console.warn(`[exotel-webhook] terminal for unknown callSid=${parsed.callSid}`);
      return;
    }

    // Update tw_message.status. Map Exotel Status → tw_message.status enum.
    const twStatus =
      parsed.kind === "answered"           ? "delivered" :
      parsed.status === "completed"        ? "delivered" :
      parsed.status === "no-answer"        ? "failed"    :
      parsed.status === "busy"             ? "failed"    :
      parsed.status === "failed"           ? "failed"    :
      "sent"; // fallback

    const willSetDelivered = twStatus === "delivered";
    await db.execute(sql`
      UPDATE tw_message
      SET status         = ${twStatus},
          delivered_at   = CASE WHEN ${willSetDelivered} AND delivered_at IS NULL THEN now() ELSE delivered_at END,
          error_code     = COALESCE(NULLIF(${parsed.status ?? ''}, ''), error_code),
          error_message  = COALESCE(NULLIF(${parsed.status ?? ''}, ''), error_message)
      WHERE id = ${msg.id}
    `);

    // Attach the recording as a media_asset once we have it (terminal event).
    if (parsed.recordingUrl && parsed.kind === "terminal") {
      // Idempotent — same call_sid shouldn't spawn duplicates. We key on
      // filename since we don't have a unique constraint on media_asset.
      const existing = await db.execute(sql`
        SELECT ma.id FROM tw_message_media mm
        JOIN media_asset ma ON ma.id = mm.asset_id
        WHERE mm.message_id = ${msg.id}
          AND ma.source = 'exotel_recording'
        LIMIT 1
      `);
      if (existing.rows.length === 0) {
        const assetR = await db.execute(sql`
          INSERT INTO media_asset (
            tenant_id, uploaded_by, filename,
            content_type, size_bytes, blob_url,
            is_library, source, provider_hosted
          )
          VALUES (
            current_tenant(), NULL,
            ${`call-${parsed.callSid}.mp3`},
            'audio/mpeg', 0, ${parsed.recordingUrl},
            false, 'exotel_recording', true
          )
          RETURNING id
        `);
        const assetId = (assetR.rows[0] as { id: string }).id;
        await db.execute(sql`
          INSERT INTO tw_message_media (message_id, asset_id, ordinal)
          VALUES (${msg.id}, ${assetId}, 0)
        `);
      }
    }

    // Record the call_event row (idempotent per event_type).
    await db.execute(sql`
      INSERT INTO tw_call_event (tenant_id, tw_message_id, call_sid, event_type, status, duration_seconds, recording_url, legs, raw)
      VALUES (current_tenant(), ${msg.id}, ${parsed.callSid}, ${parsed.kind},
              ${parsed.status}, ${parsed.durationSeconds}, ${parsed.recordingUrl},
              ${parsed.legs ? JSON.stringify(parsed.legs) : null}::jsonb,
              ${JSON.stringify(truncateRaw(parsed.raw))}::jsonb)
      ON CONFLICT (tw_message_id, event_type) DO NOTHING
    `);
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────
// Exotel Passthru applets fire GET (query-string params). Exotel StatusCallback
// on outbound Connect API calls fires POST (JSON body when we set it, or
// form-urlencoded). Accept both on both paths so operators can point either
// applet type at either URL without a routing gotcha.
exotelWebhookRouter.get ("/status",  (req, res) => { void handle(req, res); });
exotelWebhookRouter.post("/status",  (req, res) => { void handle(req, res); });
exotelWebhookRouter.get ("/inbound", (req, res) => { void handle(req, res); });
exotelWebhookRouter.post("/inbound", (req, res) => { void handle(req, res); });

// ─── helpers ─────────────────────────────────────────────────────────────
function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function truncateRaw(raw: Record<string, unknown>): Record<string, unknown> {
  // jsonb column has no size cap but big payloads slow the DB. Cap each
  // string field at 2 KB — that's more than any real Exotel field.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v.length > 2048) out[k] = v.slice(0, 2048) + "…";
    else out[k] = v;
  }
  return out;
}
