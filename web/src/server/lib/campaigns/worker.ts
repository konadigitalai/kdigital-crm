// Campaign drip worker.
//
// setInterval-based; wakes every WORKER_TICK_MS. Per tick, per tenant:
//   1. Move any `scheduled` campaigns whose scheduled_at has passed into
//      `running` (and stamp started_at).
//   2. For each `running` campaign: fetch a small batch of `pending`
//      recipients — batch size = send_rate_per_sec * tick_seconds — filter
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
// Follows the same shape as api/src/lib/party/dedup-worker.ts — plain
// setInterval + a per-tick guard so ticks never overlap. Dies with the
// process; a redeploy resumes cleanly because state lives in DB.

import { sql } from "drizzle-orm";
import { appPool, withTenant } from "../../db/app.js";
import {
  readTwilioConfig, sendMessage, TwilioNotConfigured,
} from "../twilio/client.js";
import { formatTwilioAddr } from "../twilio/phone.js";
import type { TwChannel } from "../twilio/phone.js";
import { filterConsentedRecipients } from "../party/consent.js";
import { resolveBindings, missingBindings, type RecipientContext } from "./variables.js";
import { recordOutbound, upsertConversation } from "../twilio/inbox.js";

const WORKER_TICK_MS = 5_000; // 5 seconds
const MAX_BATCH = 100;         // hard cap per tick per campaign regardless of rate

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startCampaignWorker(): void {
  if (timer) return;
  // Boot: sweep anything left in `sending` from a prior process. `withTenant`
  // wraps a transaction, so an in-tick crash rolls back the pre-send UPDATE
  // as well as the post-send one. The only way a `sending` row survives is
  // if the process died between COMMIT of the pre-send UPDATE and COMMIT of
  // the post-send UPDATE — a small window, but exists. Boot-sweep only —
  // never sweep during a tick, else we'd move in-flight rows back to pending.
  reapAllStuckSending().catch((err) =>
    console.error("[campaign-worker] boot reap error:", (err as Error).message),
  );
  tick().catch((err) =>
    console.error("[campaign-worker] boot tick error:", (err as Error).message),
  );
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    tick()
      .catch((err) => console.error("[campaign-worker] tick error:", (err as Error).message))
      .finally(() => { ticking = false; });
  }, WORKER_TICK_MS);
  console.log(`[campaign-worker] started (every ${WORKER_TICK_MS}ms)`);
}

export function stopCampaignWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

async function tick(): Promise<void> {
  // Load tenants once — reuses appPool without RLS since we only need ids.
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
      // promoteScheduled and completeIfDrained are pure SQL and stay in short
      // transactions. dispatchRunning manages its own, because it has to send
      // to Twilio between them — see the contract on withTenant in db/app.ts.
      await withTenant(tenantId, (db) => promoteScheduled(db));
      await dispatchRunning(tenantId);
      await withTenant(tenantId, (db) => completeIfDrained(db));
    } catch (err) {
      console.error(`[campaign-worker] tenant ${tenantId}:`, (err as Error).message);
    }
  }
}

// ─── Boot sweep: reap rows stuck in 'sending' from a prior process ────────
// setInterval + `withTenant` means every dispatch tick runs inside its own
// short transaction. A crash inside the tick rolls back the pre-send UPDATE,
// so `sending` can only survive a crash between the tick's COMMIT and the
// next tick — a small window that only matters across process restarts.
// Sweep once on boot, never during a tick (that would move in-flight rows
// backward and cause duplicate Twilio charges).
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
          SET status = 'pending', error_code = NULL, error_message = NULL
          WHERE status = 'sending'
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

async function dispatchRunning(tenantId: string): Promise<void> {
  // Grab config once — same rules apply to every campaign.
  let cfg;
  try { cfg = readTwilioConfig(); }
  catch (e) {
    if (e instanceof TwilioNotConfigured) return; // stay quiet if not configured
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
  if (campaigns.length === 0) return;

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

    // Batch size = rate × tick_seconds, capped
    const batchSize = Math.min(MAX_BATCH, Math.max(1, c.sendRatePerSec * (WORKER_TICK_MS / 1000)));

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
      const claimRes = await db.execute(sql`
        UPDATE campaign_recipient
        SET status = 'sending', resolved_variables = ${JSON.stringify(resolved)}::jsonb
        WHERE id = ${rec.recipientId} AND status = 'pending'
        RETURNING id
      `);
      if (claimRes.rows.length === 0) continue;

      ready.push({ rec, resolved });
    }

    return ready;
    });

    if (claimed.length === 0) continue;

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
          db as unknown as import("../twilio/inbox.js").DbExec,
          rec.partyId, channel, rec.workItemId == null,
        );
        const msgId = await recordOutbound(
          db as unknown as import("../twilio/inbox.js").DbExec,
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
