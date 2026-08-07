// Next-Best-Action Agent — picks the single best concrete action an advisor
// should take on a lead, given everything currently known about them.
//
// Output is the same {nbaLabel, nbaIcon, nbaHeadline, nbaWhy, nbaConfidence}
// shape the lead record page already renders. So when this agent writes back,
// the existing UI just shows the new suggestion on the next refresh.
//
// Implemented as a 4-node LangGraph: plan → retrieve_context → suggest → write_back.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { makeChatModel } from "../lib/llm.js";
import { runWithGraph, getCheckpointer, configurable } from "./runtime.js";
import { loadLeadContext, renderLeadContextBlock, type LeadContext } from "./lead-context.js";
import { resolveSentinelPartyId } from "../lib/party/resolve.js";

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
- Never invent prices, dates, scholarships, or commitments not in the input.`;

const NbaSchema = z.object({
  nbaLabel: z.string().min(1),
  nbaIcon: z.enum(VALID_ICONS),
  nbaHeadline: z.string().min(1),
  nbaWhy: z.string().min(1),
  nbaConfidence: z.number().int().min(0).max(100),
});
export type NbaOutput = z.infer<typeof NbaSchema> & { nbaIcon: NbaIcon };

function buildUserPrompt(c: LeadContext): string {
  return `${renderLeadContextBlock(c)}

Task: pick the single next-best-action for this lead.`;
}

// ─── Graph state ─────────────────────────────────────────────────────────────

const NbaStateAnn = Annotation.Root({
  ctx: Annotation<LeadContext>(),
  nba: Annotation<NbaOutput | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
  llmModel: Annotation<string | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
});
type NbaStateT = typeof NbaStateAnn.State;

async function planNode(_state: NbaStateT) {
  return {};
}
async function retrieveContextNode(_state: NbaStateT) {
  return {};
}
async function suggestNode(state: NbaStateT) {
  const model = makeChatModel({ maxTokens: 600 }).withStructuredOutput(NbaSchema, {
    name: "lead_nba",
  });
  const result = await model.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(buildUserPrompt(state.ctx)),
  ]);
  return { nba: result as NbaOutput, llmModel: process.env.ANTHROPIC_MODEL ?? null };
}
async function writeBackNode(state: NbaStateT, config: RunnableConfig) {
  const { db, tenantId } = configurable(config);
  const nba = state.nba!;
  const ctx = state.ctx;

  await db.execute(sql`
    UPDATE lead SET
      nba_label    = ${nba.nbaLabel},
      nba_icon     = ${nba.nbaIcon},
      nba_headline = ${nba.nbaHeadline},
      nba_why      = ${nba.nbaWhy},
      nba_confidence = ${nba.nbaConfidence}
    WHERE work_item_id = ${ctx.workItemId}
  `);

  // Phase 3: agent-authored rows attribute to the tenant's sentinel party.
  const actorPartyId = await resolveSentinelPartyId(db, tenantId);
  await db.execute(sql`
    INSERT INTO activity (
      tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name,
      verb, detail, tag, icon_key, icon_bg, icon_stroke, payload, ts
    ) VALUES (
      ${tenantId}, ${ctx.workItemId}, ${ctx.partyId},
      'agent', ${actorPartyId}, 'Next-Best-Action Agent',
      'suggested', ${`${nba.nbaLabel} (${nba.nbaConfidence}% conf). ${nba.nbaWhy.slice(0, 200)}`},
      'auto', 'star',
      'rgba(107,31,184,.1)', '#6B1FB8',
      ${JSON.stringify({ subject: ctx.name, nbaLabel: nba.nbaLabel, confidence: nba.nbaConfidence, rating: ctx.rating })}::jsonb,
      NOW()
    )
  `);

  await db.execute(sql`
    INSERT INTO audit_log (tenant_id, actor_type, actor_party_id, action, target_type, target_id, context)
    VALUES (
      ${tenantId}, 'agent', ${actorPartyId}, 'nba_suggested', 'work_item', ${ctx.workItemId},
      ${JSON.stringify({ rating: ctx.rating, nbaLabel: nba.nbaLabel, nbaConfidence: nba.nbaConfidence, model: state.llmModel })}::jsonb
    )
  `);

  return {};
}

const NODE_ORDER = ["plan", "retrieve_context", "suggest", "write_back"] as const;

const nbaGraph = new StateGraph(NbaStateAnn)
  .addNode("plan", planNode)
  .addNode("retrieve_context", retrieveContextNode)
  .addNode("suggest", suggestNode)
  .addNode("write_back", writeBackNode)
  .addEdge(START, "plan")
  .addEdge("plan", "retrieve_context")
  .addEdge("retrieve_context", "suggest")
  .addEdge("suggest", "write_back")
  .addEdge("write_back", END)
  .compile({ checkpointer: getCheckpointer() });

export async function suggestNba(
  tenantId: string,
  idOrNumber: string,
): Promise<{ nba: NbaOutput; runWorkItemId: string }> {
  const ctx = await loadLeadContext(tenantId, idOrNumber);
  if (!ctx) throw new Error("Lead not found");

  const { result, runWorkItemId } = await runWithGraph<NbaStateT, { nba: NbaOutput }>({
    tenantId,
    agentKey: "nba",
    target: `suggesting NBA for ${ctx.name}`,
    nodeOrder: [...NODE_ORDER],
    graph: nbaGraph,
    initialState: { ctx, nba: null, llmModel: null },
    formatStepDetail: (node, update) => {
      if (node === "plan") return `Lead ${ctx.number} · rating ${ctx.rating}`;
      if (node === "retrieve_context")
        return `${ctx.prevSignals.length} signals, ${ctx.recentActivity.length} activities, age ${ctx.ageDays}d`;
      if (node === "suggest" && update.nba) {
        return `${update.nba.nbaLabel} (${update.nba.nbaConfidence}% conf)`;
      }
      return undefined;
    },
    project: (state) => ({ nba: state.nba! }),
  });

  return { nba: result.nba, runWorkItemId };
}
