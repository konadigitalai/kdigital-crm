// Centralised agent_run bookkeeping. Each invocation:
//   1. Mints a RUN-NNNN work_item + agent_run row in `running` state.
//   2. Calls the agent's body() with mutable `steps` so it can mark progress.
//   3. On success: agent_run.status = 'completed', work_item.state = 'completed'.
//   4. On failure: agent_run.status = 'failed', appends error to steps.
//
// Returns whatever body() returned. Throws if body() throws.

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import { withTenant, appPool } from "../db/app.js";

export type StepState = "queued" | "active" | "done" | "failed";
export interface RunStep {
  label: string;
  state: StepState;
  detail?: string;
}

export interface RunContext {
  /** Mutate `steps` while you work; the final array is persisted on completion. */
  steps: RunStep[];
  /** Mark a step active (and the previous one done). */
  beginStep: (label: string) => void;
  /** Mark the in-flight step done with optional detail. */
  endStep: (detail?: string) => void;
  /** The Drizzle handle scoped to the request tenant. */
  db: NodePgDatabase<typeof schema>;
  /** UUID of the agent_run.work_item_id. */
  workItemId: string;
}

export interface RunOpts<T> {
  tenantId: string;
  agentKey: string;
  /** Human-readable target shown in cards: "drafting for Aarav Mehta", etc. */
  target: string;
  /** Initial steps; each will be flipped active → done as the body progresses. */
  steps: RunStep[];
  /** Optional: link this run to a parent work item (e.g. the lead being scored). */
  parentWorkItemId?: string | null;
  body: (ctx: RunContext) => Promise<T>;
}

async function nextRunNumber(): Promise<string> {
  const r = await appPool.query<{ n: string }>(`SELECT nextval('seq_run')::text AS n`);
  return `RUN-${r.rows[0]!.n}`;
}

export async function runAgent<T>(opts: RunOpts<T>): Promise<{ result: T; runWorkItemId: string }> {
  const number = await nextRunNumber();

  return await withTenant(opts.tenantId, async (db) => {
    // Open the run row.
    const wi = await db.execute(sql`
      INSERT INTO work_item (tenant_id, number, type, state)
      VALUES (${opts.tenantId}, ${number}, 'agent_run', 'running')
      RETURNING id
    `);
    const runWorkItemId = (wi.rows[0] as { id: string }).id;

    await db.execute(sql`
      INSERT INTO agent_run (
        work_item_id, tenant_id, agent_key, run_id, status,
        target, live, steps, started_at
      ) VALUES (
        ${runWorkItemId}, ${opts.tenantId}, ${opts.agentKey}, ${number},
        'running', ${opts.target}, true,
        ${JSON.stringify(opts.steps)}::jsonb, NOW()
      )
    `);

    // Mutable working copy.
    const steps = opts.steps.map((s) => ({ ...s }));
    const ctx: RunContext = {
      steps,
      db,
      workItemId: runWorkItemId,
      beginStep: (label) => {
        // Mark previous active → done.
        for (const s of steps) if (s.state === "active") s.state = "done";
        const idx = steps.findIndex((s) => s.label === label);
        if (idx >= 0) steps[idx]!.state = "active";
        else steps.push({ label, state: "active" });
      },
      endStep: (detail) => {
        for (const s of steps) {
          if (s.state === "active") {
            s.state = "done";
            if (detail) s.detail = detail;
          }
        }
      },
    };

    try {
      const result = await opts.body(ctx);
      // Final state: complete any lingering active step.
      for (const s of steps) if (s.state === "active") s.state = "done";

      await db.execute(sql`
        UPDATE agent_run SET
          status = 'completed',
          live = false,
          steps = ${JSON.stringify(steps)}::jsonb,
          finished_at = NOW()
        WHERE work_item_id = ${runWorkItemId}
      `);
      await db.execute(sql`
        UPDATE work_item SET state = 'completed' WHERE id = ${runWorkItemId}
      `);
      return { result, runWorkItemId };
    } catch (err) {
      // Mark active step failed; record error detail.
      const message = (err as Error).message ?? String(err);
      for (const s of steps) if (s.state === "active") {
        s.state = "failed";
        s.detail = message.slice(0, 200);
      }
      await db.execute(sql`
        UPDATE agent_run SET
          status = 'failed',
          live = false,
          steps = ${JSON.stringify(steps)}::jsonb,
          finished_at = NOW()
        WHERE work_item_id = ${runWorkItemId}
      `);
      await db.execute(sql`
        UPDATE work_item SET state = 'failed' WHERE id = ${runWorkItemId}
      `);
      throw err;
    }
  });
}
