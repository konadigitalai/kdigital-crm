/**
 * Broadcast worker — sends queued recipients for any wa_broadcast in
 * 'sending' status, one tenant + broadcast at a time.
 *
 * Runs in-process via a setInterval scheduled from index.ts boot. v1
 * volume is small (a few hundred recipients per broadcast at most); if
 * we ever cross ~1000/min we'd graduate this to a separate worker
 * dyno + a real queue.
 *
 * Rate-limit shape: Meta phone-number tier 1 = 1000 unique recipients
 * per 24h, tier 2 = 10K, tier 3 = 100K. We don't try to be clever — a
 * sleep of 250ms between sends ≈ 4/sec ≈ 240/min ≈ 14400/hr, well
 * inside even tier 1 limits and unlikely to trip Meta's per-second
 * cap. If broadcasts grow we'll do proper bucketing.
 *
 * Idempotency: a recipient row is "claimed" by atomically transitioning
 * status='pending' → status='sending' (set sent_at=NOW()) inside the
 * same SELECT … FOR UPDATE. After Meta returns we flip to 'sent' or
 * 'failed'. If the worker crashes between claim and Meta response, the
 * row sits at 'sending' forever — we sweep these into 'failed' on
 * worker restart so the broadcast can complete.
 *
 * Concurrency: only one worker tick is in-flight at a time per process.
 * Multiple Render replicas would race, but we have one node today.
 */

import { sql } from "drizzle-orm";
import { appPool, withTenant } from "../../db/app.js";
import { readMetaCreds, renderTemplateBody, sendTemplate } from "./meta.js";

const SEND_INTERVAL_MS = 250;          // ~4 sends/sec
const TICK_INTERVAL_MS = 5_000;         // poll for new work every 5s
const STALE_SENDING_AFTER_MS = 60_000;  // any 'sending' row older than 1min is recovered to 'failed'

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** Start the broadcast worker. Idempotent — calling twice is a no-op. */
export function startBroadcastWorker(): void {
  if (timer) return;
  // Sweep any leftover 'sending' rows from a prior crash before starting.
  recoverStaleSending().catch((err) =>
    console.error("[wa-broadcast-worker] sweep error:", (err as Error).message),
  );
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    tick()
      .catch((err) => console.error("[wa-broadcast-worker] tick error:", (err as Error).message))
      .finally(() => { ticking = false; });
  }, TICK_INTERVAL_MS);
  console.log("[wa-broadcast-worker] started");
}

export function stopBroadcastWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

// ─── Sweep recovery on boot ───────────────────────────────────────────────
//
// Cross-tenant query. RLS allows when current_tenant() is null.
async function recoverStaleSending(): Promise<void> {
  const client = await appPool.connect();
  try {
    const r = await client.query<{ count: string }>(
      `UPDATE wa_broadcast_recipient
          SET status = 'failed',
              error_message = COALESCE(error_message, 'recovered from stale sending state on worker restart')
        WHERE status = 'sending'
          AND queued_at < NOW() - INTERVAL '${STALE_SENDING_AFTER_MS / 1000} seconds'
        RETURNING id`,
    );
    if (r.rows.length > 0) {
      console.warn(`[wa-broadcast-worker] recovered ${r.rows.length} stale 'sending' rows`);
    }
  } finally {
    client.release();
  }
}

// ─── Tick — find one broadcast to drain a chunk of ────────────────────────

async function tick(): Promise<void> {
  // Find one (tenant_id, broadcast_id) pair with pending recipients +
  // status='sending' (or 'scheduled' whose scheduled_at has arrived).
  // We start a broadcast (scheduled → sending, started_at=NOW()) inside
  // the worker so the API doesn't need to know the worker is up.
  const client = await appPool.connect();
  let pick: { tenant_id: string; broadcast_id: string } | null = null;
  try {
    // Promote scheduled broadcasts whose scheduled_at has passed.
    await client.query(
      `UPDATE wa_broadcast
          SET status = 'sending', started_at = COALESCE(started_at, NOW())
        WHERE status = 'scheduled'
          AND scheduled_at IS NOT NULL
          AND scheduled_at <= NOW()`,
    );

    const r = await client.query<{ tenant_id: string; broadcast_id: string }>(
      `SELECT b.tenant_id, b.id AS broadcast_id
         FROM wa_broadcast b
         JOIN wa_broadcast_recipient r
           ON r.broadcast_id = b.id AND r.status = 'pending'
        WHERE b.status = 'sending'
        GROUP BY b.tenant_id, b.id
        ORDER BY MIN(r.queued_at)
        LIMIT 1`,
    );
    pick = r.rows[0] ?? null;
  } finally {
    client.release();
  }

  if (!pick) {
    // No active broadcasts. Also check if any 'sending' broadcast is now
    // fully done — if so, mark it completed.
    await sweepCompleted();
    return;
  }

  // Drain ~20 recipients from this broadcast. Rate-limit between sends.
  await drainBroadcast(pick.tenant_id, pick.broadcast_id, 20);
  // Also see if it's done.
  await sweepCompleted();
}

async function drainBroadcast(tenantId: string, broadcastId: string, batchSize: number): Promise<void> {
  await withTenant(tenantId, async (db) => {
    // Load creds once.
    const cfgR = await db.execute(sql`
      SELECT phone_number_id, waba_id, app_id, app_secret,
             system_user_token, webhook_verify_token,
             status AS "configStatus"
      FROM wa_config LIMIT 1
    `);
    const cfg = cfgR.rows[0] as Record<string, unknown> | undefined;
    const creds = readMetaCreds(cfg);
    if (!creds || cfg?.configStatus !== "connected") {
      // Mark broadcast failed — config disappeared mid-run.
      await db.execute(sql`
        UPDATE wa_broadcast SET status = 'failed', finished_at = NOW()
        WHERE id = ${broadcastId} AND status = 'sending'
      `);
      return;
    }

    // Load template body + name.
    const tplR = await db.execute(sql`
      SELECT t.template_name AS "templateName", t.language, t.body_text AS "bodyText",
             t.variable_count AS "variableCount", t.status,
             b.default_variables AS "defaultVariables"
      FROM wa_broadcast b
      JOIN wa_template t ON t.id = b.template_id
      WHERE b.id = ${broadcastId}
    `);
    const tpl = tplR.rows[0] as
      | {
          templateName: string; language: string; bodyText: string;
          variableCount: number; status: string;
          defaultVariables: Record<string, unknown> | null;
        }
      | undefined;
    if (!tpl) {
      console.error(`[wa-broadcast-worker] template missing for broadcast ${broadcastId}`);
      await db.execute(sql`
        UPDATE wa_broadcast SET status = 'failed', finished_at = NOW()
        WHERE id = ${broadcastId}
      `);
      return;
    }
    if (tpl.status !== "approved") {
      // Template was paused / rejected mid-flight. Mark broadcast failed.
      await db.execute(sql`
        UPDATE wa_broadcast SET status = 'failed', finished_at = NOW()
        WHERE id = ${broadcastId}
      `);
      return;
    }

    // Claim a batch atomically.
    const claimR = await db.execute(sql`
      WITH claimed AS (
        SELECT id FROM wa_broadcast_recipient
        WHERE broadcast_id = ${broadcastId} AND status = 'pending'
        ORDER BY queued_at
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE wa_broadcast_recipient r
        SET status = 'sending'
        FROM claimed
        WHERE r.id = claimed.id
        RETURNING r.id, r.to_phone AS "toPhone", r.variables, r.party_id AS "partyId"
    `);
    const batch = claimR.rows as Array<{
      id: string;
      toPhone: string;
      variables: Record<string, string> | null;
      partyId: string | null;
    }>;
    if (batch.length === 0) return;

    for (const row of batch) {
      // Merge default + per-recipient variables, positional 1..N.
      const merged = { ...(tpl.defaultVariables ?? {}), ...(row.variables ?? {}) } as Record<string, unknown>;
      const variableArr: string[] = [];
      for (let i = 1; i <= tpl.variableCount; i++) {
        const v = merged[String(i)];
        variableArr.push(typeof v === "string" ? v : v == null ? "" : String(v));
      }
      const rendered = renderTemplateBody(tpl.bodyText, variableArr);

      const send = await sendTemplate({
        creds,
        to: row.toPhone,
        templateName: tpl.templateName,
        language: tpl.language,
        variables: variableArr,
      });

      if (send.ok) {
        await db.execute(sql`
          UPDATE wa_broadcast_recipient
            SET status = 'sent',
                provider_message_id = ${send.messageId ?? null},
                sent_at = NOW(),
                error_code = NULL,
                error_message = NULL
            WHERE id = ${row.id}
        `);
      } else {
        await db.execute(sql`
          UPDATE wa_broadcast_recipient
            SET status = 'failed',
                error_code = ${send.errorCode ?? null},
                error_message = ${send.error ?? "send failed"},
                sent_at = NOW()
            WHERE id = ${row.id}
        `);
      }

      // Also append a wa_message row to the party's conversation if we
      // know who they are — so the inbox shows the broadcast in their
      // thread.
      if (row.partyId && send.ok) {
        try {
          await appendBroadcastMessageToConversation(db, {
            partyId: row.partyId,
            providerMessageId: send.messageId ?? null,
            templateName: tpl.templateName,
            renderedBody: rendered,
            templateVariables: variableArr.length > 0
              ? Object.fromEntries(variableArr.map((v, i) => [String(i + 1), v]))
              : null,
          });
        } catch (err) {
          console.error("[wa-broadcast-worker] thread append error:", (err as Error).message);
        }
      }

      await sleep(SEND_INTERVAL_MS);
    }
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function appendBroadcastMessageToConversation(db: any, args: {
  partyId: string;
  providerMessageId: string | null;
  templateName: string;
  renderedBody: string;
  templateVariables: Record<string, string> | null;
}): Promise<void> {
  // Upsert the conversation, then insert a wa_message into it. Mirrors
  // the per-record sendManual path in routes/whatsapp.ts (we don't share
  // recordOutbound here because that path also bumps last_message_at +
  // last_message_text, which we still want).
  const convR = await db.execute(sql`
    INSERT INTO wa_conversation (tenant_id, party_id)
    VALUES (current_tenant(), ${args.partyId})
    ON CONFLICT (tenant_id, party_id) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `);
  const conversationId = (convR.rows[0] as { id: string }).id;

  await db.execute(sql`
    INSERT INTO wa_message (
      tenant_id, conversation_id, direction, sender_type,
      content_type, body, template_name, template_variables,
      provider_message_id, status
    )
    VALUES (
      current_tenant(), ${conversationId}, 'outbound', 'system',
      'template', ${args.renderedBody},
      ${args.templateName},
      ${args.templateVariables ? sql`${JSON.stringify(args.templateVariables)}::jsonb` : sql`NULL`},
      ${args.providerMessageId},
      'sent'
    )
  `);

  await db.execute(sql`
    UPDATE wa_conversation
      SET last_message_text = ${args.renderedBody.slice(0, 240)},
          last_message_at = NOW(),
          updated_at = NOW()
    WHERE id = ${conversationId}
  `);
}

// ─── Sweep completed broadcasts ──────────────────────────────────────────
// A broadcast is "completed" when no recipients are pending or sending.
async function sweepCompleted(): Promise<void> {
  const client = await appPool.connect();
  try {
    await client.query(
      `UPDATE wa_broadcast b
          SET status = 'completed', finished_at = COALESCE(finished_at, NOW())
        WHERE b.status = 'sending'
          AND NOT EXISTS (
            SELECT 1 FROM wa_broadcast_recipient r
            WHERE r.broadcast_id = b.id
              AND r.status IN ('pending', 'sending')
          )`,
    );
  } finally {
    client.release();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
