// Lead Scoring Agent — recomputes a single lead's score from its activity
// signals via Claude, writing back: lead.score / scoreLabel / scoreDesc
// + a fresh row set in lead_score_signal. Logs an activity entry with the delta.
//
// Rating is human-set (`lead.rating`) and is NOT updated by this agent — it's
// passed in as evidence so the model knows the human's read. The legacy
// `heat` column is auto-derived from rating via a DB trigger.

import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { callClaude } from "../lib/llm.js";
import { runAgent } from "./run.js";
import { loadLeadContext, renderLeadContextBlock, type LeadContext } from "./lead-context.js";

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
disagreement as a signal but do NOT override the rating; humans manage that.

Output JSON: {"score": int, "scoreLabel": string, "scoreDesc": string, "signals": [{"text": string, "weight": string, "kind": string}]}`;

interface ScoreOutput {
  score: number;
  scoreLabel: string;
  scoreDesc: string;
  signals: { text: string; weight: string; kind: string }[];
}

function buildUserPrompt(c: LeadContext): string {
  return `${renderLeadContextBlock(c)}

Task: re-score this lead end-to-end. Weigh ALL of the above — payment trail
and free-form description and notes carry as much weight as raw activity
counts. If the lead has paid money or said a verbal yes, score should reflect
imminent close, not just "engagement". If the timeline is silent for many
days, fade the score down. Do NOT just nudge the previous score by a small
delta — recompute fresh from the evidence.`;
}

function validate(o: unknown): ScoreOutput {
  const x = o as Record<string, unknown>;
  if (!x || typeof x !== "object") throw new Error("Score output not an object");
  const score = Number(x.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error("score must be 0-100");
  const scoreLabel = String(x.scoreLabel ?? "").trim();
  const scoreDesc = String(x.scoreDesc ?? "").trim();
  if (!scoreLabel || !scoreDesc) throw new Error("scoreLabel/scoreDesc empty");
  const rawSig = Array.isArray(x.signals) ? (x.signals as unknown[]) : [];
  const signals = rawSig
    .map((s) => {
      const r = s as Record<string, unknown>;
      const text = String(r.text ?? "").trim();
      const weight = String(r.weight ?? "").trim();
      const kind = String(r.kind ?? "").trim();
      if (!text || !weight || !["pos", "neg", "neu"].includes(kind)) return null;
      return { text, weight, kind };
    })
    .filter((s): s is { text: string; weight: string; kind: string } => s !== null);
  if (signals.length < 1) throw new Error("need at least one signal");
  return { score: Math.round(score), scoreLabel, scoreDesc, signals };
}

export async function scoreLead(
  tenantId: string,
  idOrNumber: string,
): Promise<{ before: { score: number | null; rating: string }; after: ScoreOutput; runWorkItemId: string }> {
  const ctx = await loadLeadContext(tenantId, idOrNumber);
  if (!ctx) throw new Error("Lead not found");

  const { result, runWorkItemId } = await runAgent({
    tenantId,
    agentKey: "scoring",
    target: `re-scoring ${ctx.name}`,
    steps: [
      { label: "plan", state: "queued" },
      { label: "retrieve_context", state: "queued" },
      { label: "score", state: "queued" },
      { label: "write_back", state: "queued" },
    ],
    body: async ({ beginStep, endStep, db }) => {
      beginStep("plan");
      endStep(`Lead ${ctx.number} · prev ${ctx.prevScore ?? "?"}`);

      beginStep("retrieve_context");
      endStep(`${ctx.prevSignals.length} signals, ${ctx.recentActivity.length} activities`);

      beginStep("score");
      const out = await callClaude({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(ctx),
        expectJson: true,
        maxTokens: 1200,
      });
      const score = validate(out.jsonValue);
      endStep(`${out.usage.in}+${out.usage.out} tokens · score → ${score.score}`);

      beginStep("write_back");
      // Update the lead row. Note: rating is human-set and not touched here.
      // The legacy `heat` column is auto-derived from rating by a DB trigger.
      await db.execute(sql`
        UPDATE lead SET
          score = ${score.score},
          score_label = ${score.scoreLabel},
          score_desc  = ${score.scoreDesc},
          score_reason = ${score.scoreDesc}
        WHERE work_item_id = ${ctx.workItemId}
      `);

      // Replace signals in one go.
      await db.execute(sql`DELETE FROM lead_score_signal WHERE work_item_id = ${ctx.workItemId}`);
      for (let i = 0; i < score.signals.length; i++) {
        const s = score.signals[i]!;
        await db.execute(sql`
          INSERT INTO lead_score_signal (tenant_id, work_item_id, text, weight, kind, rank)
          VALUES (${tenantId}, ${ctx.workItemId}, ${s.text}, ${s.weight}, ${s.kind}, ${i})
        `);
      }

      // Activity row capturing the move. Rating is shown for context only.
      const delta =
        ctx.prevScore != null
          ? `${ctx.prevScore} → ${score.score}`
          : `→ ${score.score}`;
      await db.execute(sql`
        INSERT INTO activity (
          tenant_id, work_item_id, party_id, actor_type, actor_name,
          verb, detail, tag, icon_key, icon_bg, icon_stroke, payload, ts
        ) VALUES (
          ${tenantId}, ${ctx.workItemId}, ${ctx.partyId},
          'agent', 'Lead Scoring Agent',
          're-scored', ${`Score ${delta} (rating: ${ctx.rating}). ${score.scoreDesc}`},
          'auto', 'star',
          'rgba(107,31,184,.1)', '#6B1FB8',
          ${JSON.stringify({ subject: ctx.name, before: ctx.prevScore, after: score.score, rating: ctx.rating })}::jsonb,
          NOW()
        )
      `);

      await db.execute(sql`
        INSERT INTO audit_log (tenant_id, actor_type, action, target_type, target_id, context)
        VALUES (
          ${tenantId}, 'agent', 'lead_rescored', 'work_item', ${ctx.workItemId},
          ${JSON.stringify({ before: ctx.prevScore, after: score.score, rating: ctx.rating, model: out.model, tokensIn: out.usage.in, tokensOut: out.usage.out })}::jsonb
        )
      `);

      endStep("done");
      return {
        before: { score: ctx.prevScore, rating: ctx.rating },
        after: score,
      };
    },
  });

  return { ...result, runWorkItemId };
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
