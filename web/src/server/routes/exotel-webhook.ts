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

import { Router } from "@/server/http";
import { rateLimit, clientIp } from "../lib/rate-limit";
import { sql } from "drizzle-orm";
import { appPool, withTenant } from "../db/app";
import { readExotelConfig, ExotelNotConfigured, fetchCallDetails } from "../lib/exotel/client";
import { parseExotelCallback, isIpAllowed, type ExotelParsedCall } from "../lib/exotel/webhook";
import {
  matchOrCreatePartyByPhone,
  upsertConversation,
  insertInboundMessage,
  insertActivityForMessage,
} from "../lib/twilio/inbox";
import { bootstrapConsent } from "../lib/party/consent";
import { resolveSentinelPartyId } from "../lib/party/resolve";

export const exotelWebhookRouter = Router();

// ─── Per-IP rate limit (same as Twilio webhook) ──────────────────────────
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;

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
async function handle(req: import("@/server/http").ApiRequest, res: import("@/server/http").ApiResponse): Promise<void> {
  const ip = clientIp(req.headers);
  // Exotel's Passthru applet sends params via query string on GET, not a
  // POST body — despite what their docs suggest. StatusCallback on outbound
  // Connect API calls DOES send JSON POST though. Read from wherever the
  // data actually is: query first, body second.
  const params: Record<string, unknown> = {
    ...(req.query ?? {}) as Record<string, unknown>,
    ...(req.body ?? {}) as Record<string, unknown>,
  };
  console.log(`[exotel-webhook] hit ip=${ip} method=${req.method} path=${req.path} keys=${Object.keys(params).join(",")}`);

  if (!(await rateLimit(`exotel-webhook:${ip}`, RATE_MAX, RATE_WINDOW_MS))) {
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
//
// Passthru fires TWICE per real inbound call:
//   1. At call start — CallSid + CallFrom + CallTo, no RecordingUrl, no
//      real status (DialCallStatus is 'null'/'busy'/etc.).
//   2. At call terminal — same CallSid, plus RecordingAvailableBy hint,
//      but STILL no recording URL yet (Exotel processes recordings 3-10
//      minutes AFTER the call ends).
//
// We used to skip the second event as a duplicate. Now we detect the
// duplicate case and attach the terminal event details to the existing
// message; then schedule a delayed poll against Exotel's Call Details API
// to pick up the recording once it's actually ready.
async function handleInbound(
  tenantId: string,
  parsed: ExotelParsedCall,
): Promise<void> {
  if (!parsed.fromE164) {
    console.warn(`[exotel-webhook] inbound missing From — skipping`);
    return;
  }
  const toE164 = parsed.toE164 ?? "";
  let messageIdForBackfill: string | null = null;
  await withTenant(tenantId, async (db) => {
    console.log(`[exotel-webhook] → matchOrCreatePartyByPhone("${parsed.fromE164}")`);
    const lookup = await matchOrCreatePartyByPhone(db, parsed.fromE164!);
    console.log(`[exotel-webhook] ← party=${lookup.partyId} isNew=${lookup.isNew} lead=${lookup.leadNumber ?? "none"}`);
    const conv = await upsertConversation(db, lookup.partyId, "voice", lookup.leadWorkItemId == null);
    console.log(`[exotel-webhook] ← conversation=${conv.id}`);

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

    let messageId = inserted;
    if (!messageId) {
      // Duplicate — this is the terminal event for a call whose start we
      // already logged. Fetch the existing row so we can attach the
      // terminal event + recording to it.
      const dup = await db.execute(sql`
        SELECT id FROM tw_message WHERE provider_message_id = ${parsed.callSid} LIMIT 1
      `);
      messageId = (dup.rows[0] as { id: string } | undefined)?.id ?? null;
      console.log(`[exotel-webhook] ← duplicate CallSid; attaching to existing message=${messageId}`);
    } else {
      console.log(`[exotel-webhook] ← inserted new message=${messageId}`);
    }
    if (!messageId) return;
    messageIdForBackfill = messageId;

    // Attach the recording (if any) — same shape as Twilio inbound media.
    // In practice Passthru NEVER gives us a real URL — the delayed poll
    // below is what actually fills this in.
    if (parsed.recordingUrl) {
      const existing = await db.execute(sql`
        SELECT ma.id FROM tw_message_media mm
        JOIN media_asset ma ON ma.id = mm.asset_id
        WHERE mm.message_id = ${messageId} AND ma.source = 'exotel_recording'
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
          VALUES (${messageId}, ${assetId}, 0)
        `);
      }
    }

    // Log a call_event row. On the terminal event we tag it 'terminal';
    // on the first hit (no EventType, no recording, no dial status yet)
    // we tag it 'inbound'.
    const looksTerminal =
      parsed.raw.EventType != null ||
      parsed.recordingUrl != null ||
      (parsed.status != null && parsed.status.toLowerCase() !== "null");
    const eventTag = looksTerminal ? "terminal" : "inbound";
    await db.execute(sql`
      INSERT INTO tw_call_event (tenant_id, tw_message_id, call_sid, event_type, status, duration_seconds, recording_url, legs, raw)
      VALUES (current_tenant(), ${messageId}, ${parsed.callSid}, ${eventTag}, ${parsed.status},
              ${parsed.durationSeconds}, ${parsed.recordingUrl},
              ${parsed.legs ? JSON.stringify(parsed.legs) : null}::jsonb,
              ${JSON.stringify(truncateRaw(parsed.raw))}::jsonb)
      ON CONFLICT (tw_message_id, event_type) DO NOTHING
    `);

    // Only write timeline + grant consent on the FIRST Passthru event so
    // one call = one activity row. `inserted` is truthy only on the first
    // hit; subsequent events for the same CallSid fall through here.
    if (inserted) {
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
                      : `Inbound call`,
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
    }
  });

  // Fire-and-forget recording backfill after the terminal event. Runs
  // outside the withTenant transaction because it depends on an external
  // HTTP call to Exotel and Node timers; we don't want a slow poll to
  // hold a DB connection open. Errors are logged; the primary flow above
  // already returned 200 to Exotel.
  if (messageIdForBackfill) {
    scheduleRecordingBackfill(tenantId, messageIdForBackfill, parsed.callSid);
  }
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

// ─── Recording backfill ──────────────────────────────────────────────────
// Exotel's Passthru never carries a real RecordingUrl — the recording is
// processed asynchronously after the call ends. We poll the Call Details
// API a few times (delayed schedule so the recording has time to appear)
// and attach the URL as an exotel_recording media_asset once it lands.
//
// Retry schedule: t+90s, t+5min, t+10min. If still not available after
// the last poll, we give up. Ops can manually re-run a fetch via the
// Twilio-style admin path or by re-firing the terminal event.
const BACKFILL_DELAYS_MS = [90_000, 5 * 60_000, 10 * 60_000];

function scheduleRecordingBackfill(tenantId: string, twMessageId: string, callSid: string): void {
  BACKFILL_DELAYS_MS.forEach((delay, i) => {
    setTimeout(() => {
      backfillRecording(tenantId, twMessageId, callSid, i + 1).catch((err) => {
        console.error(`[exotel-webhook] backfill attempt ${i + 1} error:`, (err as Error).message);
      });
    }, delay).unref();
  });
}

async function backfillRecording(
  tenantId: string,
  twMessageId: string,
  callSid: string,
  attempt: number,
): Promise<void> {
  // Skip if already attached.
  const already = await withTenant(tenantId, async (db) => {
    const r = await db.execute(sql`
      SELECT ma.blob_url FROM tw_message_media mm
      JOIN media_asset ma ON ma.id = mm.asset_id
      WHERE mm.message_id = ${twMessageId} AND ma.source = 'exotel_recording'
        AND ma.blob_url IS NOT NULL
        AND ma.blob_url != ''
      LIMIT 1
    `);
    return r.rows.length > 0;
  });
  if (already) {
    console.log(`[exotel-webhook] backfill attempt ${attempt}: recording already attached, skip`);
    return;
  }

  let details;
  try { details = await fetchCallDetails(callSid); }
  catch (e) {
    if (e instanceof ExotelNotConfigured) return;
    throw e;
  }
  if (!details) {
    console.log(`[exotel-webhook] backfill attempt ${attempt}: Call Details 404 for sid=${callSid}`);
    return;
  }
  if (!details.recordingUrl) {
    console.log(`[exotel-webhook] backfill attempt ${attempt}: no RecordingUrl yet for sid=${callSid} (status=${details.status})`);
    return;
  }

  console.log(`[exotel-webhook] backfill attempt ${attempt}: attaching recording for sid=${callSid}`);
  await withTenant(tenantId, async (db) => {
    // Insert the media_asset if we don't already have one — otherwise
    // update the existing null-url row in place.
    const existing = await db.execute(sql`
      SELECT ma.id FROM tw_message_media mm
      JOIN media_asset ma ON ma.id = mm.asset_id
      WHERE mm.message_id = ${twMessageId} AND ma.source = 'exotel_recording'
      LIMIT 1
    `);
    if (existing.rows.length > 0) {
      const id = (existing.rows[0] as { id: string }).id;
      await db.execute(sql`
        UPDATE media_asset SET blob_url = ${details.recordingUrl} WHERE id = ${id}
      `);
    } else {
      const assetR = await db.execute(sql`
        INSERT INTO media_asset (
          tenant_id, uploaded_by, filename,
          content_type, size_bytes, blob_url,
          is_library, source, provider_hosted
        )
        VALUES (
          current_tenant(), NULL,
          ${`call-${callSid}.mp3`},
          'audio/mpeg', 0, ${details.recordingUrl},
          false, 'exotel_recording', true
        )
        RETURNING id
      `);
      const assetId = (assetR.rows[0] as { id: string }).id;
      await db.execute(sql`
        INSERT INTO tw_message_media (message_id, asset_id, ordinal)
        VALUES (${twMessageId}, ${assetId}, 0)
      `);
    }
    // Also stamp the tw_call_event.terminal row with the URL if it exists.
    await db.execute(sql`
      UPDATE tw_call_event
      SET recording_url = ${details.recordingUrl},
          duration_seconds = COALESCE(${details.duration}, duration_seconds)
      WHERE tw_message_id = ${twMessageId} AND recording_url IS NULL
    `);
  });
}
