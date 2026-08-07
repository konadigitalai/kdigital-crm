// Campaign drip dispatcher.
//
// Per pass, per tenant:
//   1. Move any `scheduled` campaigns whose scheduled_at has passed into
//      `running` (and stamp started_at).
//   2. For each `running` campaign: fetch a small batch of `pending`
//      recipients — batch size = send_rate_per_sec * window_seconds — filter
//      through party_consent, resolve variables, call sendMessage(),
//      record tw_message rows, and update campaign_recipient.status.
//   3. When a campaign has 0 pending AND 0 sending recipients, flip it to
//      `completed` and stamp completed_at.
//
// The daily cap is enforced by counting sent_at::date rows for the
// campaign — a hit auto-pauses the campaign until midnight tenant-time.
// (We use server-local midnight here; a per-tenant timezone override is a
// future addition.)
//
// This was a `setInterval` living in the Express process. It is now invoked
// from a route handler — immediately on campaign launch/resume, and once a
// minute by cron. All state lives in the DB, which is why that swap was
// possible at all: no invocation needs to remember anything from the last one.
// See runCampaignDispatch below for the concurrency argument.

import { sql } from "drizzle-orm";
import { appPool, withTenant } from "../../db/app";
import {
  readTwilioConfig, sendMessage, TwilioNotConfigured,
} from "../twilio/client";
import { formatTwilioAddr } from "../twilio/phone";
import type { TwChannel } from "../twilio/phone";
import { filterConsentedRecipients } from "../party/consent";
import { resolveBindings, missingBindings, type RecipientContext } from "./variables";
import { recordOutbound, upsertConversation } from "../twilio/inbox";

const MAX_BATCH = 100;         // hard cap per pass per campaign regardless of rate

/**
 * Pacing window for one dispatch pass. Was WORKER_TICK_MS, the setInterval
 * period; it survives because batch size is `send_rate_per_sec × window`, so
 * this is what actually enforces send_rate_per_sec.
 */
const DISPATCH_WINDOW_MS = 5_000;

/**
 * How long one invocation keeps draining before handing back to the next cron
 * run. Under the 300s maxDuration with headroom for the final pass to finish
 * its Twilio calls.
 */
const DISPATCH_BUDGET_MS = Number(process.env.CAMPAIGN_DISPATCH_BUDGET_MS ?? 240_000);

/**
 * A recipient left in `sending` for longer than this had its invocation die
 * mid-flight. Nothing live holds a row that long: the claim uses
 * `FOR UPDATE … SKIP LOCKED` and the pre-send UPDATE is guarded on
 * `status = 'pending'`, so a row goes pending → sending → sent inside a single
 * dispatch. The age check is what makes the reap safe to run on every cron
 * invocation rather than only at boot — there is no longer a "boot" to hook.
 */
const STUCK_SENDING_MS = Number(process.env.CAMPAIGN_STUCK_SENDING_MS ?? 5 * 60_000);

/**
 * One dispatch pass: reap stragglers, then promote → dispatch → complete for
 * every tenant.
 *
 * This was a 5-second `setInterval`. It is now called from two places:
 *
 *   1. Immediately when a campaign is started or resumed (routes/campaigns.ts),
 *      so a send begins draining at once instead of waiting for a tick. That
 *      is FASTER than the old 5-second poll, not slower.
 *   2. Vercel Cron every minute (src/app/api/cron/campaigns/route.ts), which
 *      picks up scheduled campaigns whose time has come, retries anything the
 *      trigger path dropped, and reaps stuck rows.
 *
 * Safe to run concurrently with itself — the recipient claim is
 * `FOR UPDATE OF cr SKIP LOCKED`, so overlapping invocations take disjoint
 * batches. The old `ticking` flag existed to stop a single process overlapping
 * itself; it could not have coordinated across invocations anyway.
 */
export async function runCampaignDispatch(): Promise<void> {
  await reapAllStuckSending().catch((err) =>
    console.error("[campaign-worker] reap error:", (err as Error).message),
  );

  // Drain in a loop rather than doing one pass and returning.
  //
  // Batch size is `send_rate_per_sec × window`, which under the old
  // setInterval was rate × 5s, twelve times a minute. A single pass per cron
  // invocation would therefore have cut sustained throughput by 12× without
  // anything obviously breaking — a large campaign would simply have taken
  // half a day. Looping here at the same 5-second cadence reproduces the
  // original pacing (and so the same respect for send_rate_per_sec, which
  // exists to stay inside Twilio/WhatsApp limits) inside one invocation.
  const deadline = Date.now() + DISPATCH_BUDGET_MS;
  for (;;) {
    const dispatched = await tick();
    if (dispatched === 0) return;             // nothing left to do
    if (Date.now() >= deadline) {
      // Out of time, not out of work. The next cron invocation resumes from
      // the same queue — state lives entirely in campaign_recipient.
      console.log("[campaign-worker] budget reached with work remaining; deferring to next run");
      return;
    }
    await sleep(DISPATCH_WINDOW_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns how many recipients were dispatched, so the drain loop can stop. */
async function tick(): Promise<number> {
  // Load tenants once — reuses appPool without RLS since we only need ids.
  const client = await appPool.connect();
  let tenantIds: string[];
  try {
    const r = await client.query<{ id: string }>(`SELECT id FROM tenant`);
    tenantIds = r.rows.map((row) => row.id);
  } finally {
    client.release();
  }

  let dispatched = 0;
  for (const tenantId of tenantIds) {
    try {
      // promoteScheduled and completeIfDrained are pure SQL and stay in short
      // transactions. dispatchRunning manages its own, because it has to send
      // to Twilio between them — see the contract on withTenant in db/app.ts.
      await withTenant(tenantId, (db) => promoteScheduled(db));
      dispatched += await dispatchRunning(tenantId);
      await withTenant(tenantId, (db) => completeIfDrained(db));
    } catch (err) {
      console.error(`[campaign-worker] tenant ${tenantId}:`, (err as Error).message);
    }
  }
  return dispatched;
}

// ─── Reap rows stranded in 'sending' by a died-mid-flight invocation ──────
//
// Previously this ran once at boot and was explicitly forbidden during a tick:
// unqualified, it would move in-flight rows back to `pending` and re-send them,
// which means duplicate WhatsApp/SMS charges against real people.
//
// There is no boot to hook any more, so the guard moved into the query as an
// age check (STUCK_SENDING_MS). A row younger than that may still be in flight
// in a concurrent invocation and is left alone; a row older than that cannot
// be, because a dispatch never holds one that long.
async function reapAllStuckSending(): Promise<void> {
  const client = await appPool.connect();
  let tenantIds: string[];
  try {
    const r = await client.query<{ id: string }>(`SELECT id FROM tenant`);
    tenantIds = r.rows.map((row) => row.id);
  } finally {
    client.release();
  }
  for (const tenantId of tenantIds) {
    try {
      await withTenant(tenantId, async (db) => {
        const r = await db.execute(sql`
          UPDATE campaign_recipient
          SET status = 'pending', error_code = NULL, error_message = NULL,
              sending_at = NULL
          WHERE status = 'sending'
            AND sending_at IS NOT NULL
            AND sending_at < NOW() - (${STUCK_SENDING_MS}::text || ' milliseconds')::interval
          RETURNING id
        `);
        if (r.rows.length > 0) {
          console.log(`[campaign-worker] tenant ${tenantId}: reaped ${r.rows.length} stuck 'sending' rows`);
        }
      });
    } catch (err) {
      console.error(`[campaign-worker] reap tenant ${tenantId}:`, (err as Error).message);
    }
  }
}

// ─── Phase 1: scheduled → running ─────────────────────────────────────────
type Exec = { execute: (q: import("drizzle-orm").SQL) => Promise<{ rows: unknown[] }> };

async function promoteScheduled(db: Exec): Promise<void> {
  await db.execute(sql`
    UPDATE campaign
    SET status = 'running', started_at = COALESCE(started_at, NOW())
    WHERE status = 'scheduled'
      AND (scheduled_at IS NULL OR scheduled_at <= NOW())
  `);
}

// ─── Phase 2: dispatch a batch per running campaign ───────────────────────

interface CampaignRow {
  id:                       string;
  channel:                  string;
  contentSid:               string;
  contentVariableBindings:  Record<string, string>;
  sendRatePerSec:           number;
  dailyCap:                 number | null;
}

async function dispatchRunning(tenantId: string): Promise<number> {
  // Grab config once — same rules apply to every campaign.
  let cfg;
  try { cfg = readTwilioConfig(); }
  catch (e) {
    if (e instanceof TwilioNotConfigured) return 0; // stay quiet if not configured
    throw e;
  }

  const campaigns = await withTenant(tenantId, async (db) => {
    const cR = await db.execute(sql`
      SELECT
        id, channel,
        content_sid AS "contentSid",
        content_variable_bindings AS "contentVariableBindings",
        send_rate_per_sec         AS "sendRatePerSec",
        daily_cap                 AS "dailyCap"
      FROM campaign
      WHERE status = 'running'
    `);
    return cR.rows as unknown as CampaignRow[];
  });
  if (campaigns.length === 0) return 0;

  // Dispatched count drives the drain loop in runCampaignDispatch: a pass
  // that claims nothing means the queue is empty and looping can stop.
  let dispatched = 0;
  for (const c of campaigns) {
    // Daily cap check first — cheap and a hard stop.
    if (c.dailyCap != null) {
      const capped = await withTenant(tenantId, async (db) => {
        const dc = await db.execute(sql`
          SELECT COUNT(*)::int AS n
          FROM campaign_recipient
          WHERE campaign_id = ${c.id}
            AND sent_at IS NOT NULL
            AND sent_at::date = CURRENT_DATE
        `);
        const sentToday = Number((dc.rows[0] as { n: number })?.n ?? 0);
        if (sentToday < c.dailyCap!) return false;
        // Auto-pause; ops can resume manually or the caller can add a
        // per-day resume via a separate worker.
        await db.execute(sql`
          UPDATE campaign SET status = 'paused' WHERE id = ${c.id} AND status = 'running'
        `);
        return true;
      });
      if (capped) continue;
    }

    // Batch size = rate × window_seconds, capped. DISPATCH_WINDOW_MS is the
    // old setInterval period; the drain loop sleeps for exactly that between
    // passes, so send_rate_per_sec is enforced the same way it always was.
    const batchSize = Math.min(MAX_BATCH, Math.max(1, c.sendRatePerSec * (DISPATCH_WINDOW_MS / 1000)));

    // ── Claim phase ──────────────────────────────────────────────────────
    // One transaction: lock a batch, mark it 'sending', apply the consent and
    // variable gates, and COMMIT. Nothing here talks to Twilio.
    //
    // FOR UPDATE SKIP LOCKED is what makes the claim safe with more than one
    // worker running. Without it, two processes select the same pending rows
    // and both send — duplicate WhatsApp/SMS to real people, billed twice.
    // The status guard on the UPDATE below is the second half of that fence.
    const claimed = await withTenant(tenantId, async (db) => {
    // Pick pending recipients + hydrate the context we need for variable
    // resolution + the send call itself, all in one query.
    //
    // phone_country_code is joined in — many rows store the local number
    // in `phone` and the "+91" separately in `phone_country_code`. Sending
    // just `phone` yields "+7729887766" style unroutable numbers and
    // Twilio bounces with 63024. composeE164() below merges them.
    const rR = await db.execute(sql`
      SELECT
        cr.id           AS "recipientId",
        cr.party_id     AS "partyId",
        cr.work_item_id AS "workItemId",
        p.name          AS "partyName",
        p.phone         AS "partyPhoneRaw",
        p.phone_country_code AS "partyPhoneCc",
        p.email         AS "partyEmail",
        p.city          AS "partyCity",
        wi.number       AS "leadNumber",
        l.program       AS "leadProgram",
        l.stage         AS "leadStage"
      FROM campaign_recipient cr
      JOIN party p     ON p.id  = cr.party_id
      LEFT JOIN work_item wi ON wi.id = cr.work_item_id
      LEFT JOIN lead   l  ON l.work_item_id = wi.id
      WHERE cr.campaign_id = ${c.id}
        AND cr.status = 'pending'
      ORDER BY cr.queued_at ASC
      LIMIT ${batchSize}
      FOR UPDATE OF cr SKIP LOCKED
    `);
    const rawRows = rR.rows as Array<{
      recipientId: string; partyId: string; workItemId: string | null;
      partyName: string | null;
      partyPhoneRaw: string | null; partyPhoneCc: string | null;
      partyEmail: string | null; partyCity: string | null;
      leadNumber: string | null; leadProgram: string | null; leadStage: string | null;
    }>;
    const recipients = rawRows.map((r) => ({
      recipientId: r.recipientId, partyId: r.partyId, workItemId: r.workItemId,
      partyName: r.partyName,
      partyPhone: composeE164(r.partyPhoneCc, r.partyPhoneRaw),
      partyEmail: r.partyEmail, partyCity: r.partyCity,
      leadNumber: r.leadNumber, leadProgram: r.leadProgram, leadStage: r.leadStage,
    }));
    if (recipients.length === 0) return [];

    // Consent gate — one query for the whole batch.
    const channel: TwChannel = (c.channel === "whatsapp" ? "whatsapp" : "sms");
    const consented = await filterConsentedRecipients(
      db as unknown as { execute: typeof db.execute },
      channel,
      recipients.map((r) => r.partyId),
    );
    const allowedSet = new Set(consented.allowed);
    const blockedMap = new Map(consented.blocked.map((b) => [b.partyId, b.reason]));

    const ready: Array<{ rec: typeof recipients[number]; resolved: Record<string, string> }> = [];

    for (const rec of recipients) {
      // Consent skip
      if (!allowedSet.has(rec.partyId)) {
        const reason = blockedMap.get(rec.partyId) ?? "no_consent";
        await db.execute(sql`
          UPDATE campaign_recipient
          SET status = 'skipped_optout', error_message = ${reason}
          WHERE id = ${rec.recipientId}
        `);
        continue;
      }
      // No phone skip
      if (!rec.partyPhone) {
        await db.execute(sql`
          UPDATE campaign_recipient
          SET status = 'skipped_no_phone'
          WHERE id = ${rec.recipientId}
        `);
        continue;
      }

      // Resolve variables per recipient.
      const ctx: RecipientContext = {
        party: {
          id:    rec.partyId,
          name:  rec.partyName,
          phone: rec.partyPhone,
          email: rec.partyEmail,
          city:  rec.partyCity,
        },
        lead: {
          workItemId: rec.workItemId ?? "",
          number:     rec.leadNumber ?? "",
          program:    rec.leadProgram,
          stage:      rec.leadStage,
        },
      };
      const resolved = resolveBindings(c.contentVariableBindings ?? {}, ctx);
      const missing = missingBindings(resolved);
      if (missing.length > 0) {
        await db.execute(sql`
          UPDATE campaign_recipient
          SET status = 'failed',
              error_code    = 'missing_variables',
              error_message = ${'Missing values: ' + missing.join(", ")},
              resolved_variables = ${JSON.stringify(resolved)}::jsonb
          WHERE id = ${rec.recipientId}
        `);
        continue;
      }

      // Mark sending BEFORE the network call so a crash mid-flight doesn't
      // leave the recipient in `pending` forever (we'd double-send on
      // restart).
      //
      // The `AND status = 'pending'` guard is the other half of the
      // SKIP LOCKED fence above: if a concurrent worker somehow got there
      // first, this updates 0 rows and we drop the recipient from the batch
      // rather than sending twice.
      // sending_at stamps WHEN the claim happened. The reap uses it to tell a
      // row still in flight in a concurrent invocation from one whose
      // invocation died — see STUCK_SENDING_MS.
      const claimRes = await db.execute(sql`
        UPDATE campaign_recipient
        SET status = 'sending',
            sending_at = NOW(),
            resolved_variables = ${JSON.stringify(resolved)}::jsonb
        WHERE id = ${rec.recipientId} AND status = 'pending'
        RETURNING id
      `);
      if (claimRes.rows.length === 0) continue;

      ready.push({ rec, resolved });
    }

    return ready;
    });

    if (claimed.length === 0) continue;
    dispatched += claimed.length;

    // ── Send phase ───────────────────────────────────────────────────────
    // No transaction held. Every recipient here is already marked 'sending'
    // and committed, so a crash from this point leaves rows in 'sending' —
    // exactly what the boot sweep reaps.
    const channel: TwChannel = (c.channel === "whatsapp" ? "whatsapp" : "sms");
    const from = channel === "whatsapp" ? cfg.waFrom : cfg.smsFrom;

    for (const { rec, resolved } of claimed) {
      let send;
      try {
        send = await sendMessage(channel, rec.partyPhone!, "", cfg, {
          contentSid: c.contentSid,
          contentVariables: resolved,
        });
      } catch (err) {
        await withTenant(tenantId, (db) => db.execute(sql`
          UPDATE campaign_recipient
          SET status = 'failed', error_code = 'exception',
              error_message = ${(err as Error).message.slice(0, 300)}
          WHERE id = ${rec.recipientId}
        `));
        continue;
      }

      // ── Record phase ───────────────────────────────────────────────────
      // Per recipient, so one bad row can't roll back a batch of sends that
      // already left. Twilio has the message either way.
      await withTenant(tenantId, async (db) => {
        const conv = await upsertConversation(
          // The upsert helper takes a Drizzle db; withTenant already gave us
          // one — cast through unknown to satisfy the interface.
          db as unknown as import("../twilio/inbox").DbExec,
          rec.partyId, channel, rec.workItemId == null,
        );
        const msgId = await recordOutbound(
          db as unknown as import("../twilio/inbox").DbExec,
          conv.id,
          {
            channel,
            fromE164: from,
            toE164:   rec.partyPhone!,
            body:     "",
            senderUserPartyId: null,
            contentSid: c.contentSid,
            contentVariables: resolved,
            campaignId: c.id,
            send,
          },
        );

        if (send.ok) {
          await db.execute(sql`
            UPDATE campaign_recipient
            SET status = 'sent', tw_message_id = ${msgId}, sent_at = NOW()
            WHERE id = ${rec.recipientId}
          `);
        } else {
          await db.execute(sql`
            UPDATE campaign_recipient
            SET status = 'failed', tw_message_id = ${msgId},
                error_code    = ${send.errorCode ?? 'send_failed'},
                error_message = ${send.errorMessage ?? 'unknown error'}
            WHERE id = ${rec.recipientId}
          `);
        }
      });
    }
  }
  return dispatched;
}

// ─── Phase 3: mark completed when the queue is drained ────────────────────

async function completeIfDrained(db: Exec): Promise<void> {
  await db.execute(sql`
    UPDATE campaign c
    SET status = 'completed', completed_at = NOW()
    WHERE c.status = 'running'
      AND NOT EXISTS (
        SELECT 1 FROM campaign_recipient cr
        WHERE cr.campaign_id = c.id AND cr.status IN ('pending','sending')
      )
  `);
}

/** Combine (phone_country_code, phone) into E.164, matching the shape
 *  composePartyPhone() uses in routes/twilio.ts. Some rows have the "+91"
 *  baked into `phone` (legacy imports) and a null cc; others split them.
 *  Returns null if the result would obviously not be routable. */
function composeE164(cc: string | null, phone: string | null): string | null {
  const rawPhone = (phone ?? "").trim();
  if (!rawPhone) return null;
  const phoneDigits = rawPhone.replace(/\D/g, "");
  if (rawPhone.startsWith("+") && phoneDigits.length > 10) {
    return `+${phoneDigits}`;
  }
  const ccDigits = (cc ?? "").replace(/\D/g, "");
  if (ccDigits) return `+${ccDigits}${phoneDigits}`;
  // 10-digit bare number with no country code — this is the case that
  // was producing "+7729887766" and Twilio 63024. Assume India (+91)
  // when the phone has exactly 10 digits and looks Indian-mobile-shaped
  // (starts 6-9). Anything else, refuse — the worker will mark the
  // recipient skipped_no_phone rather than sending garbage.
  if (phoneDigits.length === 10 && /^[6-9]/.test(phoneDigits)) {
    return `+91${phoneDigits}`;
  }
  return null;
}
