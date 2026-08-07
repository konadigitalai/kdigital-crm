// Lead Scoring Agent — recomputes a single lead's score from its activity
// signals via Claude, writing back: lead.score / scoreLabel / scoreDesc
// + a fresh row set in lead_score_signal. Logs an activity entry with the delta.
//
// Rating is human-set (`lead.rating`) and is NOT updated by this agent — it's
// passed in as evidence so the model knows the human's read. The legacy
// `heat` column is auto-derived from rating via a DB trigger.
//
// Implemented as a 4-node LangGraph: plan → retrieve_context → score → write_back.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { withTenant } from "../db/app";
import { makeChatModel } from "../lib/llm";
import { runWithGraph, getCheckpointer, configurable } from "./runtime";
import { loadLeadContext, renderLeadContextBlock, type LeadContext } from "./lead-context";
import { resolveSentinelPartyId } from "../lib/party/resolve";

const SYSTEM_PROMPT = `You are a sales lead scoring assistant for an EdTech CRM (Digital Edify).

Your job: weigh ALL the evidence on a lead — profile, free-form description,
advisor notes, payment trail, timeline, identifiers, prior scores — and output
a fresh structured score that captures intent, fit, and urgency.

Heuristics (apply ALL, not just engagement signals):
- A non-zero "fee paid" or a "registered date" set → strong positive (lead is mid-conversion).
- A free-form value like "verbal yes" / "ready to enrol" → strong positive.
- An EMI / scholarship / discount question → moderate positive (intent + price-sensitive).
- Demo no-show with no follow-up reply for 48h → moderate negative.
- Long silence (no inbound for 7+ days) → fade the score down.
- Long advisor description full of context → trust it; pull out one signal you can name.
- Recent advisor notes ("call_logged", note kind in payload) carry MORE weight than auto-events.
- High-quality channel mix (replied on multiple channels) → small positive.
- Low intent source (paid ad with no further activity) → cap the upside.

Hard rules:
- score: integer 0-100. Calibration: superhot ≥ 90, hot 75-89, warm 50-74, cold < 50.
- scoreLabel: short label that matches the human-set rating (e.g. "Super-hot lead", "Hot lead", "Warm lead", "Cold lead", "New inbound", "Enrolled — keep warm"). DO NOT change the rating itself; just label.
- scoreDesc: ONE sentence telling the advisor WHAT TO DO next (action, not description). <= 140 chars.
- signals: 4 to 7 short bullets covering DIFFERENT axes:
    * one about money / payment / explicit commitment (if any evidence)
    * one about engagement velocity (response times, channel diversity)
    * one about activity recency (silence vs. fresh touches)
    * one about the advisor's notes / description (if they exist)
    * one or two about specific timeline events (demo, pricing visits, etc.)
  Avoid duplicate signals that say the same thing differently.
  Each bullet has:
    text:   <= 100 chars, the observation
    weight: a string like "+14", "-9", "neutral"
    kind:   one of "pos", "neg", "neu"
- No fabrication: every signal must be grounded in the input. If a fact is "—" / "(none)", do not invent.
- Recompute fresh — do not just nudge the previous score by ±2.

A human-set "rating" field accompanies each lead (one of: inbound, cold, warm,
hot, superhot, enrolled). Treat that as a strong prior — humans see things the
data doesn't. If your score wildly disagrees with the rating, surface that
disagreement as a signal but do NOT override the rating; humans manage that.`;

const ScoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  scoreLabel: z.string().min(1),
  scoreDesc: z.string().min(1),
  signals: z
    .array(
      z.object({
        text: z.string().min(1),
        weight: z.string().min(1),
        kind: z.enum(["pos", "neg", "neu"]),
      }),
    )
    .min(1),
});
export type ScoreOutput = z.infer<typeof ScoreSchema>;

function buildUserPrompt(c: LeadContext): string {
  return `${renderLeadContextBlock(c)}

Task: re-score this lead end-to-end. Weigh ALL of the above — payment trail
and free-form description and notes carry as much weight as raw activity
counts. If the lead has paid money or said a verbal yes, score should reflect
imminent close, not just "engagement". If the timeline is silent for many
days, fade the score down. Do NOT just nudge the previous score by a small
delta — recompute fresh from the evidence.`;
}

// ─── Graph state ─────────────────────────────────────────────────────────────

const ScoringState = Annotation.Root({
  ctx: Annotation<LeadContext>(),
  scoreOut: Annotation<ScoreOutput | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
  llmModel: Annotation<string | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
  tokensIn: Annotation<number>({ reducer: (_x, y) => y, default: () => 0 }),
  tokensOut: Annotation<number>({ reducer: (_x, y) => y, default: () => 0 }),
});
type ScoringStateT = typeof ScoringState.State;

// ─── Nodes ───────────────────────────────────────────────────────────────────

async function planNode(_state: ScoringStateT) {
  // Bookkeeping-only step; runtime captures the detail string from
  // formatStepDetail. Returning {} doesn't change state.
  return {};
}

async function retrieveContextNode(_state: ScoringStateT) {
  // The full context was loaded outside the graph (so the run's `target`
  // string can include the lead name); this node is a placeholder for the
  // step pill.
  return {};
}

async function scoreNode(state: ScoringStateT) {
  const model = makeChatModel({ maxTokens: 1200 }).withStructuredOutput(ScoreSchema, {
    name: "lead_score",
  });
  const result = await model.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(buildUserPrompt(state.ctx)),
  ]);
  // withStructuredOutput returns the parsed object directly. Token usage and
  // resolved model id aren't surfaced through this path — fall back to env.
  return {
    scoreOut: result,
    llmModel: process.env.ANTHROPIC_MODEL ?? null,
  };
}

async function writeBackNode(state: ScoringStateT, config: RunnableConfig) {
  const { db, tenantId } = configurable(config);
  const score = state.scoreOut!;
  const ctx = state.ctx;

  await db.execute(sql`
    UPDATE lead SET
      score = ${score.score},
      score_label = ${score.scoreLabel},
      score_desc  = ${score.scoreDesc},
      score_reason = ${score.scoreDesc}
    WHERE work_item_id = ${ctx.workItemId}
  `);

  await db.execute(sql`DELETE FROM lead_score_signal WHERE work_item_id = ${ctx.workItemId}`);
  for (let i = 0; i < score.signals.length; i++) {
    const s = score.signals[i]!;
    await db.execute(sql`
      INSERT INTO lead_score_signal (tenant_id, work_item_id, text, weight, kind, rank)
      VALUES (${tenantId}, ${ctx.workItemId}, ${s.text}, ${s.weight}, ${s.kind}, ${i})
    `);
  }

  const delta =
    ctx.prevScore != null ? `${ctx.prevScore} → ${score.score}` : `→ ${score.score}`;
  // Phase 3: agent-authored rows attribute to the tenant's sentinel party.
  const actorPartyId = await resolveSentinelPartyId(db, tenantId);
  await db.execute(sql`
    INSERT INTO activity (
      tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name,
      verb, detail, tag, icon_key, icon_bg, icon_stroke, payload, ts
    ) VALUES (
      ${tenantId}, ${ctx.workItemId}, ${ctx.partyId},
      'agent', ${actorPartyId}, 'Lead Scoring Agent',
      're-scored', ${`Score ${delta} (rating: ${ctx.rating}). ${score.scoreDesc}`},
      'auto', 'star',
      'rgba(107,31,184,.1)', '#6B1FB8',
      ${JSON.stringify({ subject: ctx.name, before: ctx.prevScore, after: score.score, rating: ctx.rating })}::jsonb,
      NOW()
    )
  `);

  await db.execute(sql`
    INSERT INTO audit_log (tenant_id, actor_type, actor_party_id, action, target_type, target_id, context)
    VALUES (
      ${tenantId}, 'agent', ${actorPartyId}, 'lead_rescored', 'work_item', ${ctx.workItemId},
      ${JSON.stringify({ before: ctx.prevScore, after: score.score, rating: ctx.rating, model: state.llmModel })}::jsonb
    )
  `);

  return {};
}

// ─── Compiled graph ──────────────────────────────────────────────────────────

const NODE_ORDER = ["plan", "retrieve_context", "score", "write_back"] as const;

// Compiled on first use, not at import. getCheckpointer() needs DATABASE_URL,
// and Next loads this module during `next build` to collect page data — where
// that variable is not necessarily set. Compiling eagerly turned a missing
// runtime secret into a failed build. See db/app.ts for the same reasoning.
let _scoringGraph: ReturnType<typeof build_scoringGraph> | null = null;
function scoringGraph() {
  return (_scoringGraph ??= build_scoringGraph());
}

function build_scoringGraph() {
  return new StateGraph(ScoringState)
  .addNode("plan", planNode)
  .addNode("retrieve_context", retrieveContextNode)
  .addNode("score", scoreNode)
  .addNode("write_back", writeBackNode)
  .addEdge(START, "plan")
  .addEdge("plan", "retrieve_context")
  .addEdge("retrieve_context", "score")
  .addEdge("score", "write_back")
  .addEdge("write_back", END)
    .compile({ checkpointer: getCheckpointer() });
}

// ─── Public entry ────────────────────────────────────────────────────────────

export async function scoreLead(
  tenantId: string,
  idOrNumber: string,
): Promise<{ before: { score: number | null; rating: string }; after: ScoreOutput; runWorkItemId: string }> {
  const ctx = await loadLeadContext(tenantId, idOrNumber);
  if (!ctx) throw new Error("Lead not found");

  const { result, runWorkItemId } = await runWithGraph<ScoringStateT, { after: ScoreOutput }>({
    tenantId,
    agentKey: "scoring",
    target: `re-scoring ${ctx.name}`,
    nodeOrder: [...NODE_ORDER],
    graph: scoringGraph(),
    initialState: {
      ctx,
      scoreOut: null,
      llmModel: null,
      tokensIn: 0,
      tokensOut: 0,
    },
    formatStepDetail: (node, update) => {
      if (node === "plan") return `Lead ${ctx.number} · prev ${ctx.prevScore ?? "?"}`;
      if (node === "retrieve_context")
        return `${ctx.prevSignals.length} signals, ${ctx.recentActivity.length} activities`;
      if (node === "score" && update.scoreOut) return `score → ${update.scoreOut.score}`;
      if (node === "write_back") return "done";
      return undefined;
    },
    project: (state) => ({ after: state.scoreOut! }),
  });

  return {
    before: { score: ctx.prevScore, rating: ctx.rating },
    after: result.after,
    runWorkItemId,
  };
}

// Bulk pass — open leads only. Runs sequentially to be gentle on the gateway.
export async function scoreAllOpen(tenantId: string): Promise<{ scored: number; failed: number }> {
  const leadsToScore = await withTenant(tenantId, async (db) => {
    const r = await db.execute(sql`
      SELECT wi.number FROM lead l
      JOIN work_item wi ON wi.id = l.work_item_id
      WHERE l.rating <> 'enrolled'
      ORDER BY wi.created_at DESC
    `);
    return (r.rows as { number: string }[]).map((row) => row.number);
  });

  let scored = 0;
  let failed = 0;
  for (const number of leadsToScore) {
    try {
      await scoreLead(tenantId, number);
      scored++;
    } catch {
      failed++;
    }
  }
  return { scored, failed };
}
