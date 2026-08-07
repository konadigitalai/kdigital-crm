// LangGraph runtime — bridges a CompiledStateGraph to the existing
// agent_run/work_item bookkeeping the rest of the app reads.
//
// Each runWithGraph() call:
//   1. Mints a RUN-NNNN work_item + agent_run row in `running` state with one
//      `queued` step per graph node.
//   2. Invokes graph.stream(...) under withTenant() so node functions execute
//      against the RLS-scoped Drizzle handle. The handle + tenantId travel via
//      RunnableConfig.configurable (NOT state) because the Postgres
//      checkpointer would otherwise try to serialize them.
//   3. After every node completes, flips its step `done` and writes the JSONB.
//   4. On terminal state: agent_run.status='completed' and work_item.state
//      flipped accordingly. On error: 'failed' + error detail on the in-flight
//      step.
//
// The existing UI surface (agent cards, sidebar Recent runs, StepStrip) reads
// agent_run.{status,steps,live,target,started_at,finished_at} unchanged.

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { CompiledStateGraph } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import * as schema from "../db/schema";
import { withTenant, appPool, tenantExec } from "../db/app";

export type StepState = "queued" | "active" | "done" | "failed";
export interface RunStep {
  label: string;
  state: StepState;
  detail?: string;
}

/**
 * The database surface handed to agent nodes.
 *
 * Deliberately narrowed to `execute` — that is all any node has ever used
 * (61 call sites across the six agents) and the narrowing is what lets us
 * swap the long-lived transaction handle for the per-statement one below
 * without touching a single agent file.
 */
export type AgentDb = Pick<NodePgDatabase<typeof schema>, "execute">;

// Configurable context every agent node can read via its (state, config) args.
// Non-serializable on purpose — the Postgres checkpointer never sees these.
export interface AgentConfigurable {
  db: AgentDb;
  tenantId: string;
  runWorkItemId: string;
}

/** Helper for nodes: pull the typed configurable bag out of a RunnableConfig. */
export function configurable(config: RunnableConfig | undefined): AgentConfigurable {
  const c = config?.configurable as Partial<AgentConfigurable> | undefined;
  if (!c?.db || !c.tenantId || !c.runWorkItemId) {
    throw new Error("Agent node invoked without db/tenantId/runWorkItemId in configurable");
  }
  return c as AgentConfigurable;
}

export interface RunWithGraphOpts<S extends object, R> {
  tenantId: string;
  agentKey: string;
  /** Human-readable target shown in cards: "drafting for Aarav Mehta", etc. */
  target: string;
  /** Ordered list of node names; one step pill per name. */
  nodeOrder: string[];
  /** Optional: link this run to a parent work item (e.g. the lead being scored). */
  parentWorkItemId?: string | null;
  /**
   * Per-step detail formatter. Receives the partial state update emitted
   * after a node completes; returns a short string that goes into
   * `agent_run.steps[i].detail`. Optional.
   */
  formatStepDetail?: (node: string, update: Partial<S>) => string | undefined;
  /** Compiled graph. Its state should not include db/tenantId — those travel via configurable. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graph: CompiledStateGraph<S, any, any, any, any, any>;
  /** State to pass into graph.stream(). */
  initialState: S;
  /** Project the final graph state to the value the caller returns. */
  project: (state: S) => R;
}

// ─── Singleton checkpointer ─────────────────────────────────────────────────
//
// One PostgresSaver per process. setup() must be called once on boot
// (idempotent) — see api/src/index.ts. The saver opens its own pg.Pool against
// DATABASE_URL; that's fine because checkpoint tables are not RLS-protected
// (they store transient graph state keyed by thread_id only).

let _checkpointer: PostgresSaver | null = null;
export function getCheckpointer(): PostgresSaver {
  if (_checkpointer) return _checkpointer;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set in env.");
  _checkpointer = PostgresSaver.fromConnString(url);
  return _checkpointer;
}

// Creates the LangGraph checkpoint tables. Idempotent (CREATE TABLE IF NOT
// EXISTS), so it is safe to call on every run.
//
// This used to be invoked once from the Express boot callback. There is no
// boot any more, so runWithGraph calls it lazily instead — otherwise the
// tables would simply never be created and the first agent run would fail.
//
// The cached PROMISE (rather than a done flag) matters: several agent runs can
// start concurrently on a cold instance, and a boolean set after the await
// would let all of them race into setup() at once.
let _setupPromise: Promise<void> | null = null;
export function ensureCheckpointerSetup(): Promise<void> {
  if (!_setupPromise) {
    _setupPromise = getCheckpointer().setup().then(
      () => undefined,
      (err) => {
        // Don't cache a failure — a transient DB blip would otherwise poison
        // this instance for its whole lifetime.
        _setupPromise = null;
        throw err;
      },
    );
  }
  return _setupPromise;
}

// ─── Run minting ─────────────────────────────────────────────────────────────

async function nextRunNumber(): Promise<string> {
  const r = await appPool.query<{ n: string }>(`SELECT nextval('seq_run')::text AS n`);
  return `RUN-${r.rows[0]!.n}`;
}

// ─── Main entry ──────────────────────────────────────────────────────────────

export async function runWithGraph<S extends object, R>(
  opts: RunWithGraphOpts<S, R>,
): Promise<{ result: R; runWorkItemId: string }> {
  // Was done once at Express boot; there is no boot now, so it happens here.
  await ensureCheckpointerSetup();

  const number = await nextRunNumber();

  // Initial steps array — first node `active`, rest `queued`.
  const steps: RunStep[] = opts.nodeOrder.map((label, i) => ({
    label,
    state: i === 0 ? "active" : "queued",
  }));

  // ── Phase 1: open the run rows, then COMMIT ────────────────────────────
  // Short transaction. Nothing slow happens inside it.
  const runWorkItemId = await withTenant(opts.tenantId, async (db) => {
    const wi = await db.execute(sql`
      INSERT INTO work_item (tenant_id, number, type, state)
      VALUES (${opts.tenantId}, ${number}, 'agent_run', 'running')
      RETURNING id
    `);
    const id = (wi.rows[0] as { id: string }).id;

    await db.execute(sql`
      INSERT INTO agent_run (
        work_item_id, tenant_id, agent_key, run_id, status,
        target, live, steps, started_at
      ) VALUES (
        ${id}, ${opts.tenantId}, ${opts.agentKey}, ${number},
        'running', ${opts.target}, true,
        ${JSON.stringify(steps)}::jsonb, NOW()
      )
    `);
    return id;
  });

  // ── Phase 2: run the graph with NO transaction held ────────────────────
  // Nodes get a per-statement tenant-scoped handle instead of the old
  // long-lived transaction handle, so LLM latency no longer occupies a
  // Postgres connection. RLS behaviour is unchanged.
  const nodeDb = tenantExec(opts.tenantId);
  const runConfig: RunnableConfig = {
    configurable: {
      thread_id: number,
      db: nodeDb,
      tenantId: opts.tenantId,
      runWorkItemId,
    },
  };

  let activeIdx = 0;

  try {
    const stream = await opts.graph.stream(opts.initialState, {
      ...runConfig,
      streamMode: "updates",
    });

    for await (const chunk of stream) {
      // chunk shape: Record<nodeName, partialState>. With streamMode:'updates'
      // a single node fires per chunk in our linear graphs, but we still
      // iterate to be safe against parallel branches.
      const entries = Object.entries(chunk as Record<string, Partial<S>>);
      for (const [nodeName, update] of entries) {
        if (nodeName === "__start__" || nodeName === "__end__") continue;
        const idx = steps.findIndex((s) => s.label === nodeName);
        if (idx < 0) continue;
        steps[idx]!.state = "done";
        const detail = opts.formatStepDetail?.(nodeName, update);
        if (detail) steps[idx]!.detail = detail;
        // Advance active marker to the next queued step (if any).
        activeIdx = idx + 1;
        if (activeIdx < steps.length && steps[activeIdx]!.state === "queued") {
          steps[activeIdx]!.state = "active";
        }
        // Progress ping between nodes — its own short transaction, which is
        // what makes the StepStrip update live rather than all at once on
        // COMMIT the way it did when the whole run shared one transaction.
        await nodeDb.execute(sql`
          UPDATE agent_run SET steps = ${JSON.stringify(steps)}::jsonb
          WHERE work_item_id = ${runWorkItemId}
        `);
      }
    }

    // Pull the final accumulated state out of the checkpointer so the
    // caller's project() sees the complete object (not just the last
    // partial update).
    const snapshot = await opts.graph.getState(runConfig);
    const finalState = snapshot.values as S;

    // Mark any still-active step done (defensive).
    for (const s of steps) if (s.state === "active") s.state = "done";

    // ── Phase 3: terminal bookkeeping ────────────────────────────────────
    await withTenant(opts.tenantId, async (db) => {
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
    });

    const result = opts.project(finalState);
    return { result, runWorkItemId };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const inflight = steps.find((s) => s.state === "active") ?? steps[activeIdx];
    if (inflight) {
      inflight.state = "failed";
      inflight.detail = message.slice(0, 200);
    }
    // Best-effort — the original error is what the caller needs to see, so a
    // failure to write the failure must not mask it. Previously the enclosing
    // transaction rolled these updates back anyway on the rethrow, leaving the
    // run stuck in 'running'; now they actually persist.
    try {
      await withTenant(opts.tenantId, async (db) => {
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
      });
    } catch (bookkeepingErr) {
      console.error(
        `[agent-runtime] failed to record run failure for ${runWorkItemId}:`,
        (bookkeepingErr as Error).message,
      );
    }
    throw err;
  }
}
