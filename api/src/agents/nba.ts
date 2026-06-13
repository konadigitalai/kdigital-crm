// Next-Best-Action Agent — picks the single best concrete action an advisor
// should take on a lead, given everything currently known about them.
//
// Output is the same {nbaLabel, nbaIcon, nbaHeadline, nbaWhy, nbaConfidence}
// shape the lead record page already renders. So when this agent writes back,
// the existing UI just shows the new suggestion on the next refresh.

import { sql } from "drizzle-orm";
import { callClaude } from "../lib/llm.js";
import { runAgent } from "./run.js";
import { loadLeadContext, renderLeadContextBlock, type LeadContext } from "./lead-context.js";

const VALID_ICONS = ["send", "clock", "mail", "star", "check", "info", "money"] as const;
type NbaIcon = (typeof VALID_ICONS)[number];

const SYSTEM_PROMPT = `You are a sales next-best-action assistant for an EdTech CRM (Digital Edify).

Your job: look at every fact about a lead — profile, payment trail, free-form
description, advisor notes, score signals, recent timeline, and the human-set
rating — and pick the SINGLE most leveraged action an advisor should take next.

Hard rules:
- nbaLabel: 3-5 word imperative verb phrase. Concrete action only.
    GOOD: "Send EMI breakdown", "Call about scholarship", "Send referral ask",
          "Ship welcome syllabus", "Re-confirm demo slot".
    BAD:  "Follow up", "Engage", "Nurture lead" (too vague).
- nbaIcon: one of "send" | "clock" | "mail" | "star" | "check" | "info" | "money".
    Use 'money' for fee/EMI/discount actions, 'mail' for emails, 'send' for
    payment links and resources, 'clock' for calls/demo bookings, 'star' for
    referral asks, 'check' for confirmation/closure actions, 'info' for
    onboarding hand-offs.
- nbaHeadline: ONE sentence that says WHAT to do, in plain English. <= 140 chars.
- nbaWhy: ONE or TWO sentences that say WHY — must cite a CONCRETE signal from
    the input (a payment number, a specific note, a timeline event). No platitudes
    like "highest-leverage move based on signals".
- nbaConfidence: integer 0-100 reflecting how confident you are this is the
    right next move. Lower confidence (50-65) when evidence is thin or
    conflicting. Don't return 90+ unless the lead is clearly in the verb's
    category (e.g. payment confirmed → "Send onboarding link" with 95).
- Action MUST respect the human rating:
    * "enrolled" → ask for referral, log a feedback survey, NEVER "send pricing"
    * "superhot" → close-the-deal moves: send EMI / payment link / lock seat
    * "hot" → high-effort touches: book a call, send a tailored proposal
    * "warm" → soft nurture: send case study, schedule a check-in
    * "cold" → re-engagement: send a short useful resource, don't ask for time
    * "attempted" → low-friction retry: send a different channel, ask one Q
    * "new lead" → welcome + qualifier: ship syllabus, ask 1-2 fit questions
- Never invent prices, dates, scholarships, or commitments not in the input.

Output JSON:
{ "nbaLabel": string, "nbaIcon": string, "nbaHeadline": string,
  "nbaWhy": string, "nbaConfidence": int }`;

export interface NbaOutput {
  nbaLabel: string;
  nbaIcon: NbaIcon;
  nbaHeadline: string;
  nbaWhy: string;
  nbaConfidence: number;
}

function validate(o: unknown): NbaOutput {
  const x = o as Record<string, unknown>;
  if (!x || typeof x !== "object") throw new Error("NBA output not an object");
  const nbaLabel = String(x.nbaLabel ?? "").trim();
  const nbaIconRaw = String(x.nbaIcon ?? "").trim().toLowerCase();
  const nbaHeadline = String(x.nbaHeadline ?? "").trim();
  const nbaWhy = String(x.nbaWhy ?? "").trim();
  const nbaConfidence = Math.round(Number(x.nbaConfidence));
  if (!nbaLabel) throw new Error("nbaLabel empty");
  if (!nbaHeadline) throw new Error("nbaHeadline empty");
  if (!nbaWhy) throw new Error("nbaWhy empty");
  if (!Number.isFinite(nbaConfidence) || nbaConfidence < 0 || nbaConfidence > 100) {
    throw new Error("nbaConfidence must be 0-100");
  }
  const nbaIcon = (VALID_ICONS as readonly string[]).includes(nbaIconRaw)
    ? (nbaIconRaw as NbaIcon)
    : "star";
  return { nbaLabel, nbaIcon, nbaHeadline, nbaWhy, nbaConfidence };
}

function buildUserPrompt(c: LeadContext): string {
  return `${renderLeadContextBlock(c)}

Task: pick the single next-best-action for this lead. Output JSON.`;
}

export async function suggestNba(
  tenantId: string,
  idOrNumber: string,
): Promise<{ nba: NbaOutput; runWorkItemId: string }> {
  const ctx = await loadLeadContext(tenantId, idOrNumber);
  if (!ctx) throw new Error("Lead not found");

  const { result, runWorkItemId } = await runAgent({
    tenantId,
    agentKey: "nba",
    target: `suggesting NBA for ${ctx.name}`,
    steps: [
      { label: "plan", state: "queued" },
      { label: "retrieve_context", state: "queued" },
      { label: "suggest", state: "queued" },
      { label: "write_back", state: "queued" },
    ],
    body: async ({ beginStep, endStep, db }) => {
      beginStep("plan");
      endStep(`Lead ${ctx.number} · rating ${ctx.rating}`);

      beginStep("retrieve_context");
      endStep(`${ctx.prevSignals.length} signals, ${ctx.recentActivity.length} activities, age ${ctx.ageDays}d`);

      beginStep("suggest");
      const out = await callClaude({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(ctx),
        expectJson: true,
        maxTokens: 600,
      });
      const nba = validate(out.jsonValue);
      endStep(`${out.usage.in}+${out.usage.out} tokens · ${nba.nbaLabel}`);

      beginStep("write_back");
      await db.execute(sql`
        UPDATE lead SET
          nba_label    = ${nba.nbaLabel},
          nba_icon     = ${nba.nbaIcon},
          nba_headline = ${nba.nbaHeadline},
          nba_why      = ${nba.nbaWhy},
          nba_confidence = ${nba.nbaConfidence}
        WHERE work_item_id = ${ctx.workItemId}
      `);

      // Activity row so the timeline shows when the suggestion last refreshed.
      await db.execute(sql`
        INSERT INTO activity (
          tenant_id, work_item_id, party_id, actor_type, actor_name,
          verb, detail, tag, icon_key, icon_bg, icon_stroke, payload, ts
        ) VALUES (
          ${tenantId}, ${ctx.workItemId}, ${ctx.partyId},
          'agent', 'Next-Best-Action Agent',
          'suggested', ${`${nba.nbaLabel} (${nba.nbaConfidence}% conf). ${nba.nbaWhy.slice(0, 200)}`},
          'auto', 'star',
          'rgba(107,31,184,.1)', '#6B1FB8',
          ${JSON.stringify({ subject: ctx.name, nbaLabel: nba.nbaLabel, confidence: nba.nbaConfidence, rating: ctx.rating })}::jsonb,
          NOW()
        )
      `);

      await db.execute(sql`
        INSERT INTO audit_log (tenant_id, actor_type, action, target_type, target_id, context)
        VALUES (
          ${tenantId}, 'agent', 'nba_suggested', 'work_item', ${ctx.workItemId},
          ${JSON.stringify({ rating: ctx.rating, nbaLabel: nba.nbaLabel, nbaConfidence: nba.nbaConfidence, model: out.model, tokensIn: out.usage.in, tokensOut: out.usage.out })}::jsonb
        )
      `);

      endStep(`done · ${nba.nbaConfidence}% confidence`);
      return { nba };
    },
  });

  return { ...result, runWorkItemId };
}
