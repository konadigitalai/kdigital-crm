// Campaign trigger evaluator — runs after a lead mutation completes and
// decides whether any enabled trigger should fire for the affected party.
//
// A trigger's `condition` is a small map: matching fields on the event
// payload with strict equality. We deliberately keep the condition schema
// simple — anything complex belongs in a campaign filter, not a trigger.
//
// Firing a trigger:
//   1. Insert (or update) an auto-campaign row so the worker/campaign
//      list can display trigger activity in one place. Auto-campaigns
//      are created lazily and cached on campaign_trigger.auto_campaign_id.
//   2. Insert a campaign_recipient row for this party (ON CONFLICT DO
//      NOTHING — one party queues once per cooldown window).
//   3. Log a campaign_trigger_fire row for audit + cooldown enforcement.
//
// Everything after this is the existing campaign worker's job.

import { sql, type SQL } from "drizzle-orm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Exec = { execute: (q: SQL) => Promise<any> };

export type TriggerEvent =
  | { type: "lead.stage_changed";   partyId: string; workItemId: string | null; from: string | null; to: string | null }
  | { type: "lead.created";         partyId: string; workItemId: string | null; source?: string | null }
  | { type: "lead.rating_changed";  partyId: string; workItemId: string | null; from: string | null; to: string | null };

interface TriggerRow {
  id:               string;
  name:             string;
  contentSid:       string;
  variableBindings: Record<string, string>;
  eventType:        string;
  condition:        Record<string, unknown>;
  cooldownHours:    number;
  autoCampaignId:   string | null;
}

/** Evaluate every enabled trigger for this event and fire the matching ones. */
export async function evaluateTriggers(
  db: Exec,
  event: TriggerEvent,
): Promise<{ fired: number }> {
  const tR = await db.execute(sql`
    SELECT
      id, name, content_sid AS "contentSid",
      variable_bindings AS "variableBindings",
      event_type        AS "eventType",
      condition,
      cooldown_hours    AS "cooldownHours",
      auto_campaign_id  AS "autoCampaignId"
    FROM campaign_trigger
    WHERE enabled = true AND event_type = ${event.type}
  `);
  const triggers = tR.rows as TriggerRow[];
  if (triggers.length === 0) return { fired: 0 };

  let fired = 0;
  for (const trg of triggers) {
    if (!matchesCondition(trg.condition, event)) continue;

    // Cooldown gate — has this trigger fired for this party inside the
    // window?
    const c = await db.execute(sql`
      SELECT 1
      FROM campaign_trigger_fire
      WHERE trigger_id = ${trg.id}
        AND party_id   = ${event.partyId}
        AND fired_at   > NOW() - (INTERVAL '1 hour' * ${trg.cooldownHours})
      LIMIT 1
    `);
    if (c.rows.length > 0) continue;

    const autoCampaignId = await ensureAutoCampaign(db, trg);

    // ON CONFLICT DO NOTHING — a race that would have inserted twice for
    // the same party is a no-op.
    const rR = await db.execute(sql`
      INSERT INTO campaign_recipient (tenant_id, campaign_id, party_id, work_item_id, status)
      VALUES (current_tenant(), ${autoCampaignId}::uuid, ${event.partyId}::uuid,
              ${event.workItemId}::uuid, 'pending')
      ON CONFLICT (campaign_id, party_id) DO NOTHING
      RETURNING id
    `);
    const recipientId = (rR.rows[0] as { id?: string } | undefined)?.id ?? null;

    await db.execute(sql`
      INSERT INTO campaign_trigger_fire (tenant_id, trigger_id, party_id, work_item_id, recipient_id, outcome)
      VALUES (current_tenant(), ${trg.id}, ${event.partyId}, ${event.workItemId},
              ${recipientId}, ${recipientId ? 'queued' : 'duplicate'})
    `);

    // Bump the auto-campaign to `running` if it's still `draft` so the
    // worker picks up the new recipient on the next tick.
    await db.execute(sql`
      UPDATE campaign
      SET status = 'running', started_at = COALESCE(started_at, NOW())
      WHERE id = ${autoCampaignId}
        AND status IN ('draft','scheduled','paused','completed')
    `);

    if (recipientId) fired++;
  }
  return { fired };
}

/** Ensure an auto-campaign row exists for this trigger. Cached on the
 *  trigger row so subsequent fires reuse it. Concurrent events for the
 *  same trigger race here — we serialize with SELECT ... FOR UPDATE on
 *  the trigger row so only the first winner creates a campaign; the
 *  losers read the cached id back on their next SELECT. */
async function ensureAutoCampaign(db: Exec, trg: TriggerRow): Promise<string> {
  if (trg.autoCampaignId) return trg.autoCampaignId;

  // Re-read the trigger row under a row-level lock. If another event was
  // ahead of us, its INSERT + UPDATE already committed (or is queued
  // ahead), so `locked.autoCampaignId` will be non-null.
  const lockedR = await db.execute(sql`
    SELECT auto_campaign_id AS "autoCampaignId"
    FROM campaign_trigger
    WHERE id = ${trg.id}
    FOR UPDATE
  `);
  const locked = lockedR.rows[0] as { autoCampaignId: string | null } | undefined;
  if (locked?.autoCampaignId) return locked.autoCampaignId;

  const r = await db.execute(sql`
    INSERT INTO campaign (
      tenant_id, name, channel, content_sid,
      content_variable_bindings, audience,
      status, send_rate_per_sec
    )
    VALUES (
      current_tenant(),
      ${`auto: ${trg.name}`},
      'whatsapp',
      ${trg.contentSid},
      ${JSON.stringify(trg.variableBindings)}::jsonb,
      '{}'::jsonb,
      'running',
      5
    )
    RETURNING id
  `);
  const newId = (r.rows[0] as { id: string }).id;
  await db.execute(sql`
    UPDATE campaign_trigger SET auto_campaign_id = ${newId}, updated_at = NOW() WHERE id = ${trg.id}
  `);
  return newId;
}

/** Strict-equality check across every condition key. Missing keys on the
 *  event mean the condition doesn't match. */
function matchesCondition(
  condition: Record<string, unknown>,
  event: TriggerEvent,
): boolean {
  if (!condition || Object.keys(condition).length === 0) return true;
  const payload: Record<string, unknown> = event as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(condition)) {
    if (String(payload[k] ?? "") !== String(v ?? "")) return false;
  }
  return true;
}
