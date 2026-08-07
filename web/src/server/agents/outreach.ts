// Outreach Agent — drafts a personalised follow-up email for one lead and
// queues it for human approval. The "send" itself is a placeholder until
// you wire SMTP/WhatsApp; on approve, the approvals route logs activity.
//
// Implemented as a 4-node LangGraph: plan → retrieve_context → draft → approval_gate.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { withTenant } from "../db/app";
import { makeChatModel } from "../lib/llm";
import { runWithGraph, getCheckpointer, configurable } from "./runtime";
import { resolveSentinelPartyId } from "../lib/party/resolve";

const SYSTEM_PROMPT = `You are an outreach drafting assistant for an EdTech CRM (Digital Edify).
Your job is to draft a single warm, concise follow-up message to a prospective learner.

Hard rules:
- Output ONE message. 3 to 5 short sentences. Plain text body, no greeting block, no signature.
- Reference exactly ONE concrete signal from the lead's recent activity or context.
- Never invent prices, dates, names, scholarship amounts, or commitments.
- Do not be pushy. No urgency theater ("act now", "limited seats").
- Match Indian English. Friendly, professional, never gushing.
- Subject line: under 60 characters, no clickbait, no emoji.`;

const DraftSchema = z.object({
  subject: z.string().min(1).max(120),
  body: z.string().min(1),
});
type Draft = z.infer<typeof DraftSchema>;

export interface DraftedEmail {
  approvalId: string;
  draft: Draft;
  runWorkItemId: string;
}

interface OutreachLeadCtx {
  workItemId: string;
  number: string;
  partyId: string;
  name: string;
  program: string | null;
  city: string | null;
  score: number | null;
  heat: string | null;
  scoreReason: string | null;
  stage: string | null;
  stageLabel: string | null;
  signals: { text: string; weight: string; kind: string }[];
  recentActivity: { verb: string; detail: string | null; ts: Date }[];
}

async function loadOutreachContext(
  tenantId: string,
  idOrNumber: string,
): Promise<OutreachLeadCtx | null> {
  return await withTenant(tenantId, async (db) => {
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(idOrNumber);
    const r = await db.execute(
      isUuid
        ? sql`
            SELECT wi.id AS "workItemId", wi.number, wi.party_id AS "partyId",
                   p.name, l.program, p.city, l.score, l.heat,     -- Phase 3: p.city was l.city
                   l.score_reason AS "scoreReason", l.stage, l.stage_label AS "stageLabel"
            FROM lead l
            JOIN work_item wi ON wi.id = l.work_item_id
            JOIN party p      ON p.id  = wi.party_id
            WHERE wi.id = ${idOrNumber}
            LIMIT 1`
        : sql`
            SELECT wi.id AS "workItemId", wi.number, wi.party_id AS "partyId",
                   p.name, l.program, p.city, l.score, l.heat,     -- Phase 3: p.city was l.city
                   l.score_reason AS "scoreReason", l.stage, l.stage_label AS "stageLabel"
            FROM lead l
            JOIN work_item wi ON wi.id = l.work_item_id
            JOIN party p      ON p.id  = wi.party_id
            WHERE wi.number = ${idOrNumber}
            LIMIT 1`,
    );
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const workItemId = row.workItemId as string;

    const sigs = await db.execute(sql`
      SELECT text, weight, kind FROM lead_score_signal
      WHERE work_item_id = ${workItemId}
      ORDER BY rank
      LIMIT 6
    `);
    const acts = await db.execute(sql`
      SELECT verb, detail, ts FROM activity
      WHERE work_item_id = ${workItemId}
      ORDER BY ts DESC
      LIMIT 5
    `);

    return {
      workItemId,
      number: row.number as string,
      partyId: row.partyId as string,
      name: row.name as string,
      program: (row.program as string | null) ?? null,
      city: (row.city as string | null) ?? null,
      score: (row.score as number | null) ?? null,
      heat: (row.heat as string | null) ?? null,
      scoreReason: (row.scoreReason as string | null) ?? null,
      stage: (row.stage as string | null) ?? null,
      stageLabel: (row.stageLabel as string | null) ?? null,
      signals: sigs.rows as { text: string; weight: string; kind: string }[],
      recentActivity: acts.rows as { verb: string; detail: string | null; ts: Date }[],
    };
  });
}

function buildUserPrompt(c: OutreachLeadCtx): string {
  const signals = c.signals.length
    ? c.signals.map((s) => `  - [${s.weight}] ${s.text} (${s.kind})`).join("\n")
    : "  (none recorded)";
  const recent = c.recentActivity.length
    ? c.recentActivity
        .map((a) => `  - ${a.verb}${a.detail ? `: ${a.detail.slice(0, 140)}` : ""}`)
        .join("\n")
    : "  (none)";
  return `Lead context:
- Name: ${c.name}
- Program of interest: ${c.program ?? "unspecified"}
- City: ${c.city ?? "unknown"}
- Stage: ${c.stageLabel ?? c.stage ?? "unknown"}
- Score: ${c.score ?? "n/a"} (${c.heat ?? "n/a"})
- Score reason: ${c.scoreReason ?? "n/a"}

Recent signals:
${signals}

Recent activity (most recent first):
${recent}

Task: Draft a follow-up message to advance this lead.`;
}

// ─── Graph state ─────────────────────────────────────────────────────────────

const OutreachStateAnn = Annotation.Root({
  ctx: Annotation<OutreachLeadCtx>(),
  draftOut: Annotation<Draft | null>({ reducer: (_x, y) => y, default: () => null }),
  approvalId: Annotation<string | null>({ reducer: (_x, y) => y, default: () => null }),
  llmModel: Annotation<string | null>({ reducer: (_x, y) => y, default: () => null }),
});
type OutreachStateT = typeof OutreachStateAnn.State;

async function planNode(_state: OutreachStateT) {
  return {};
}
async function retrieveContextNode(_state: OutreachStateT) {
  return {};
}
async function draftNode(state: OutreachStateT) {
  const model = makeChatModel({ maxTokens: 600 }).withStructuredOutput(DraftSchema, {
    name: "outreach_draft",
  });
  const result = await model.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(buildUserPrompt(state.ctx)),
  ]);
  return { draftOut: result, llmModel: process.env.ANTHROPIC_MODEL ?? null };
}
async function approvalGateNode(state: OutreachStateT, config: RunnableConfig) {
  const { db, tenantId } = configurable(config);
  const draft = state.draftOut!;
  const ctx = state.ctx;
  const proposed = { channel: "email", subject: draft.subject, body: draft.body };

  const ar = await db.execute(sql`
    INSERT INTO approval (
      tenant_id, work_item_id, action_type, mode, status, proposed, requested_by
    ) VALUES (
      ${tenantId}, ${ctx.workItemId},
      'send_email', 'supervised', 'pending',
      ${JSON.stringify(proposed)}::jsonb,
      'outreach'
    )
    RETURNING id
  `);
  const approvalId = (ar.rows[0] as { id: string }).id;

  // Phase 3: agent-authored rows attribute to the tenant's sentinel party.
  const actorPartyId = await resolveSentinelPartyId(db, tenantId);
  await db.execute(sql`
    INSERT INTO activity (
      tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name,
      verb, detail, tag, icon_key, icon_bg, icon_stroke, payload, ts
    ) VALUES (
      ${tenantId}, ${ctx.workItemId}, ${ctx.partyId},
      'agent', ${actorPartyId}, 'Outreach Agent',
      'drafted a follow-up email for', ${`"${draft.subject}" — awaiting your approval.`},
      'need', 'spark',
      'rgba(199,25,122,.1)', '#C7197A',
      ${JSON.stringify({ subject: ctx.name, approvalId, runWorkItemId: null })}::jsonb,
      NOW()
    )
  `);

  await db.execute(sql`
    INSERT INTO audit_log (tenant_id, actor_type, actor_party_id, action, target_type, target_id, context)
    VALUES (
      ${tenantId}, 'agent', ${actorPartyId}, 'outreach_drafted', 'approval', ${approvalId},
      ${JSON.stringify({ workItemId: ctx.workItemId, model: state.llmModel })}::jsonb
    )
  `);

  return { approvalId };
}

const NODE_ORDER = ["plan", "retrieve_context", "draft", "approval_gate"] as const;

// Compiled on first use, not at import. getCheckpointer() needs DATABASE_URL,
// and Next loads this module during `next build` to collect page data — where
// that variable is not necessarily set. Compiling eagerly turned a missing
// runtime secret into a failed build. See db/app.ts for the same reasoning.
let _outreachGraph: ReturnType<typeof build_outreachGraph> | null = null;
function outreachGraph() {
  return (_outreachGraph ??= build_outreachGraph());
}

function build_outreachGraph() {
  return new StateGraph(OutreachStateAnn)
  .addNode("plan", planNode)
  .addNode("retrieve_context", retrieveContextNode)
  .addNode("draft", draftNode)
  .addNode("approval_gate", approvalGateNode)
  .addEdge(START, "plan")
  .addEdge("plan", "retrieve_context")
  .addEdge("retrieve_context", "draft")
  .addEdge("draft", "approval_gate")
  .addEdge("approval_gate", END)
    .compile({ checkpointer: getCheckpointer() });
}

export async function draftFollowup(
  tenantId: string,
  idOrNumber: string,
): Promise<DraftedEmail> {
  const ctx = await loadOutreachContext(tenantId, idOrNumber);
  if (!ctx) throw new Error("Lead not found");

  const { result, runWorkItemId } = await runWithGraph<
    OutreachStateT,
    { approvalId: string; draft: Draft }
  >({
    tenantId,
    agentKey: "outreach",
    target: `drafting for ${ctx.name}`,
    nodeOrder: [...NODE_ORDER],
    graph: outreachGraph(),
    initialState: { ctx, draftOut: null, approvalId: null, llmModel: null },
    formatStepDetail: (node, update) => {
      if (node === "plan") return `Lead ${ctx.number} · score ${ctx.score ?? "?"}`;
      if (node === "retrieve_context")
        return `${ctx.signals.length} signals, ${ctx.recentActivity.length} recent activities`;
      if (node === "draft" && update.draftOut) return `subject: ${update.draftOut.subject.slice(0, 60)}`;
      if (node === "approval_gate") return "approval pending";
      return undefined;
    },
    project: (state) => ({ approvalId: state.approvalId!, draft: state.draftOut! }),
  });

  return { approvalId: result.approvalId, draft: result.draft, runWorkItemId };
}
