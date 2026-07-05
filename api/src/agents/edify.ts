// Edify Agent — the home-page CRM chat assistant. Answers natural-language
// questions about the tenant's leads, learners, cases, batches, users,
// programs, agents, approvals — by:
//
//   1. Building a compact, structured snapshot of the entire tenant state
//      (one SQL transaction, ~5-10 KB JSON, no PII beyond what's already on
//      the records).
//   2. Asking Claude to answer using ONLY that snapshot.
//   3. Validating the JSON output, especially: citations and suggested
//      actions only reference IDs/numbers that appear in the snapshot.
//   4. Persisting the {question, answer, citations, suggestedAction} to a
//      per-user log so the home box can show recent history.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { withTenant } from "../db/app.js";
import { makeChatModel } from "../lib/llm.js";
import { resolveActorPartyId, partyIdFromAppUserId } from "../lib/party/resolve.js";
import { loadLeadContext, renderLeadContextBlock } from "./lead-context.js";

const VALID_ACTIONS = [
  "draft_outreach",
  "rescore_lead",
  "refresh_nba",
  "rescore_all",
  "run_forecast",
] as const;
type SuggestedActionKind = (typeof VALID_ACTIONS)[number];

const VALID_CITATION_KINDS = ["lead", "learner", "case", "program", "cohort", "user", "agent"] as const;
type CitationKind = (typeof VALID_CITATION_KINDS)[number];

export interface EdifyCitation {
  kind: CitationKind;
  ref: string;
  label: string;
}

export interface EdifySuggestedAction {
  action: SuggestedActionKind;
  leadNumber?: string;
  label: string;
  rationale: string;
}

export interface EdifyAnswer {
  messageId: string;
  sessionId: string;
  question: string;
  answer: string;
  citations: EdifyCitation[];
  suggestedAction: EdifySuggestedAction | null;
  askedAt: string;
}

export interface EdifySessionSummary {
  id: string;
  title: string | null;
  createdAt: string;
  lastAt: string;
  messageCount: number;
  preview: string | null;        // first ~80 chars of the most recent question
}

// ── Snapshot shape ──────────────────────────────────────────────────────

interface CrmSnapshot {
  generatedAt: string;
  user: { id: string; name: string | null; email: string };
  totals: {
    activeLeads: number;
    enrolledLearners: number;
    openCases: number;
    overdueCases: number;
    pendingApprovals: number;
    liveAgents: number;
  };
  ratingFunnel: Array<{ rating: string; count: number }>;
  topLeads: Array<{
    number: string;
    name: string;
    rating: string;
    score: number | null;
    program: string | null;
    city: string | null;
    value: string | null;
    daysSinceLastTouch: number | null;
    advisorName: string | null;
  }>;
  recentLearners: Array<{
    partyId: string;
    name: string;
    program: string | null;
    enrolledAt: string;
    pricePaid: string | null;
  }>;
  casesSummary: {
    byStatus: Record<string, number>;
    byCategory: Record<string, number>;
    recent: Array<{
      number: string;
      subject: string;
      status: string;
      priority: number;
      assignee: string | null;
      createdAt: string;
    }>;
  };
  cohorts: Array<{
    name: string;
    programName: string | null;
    status: string;
    assigned: number;
    seats: number | null;
    startDate: string | null;
  }>;
  programs: Array<{
    id: string;
    name: string;
    price: number | null;
    enabled: boolean;
    activeLeads: number;
    enrolments: number;
  }>;
  users: Array<{ id: string; name: string | null; email: string; role: string; active: boolean }>;
  groups: Array<{ name: string; memberCount: number; permissions: number }>;
  recentAgentRuns: Array<{ agentKey: string; agentName: string; status: string; target: string | null; startedAt: string }>;
  approvals: Array<{ id: string; actionType: string; status: string; partyName: string | null; createdAt: string }>;
  forecastNarrative: unknown | null;
  deepLead: string | null; // formatted block from renderLeadContextBlock when applicable
}

// ── Snapshot builder ────────────────────────────────────────────────────

const parsedValueExpr = sql`
  CASE
    WHEN l.value ~ '^₹[0-9.]+L$'  THEN (regexp_replace(l.value, '[₹L]', '', 'g'))::numeric * 100000
    WHEN l.value ~ '^₹[0-9.]+Cr$' THEN (regexp_replace(l.value, '[₹Cr]', '', 'g'))::numeric * 10000000
    WHEN l.value ~ '^₹[0-9.]+k$'  THEN (regexp_replace(l.value, '[₹k]', '', 'g'))::numeric * 1000
    ELSE 0
  END
`;
void parsedValueExpr; // kept for potential future use in this builder

async function buildSnapshot(
  tenantId: string,
  userId: string,
  question: string,
): Promise<CrmSnapshot> {
  const generatedAt = new Date().toISOString();

  const base = await withTenant(tenantId, async (db) => {
    // User
    const userR = await db.execute(sql`
      SELECT id, name, email FROM app_user WHERE id = ${userId} LIMIT 1
    `);
    const user = userR.rows[0] as { id: string; name: string | null; email: string };

    // Totals
    const totalsR = await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM lead WHERE rating <> 'enrolled')                             AS "activeLeads",
        (SELECT COUNT(*)::int FROM party_role pr WHERE pr.role = 'learner' AND pr.valid_to IS NULL) AS "enrolledLearners",
        (SELECT COUNT(*)::int FROM support_case WHERE status NOT IN ('closed','resolved','cancelled')) AS "openCases",
        (SELECT COUNT(*)::int FROM support_case WHERE due_at < NOW() AND status NOT IN ('closed','resolved','cancelled')) AS "overdueCases",
        (SELECT COUNT(*)::int FROM approval WHERE status = 'pending')                          AS "pendingApprovals",
        (SELECT COUNT(*)::int FROM agent_run WHERE live = true)                                AS "liveAgents"
    `);
    const totals = totalsR.rows[0] as CrmSnapshot["totals"];

    // Rating funnel
    const funnelR = await db.execute(sql`
      SELECT rating, COUNT(*)::int AS count
      FROM lead
      GROUP BY rating
    `);
    const ratingFunnel = funnelR.rows as Array<{ rating: string; count: number }>;

    // Top leads (top 25 by rating priority + score)
    const topLeadsR = await db.execute(sql`
      WITH last_act AS (
        SELECT a.work_item_id, MAX(a.ts) AS last_ts FROM activity a GROUP BY a.work_item_id
      )
      SELECT
        wi.number,
        p.name,
        l.rating, l.score,
        l.program,
        p.city,             -- Phase 3: was l.city (denorm dropped)
        l.value,
        EXTRACT(EPOCH FROM (NOW() - la.last_ts)) / 86400 AS "daysSinceLastTouch",
        u.name AS "advisorName"
      FROM lead l
      JOIN work_item wi ON wi.id = l.work_item_id
      JOIN party p      ON p.id  = wi.party_id
      LEFT JOIN last_act la ON la.work_item_id = l.work_item_id
      LEFT JOIN app_user u  ON u.party_id = l.advisor_id
      WHERE l.rating <> 'enrolled'
      ORDER BY
        CASE l.rating
          WHEN 'superhot' THEN 0
          WHEN 'hot'      THEN 1
          WHEN 'warm'     THEN 2
          WHEN 'lukewarm' THEN 3
          WHEN 'attempted' THEN 4
          WHEN 'new lead' THEN 5
          ELSE 6
        END,
        l.score DESC NULLS LAST
      LIMIT 25
    `);
    const topLeads = (topLeadsR.rows as Array<Record<string, unknown>>).map((r) => ({
      number: r.number as string,
      name: r.name as string,
      rating: r.rating as string,
      score: r.score == null ? null : Number(r.score),
      program: (r.program as string | null) ?? null,
      city: (r.city as string | null) ?? null,
      value: (r.value as string | null) ?? null,
      daysSinceLastTouch: r.daysSinceLastTouch == null ? null : Math.round(Number(r.daysSinceLastTouch)),
      advisorName: (r.advisorName as string | null) ?? null,
    }));

    // Recent learners (10)
    const learnersR = await db.execute(sql`
      SELECT
        e.party_id   AS "partyId",
        p.name,
        pr.name      AS "program",
        e.created_at AS "enrolledAt",
        e.price_paid AS "pricePaid"
      FROM enrolment e
      JOIN party p       ON p.id  = e.party_id
      LEFT JOIN program pr ON pr.id = e.program_id
      ORDER BY e.created_at DESC
      LIMIT 10
    `);
    const recentLearners = (learnersR.rows as Array<Record<string, unknown>>).map((r) => ({
      partyId: r.partyId as string,
      name: r.name as string,
      program: (r.program as string | null) ?? null,
      enrolledAt: new Date(r.enrolledAt as string).toISOString(),
      pricePaid: r.pricePaid == null ? null : String(r.pricePaid),
    }));

    // Case summary
    const caseStatusR = await db.execute(sql`
      SELECT status, COUNT(*)::int AS count FROM support_case GROUP BY status
    `);
    const caseCategoryR = await db.execute(sql`
      SELECT category, COUNT(*)::int AS count FROM support_case GROUP BY category
    `);
    const recentCaseR = await db.execute(sql`
      SELECT
        wi.number,
        t.subject,
        t.status,
        t.priority,
        u.name AS assignee,
        t.created_at AS "createdAt"
      FROM support_case t
      JOIN work_item wi ON wi.id = t.work_item_id
      LEFT JOIN app_user u ON u.party_id = wi.assignee_id
      WHERE t.status NOT IN ('closed','resolved','cancelled')
      ORDER BY t.created_at DESC
      LIMIT 10
    `);
    const casesSummary = {
      byStatus: Object.fromEntries(
        (caseStatusR.rows as Array<{ status: string; count: number }>).map((r) => [r.status, r.count]),
      ),
      byCategory: Object.fromEntries(
        (caseCategoryR.rows as Array<{ category: string; count: number }>).map((r) => [r.category, r.count]),
      ),
      recent: (recentCaseR.rows as Array<Record<string, unknown>>).map((r) => ({
        number: r.number as string,
        subject: r.subject as string,
        status: r.status as string,
        priority: Number(r.priority),
        assignee: (r.assignee as string | null) ?? null,
        createdAt: new Date(r.createdAt as string).toISOString(),
      })),
    };

    // Cohorts (12 active). A course can live under many programs; surface the
    // first attached program name (by junction rank) as a hint for the narrative.
    const cohortR = await db.execute(sql`
      SELECT
        c.name,
        (SELECT pr.name FROM program_course pc
          JOIN program pr ON pr.id = pc.program_id
          WHERE pc.course_id = co.id
          ORDER BY pc.rank, pr.name LIMIT 1) AS "programName",
        c.status,
        (SELECT COUNT(DISTINCT ba.party_id)::int
         FROM batch_assignment ba
         WHERE ba.cohort_id = c.id) AS assigned,
        c.seats,
        c.start_date AS "startDate"
      FROM cohort c
      LEFT JOIN course co ON co.id = c.course_id
      WHERE c.enabled = true
      ORDER BY c.start_date NULLS LAST
      LIMIT 12
    `);
    const cohorts = (cohortR.rows as Array<Record<string, unknown>>).map((r) => ({
      name: r.name as string,
      programName: (r.programName as string | null) ?? null,
      status: r.status as string,
      assigned: Number(r.assigned) || 0,
      seats: r.seats == null ? null : Number(r.seats),
      startDate: r.startDate ? new Date(r.startDate as string).toISOString().slice(0, 10) : null,
    }));

    // Programs
    const progsR = await db.execute(sql`
      SELECT
        p.id, p.name, p.price, p.enabled,
        (SELECT COUNT(*)::int FROM lead l WHERE l.program_id = p.id AND l.rating <> 'enrolled') AS "activeLeads",
        (SELECT COUNT(*)::int FROM enrolment e WHERE e.program_id = p.id) AS "enrolments"
      FROM program p
      ORDER BY p.name
    `);
    const programs = (progsR.rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      price: r.price == null ? null : Number(r.price),
      enabled: r.enabled as boolean,
      activeLeads: Number(r.activeLeads) || 0,
      enrolments: Number(r.enrolments) || 0,
    }));

    // Users + groups
    const usersR = await db.execute(sql`
      SELECT id, name, email, role, active FROM app_user ORDER BY created_at LIMIT 50
    `);
    const users = (usersR.rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      name: (r.name as string | null) ?? null,
      email: r.email as string,
      role: r.role as string,
      active: r.active as boolean,
    }));

    // Groups + permissions are owned by Auth0 now (Roles + Permissions in
    // the dashboard). The legacy user_group tables were dropped at the
    // Auth0 cutover (post-0039). Edify can still answer questions about
    // permissions by reading the access-token claim downstream, but the
    // snapshot it feeds Claude is just an empty list here.
    const groups: Array<{ name: string; memberCount: number; permissions: number }> = [];

    // Recent agent runs (12)
    const runsR = await db.execute(sql`
      SELECT ar.agent_key AS "agentKey", a.name AS "agentName",
             ar.status, ar.target, ar.started_at AS "startedAt"
      FROM agent_run ar
      JOIN agent a ON a.tenant_id = ar.tenant_id AND a.key = ar.agent_key
      ORDER BY ar.started_at DESC
      LIMIT 12
    `);
    const recentAgentRuns = (runsR.rows as Array<Record<string, unknown>>).map((r) => ({
      agentKey: r.agentKey as string,
      agentName: r.agentName as string,
      status: r.status as string,
      target: (r.target as string | null) ?? null,
      startedAt: new Date(r.startedAt as string).toISOString(),
    }));

    // Approvals (recent 10)
    const apprR = await db.execute(sql`
      SELECT
        a.id,
        a.action_type AS "actionType",
        a.status,
        p.name AS "partyName",
        a.created_at AS "createdAt"
      FROM approval a
      LEFT JOIN work_item wi ON wi.id = a.work_item_id
      LEFT JOIN party p      ON p.id  = wi.party_id
      ORDER BY a.created_at DESC
      LIMIT 10
    `);
    const approvals = (apprR.rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      actionType: r.actionType as string,
      status: r.status as string,
      partyName: (r.partyName as string | null) ?? null,
      createdAt: new Date(r.createdAt as string).toISOString(),
    }));

    // Latest forecast narrative (if any)
    const fcR = await db.execute(sql`
      SELECT narrative FROM forecast_snapshot
      ORDER BY generated_at DESC
      LIMIT 1
    `);
    const forecastNarrative = (fcR.rows[0] as { narrative?: unknown } | undefined)?.narrative ?? null;

    return {
      user,
      totals,
      ratingFunnel,
      topLeads,
      recentLearners,
      casesSummary,
      cohorts,
      programs,
      users,
      groups,
      recentAgentRuns,
      approvals,
      forecastNarrative,
    };
  });

  // Deep-fetch a referenced lead, if the question contains a LEAD-NNNN pattern
  // OR matches one of the topLeads names. Reuses the same loader the Scoring
  // and NBA agents use, so the model sees the full timeline + signals.
  let deepLead: string | null = null;
  const leadNumberMatch = question.match(/\bLEAD-\d+\b/i);
  let leadRefToFetch: string | null = leadNumberMatch ? leadNumberMatch[0].toUpperCase() : null;
  if (!leadRefToFetch) {
    const lower = question.toLowerCase();
    const named = base.topLeads.find((l) => lower.includes(l.name.toLowerCase()));
    if (named) leadRefToFetch = named.number;
  }
  if (leadRefToFetch) {
    try {
      const ctx = await loadLeadContext(tenantId, leadRefToFetch);
      if (ctx) deepLead = renderLeadContextBlock(ctx);
    } catch {
      // Lead lookup failed — keep deepLead null and let Claude work with the
      // top-leads summary alone.
    }
  }

  return {
    generatedAt,
    ...base,
    deepLead,
  };
}

// ── Claude prompt ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Edify Agent, the on-page assistant for an EdTech CRM (Digital Edify).
Answer the user's question using ONLY the data in the provided snapshot. You
do not have access to external tools, the live database, or the internet.
Everything you can use is in the snapshot below.

Hard rules:
- Cite specifics: when you mention a lead, use its number (e.g. LEAD-9810).
  When you mention a learner, use their name. When you mention a case,
  use its number (e.g. CSE-1042).
- Never invent counts, names, lead numbers, or amounts. If the answer is
  not in the snapshot, say so plainly: "I don't see that in your CRM data."
- Be concise. If the user asks "how many", lead with the number.
- Plain English. Don't say "leverage", "synergy", "best-in-class".
- For advice questions ("what should I do today?", "which leads matter
  most?"), draw on the rating funnel, top leads, at-risk signals (silent
  leads, overdue fees), and the latest forecast narrative if present.
- If the question maps to an existing agent action, suggest it via the
  suggestedAction field — but only when it makes obvious sense.

Citations: 0 to 8 entries. Each must reference an entity that ACTUALLY
appears in the snapshot. kind ∈ {"lead","learner","case","program",
"cohort","user","agent"}. ref must be the lead number, party id, case
number, program id, user id, or agent key respectively.

suggestedAction: null OR exactly one of these actions:
- "draft_outreach" (requires leadNumber from snapshot)
- "rescore_lead"   (requires leadNumber from snapshot)
- "refresh_nba"    (requires leadNumber from snapshot)
- "rescore_all"    (no leadNumber — bulk re-score every open lead)
- "run_forecast"   (no leadNumber — refresh tenant-wide forecast)

Output JSON:
{
  "answer": string,
  "citations": [{"kind": string, "ref": string, "label": string}],
  "suggestedAction": null | {
    "action": string,
    "leadNumber": string | null,
    "label": string,
    "rationale": string
  }
}`;

const EdifySchema = z.object({
  answer: z.string().min(1),
  citations: z
    .array(
      z.object({
        kind: z.enum(VALID_CITATION_KINDS),
        ref: z.string().min(1),
        label: z.string().min(1),
      }),
    )
    .default([]),
  suggestedAction: z
    .object({
      action: z.enum(VALID_ACTIONS),
      leadNumber: z.string().nullable().optional(),
      label: z.string().min(1),
      rationale: z.string().min(1),
    })
    .nullable()
    .default(null),
});
type RawEdifyOutput = z.input<typeof EdifySchema>;

function buildUserPrompt(question: string, snapshot: CrmSnapshot): string {
  // Snapshot is serialised compactly. The deep-lead block is appended last
  // since it can be the longest single section.
  const { deepLead, ...rest } = snapshot;
  const snapshotJson = JSON.stringify(rest, null, 2);
  const deepBlock = deepLead
    ? `\n\nDeep context for the lead the question references:\n${deepLead}`
    : "";
  return `Question: ${question}

CRM snapshot (generated ${snapshot.generatedAt}):
${snapshotJson}${deepBlock}`;
}

// ── Output validator ────────────────────────────────────────────────────

function trimAgainstSnapshot(
  raw: RawEdifyOutput,
  snapshot: CrmSnapshot,
): {
  answer: string;
  citations: EdifyCitation[];
  suggestedAction: EdifySuggestedAction | null;
} {
  const validLeadNumbers = new Set(snapshot.topLeads.map((l) => l.number));
  const validLearnerIds = new Set(snapshot.recentLearners.map((l) => l.partyId));
  const validCaseNumbers = new Set(snapshot.casesSummary.recent.map((t) => t.number));
  const validProgramIds = new Set(snapshot.programs.map((p) => p.id));
  const validUserIds = new Set(snapshot.users.map((u) => u.id));
  const validAgentKeys = new Set(snapshot.recentAgentRuns.map((r) => r.agentKey));

  const citations = (raw.citations ?? [])
    .filter((c) => {
      if (!c.label) return false;
      if (c.kind === "lead") return validLeadNumbers.has(c.ref);
      if (c.kind === "learner") return validLearnerIds.has(c.ref);
      if (c.kind === "case") return validCaseNumbers.has(c.ref);
      if (c.kind === "program") return validProgramIds.has(c.ref);
      if (c.kind === "user") return validUserIds.has(c.ref);
      if (c.kind === "agent")
        return (
          validAgentKeys.has(c.ref) ||
          ["outreach", "scoring", "nba", "forecast", "scheduler", "triage", "onboarding", "edify"].includes(c.ref)
        );
      // cohort refs: not exposed in snapshot
      return false;
    })
    .slice(0, 8) as EdifyCitation[];

  let suggestedAction: EdifySuggestedAction | null = null;
  const sa = raw.suggestedAction ?? null;
  if (sa) {
    if (sa.action === "draft_outreach" || sa.action === "rescore_lead" || sa.action === "refresh_nba") {
      if (sa.leadNumber && validLeadNumbers.has(sa.leadNumber)) {
        suggestedAction = {
          action: sa.action,
          leadNumber: sa.leadNumber,
          label: sa.label,
          rationale: sa.rationale,
        };
      }
    } else {
      suggestedAction = { action: sa.action, label: sa.label, rationale: sa.rationale };
    }
  }

  return { answer: raw.answer, citations, suggestedAction };
}

// ── Main entry ──────────────────────────────────────────────────────────

export async function askEdify(
  tenantId: string,
  userId: string,
  question: string,
  /** Existing session id to append to. When omitted/null, a new session is created
   *  with the question's first ~60 chars as its title. */
  sessionId: string | null,
): Promise<EdifyAnswer> {
  const cleanQ = question.trim();
  if (!cleanQ) throw new Error("Question is empty");
  if (cleanQ.length > 1000) throw new Error("Question is too long (max 1000 chars)");

  const snapshot = await buildSnapshot(tenantId, userId, cleanQ);

  const model = makeChatModel({ maxTokens: 1500 }).withStructuredOutput(EdifySchema, {
    name: "edify_answer",
  });
  const raw = await model.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(buildUserPrompt(cleanQ, snapshot)),
  ]);
  const validated = trimAgainstSnapshot(raw, snapshot);
  const resolvedModel = process.env.ANTHROPIC_MODEL ?? null;
  // Token usage isn't surfaced through withStructuredOutput; persist nulls.
  const usage = { in: 0, out: 0 };

  // Resolve session — verify ownership if one was supplied; otherwise create.
  const persisted = await withTenant(tenantId, async (db) => {
    // Phase 2 Party Model: edify_chat_session.user_id and
    // edify_chat_message.user_id both FK party.id now. Resolve the caller's
    // app_user.id → party.id once here.
    const userPartyId = await partyIdFromAppUserId(db, userId);
    if (!userPartyId) throw new Error("askEdify: user has no party record");

    let resolvedSessionId = sessionId;
    if (resolvedSessionId) {
      const ok = await db.execute(sql`
        SELECT id FROM edify_chat_session
        WHERE id = ${resolvedSessionId} AND user_id = ${userPartyId}
      `);
      if (ok.rows.length === 0) resolvedSessionId = null; // fall through to create
    }
    if (!resolvedSessionId) {
      const newSession = await db.execute(sql`
        INSERT INTO edify_chat_session (tenant_id, user_id, title, last_at)
        VALUES (${tenantId}, ${userPartyId}, ${cleanQ.slice(0, 60)}, NOW())
        RETURNING id
      `);
      resolvedSessionId = (newSession.rows[0] as { id: string }).id;
    } else {
      // Touch last_at for sort ordering.
      await db.execute(sql`
        UPDATE edify_chat_session SET last_at = NOW() WHERE id = ${resolvedSessionId}
      `);
    }

    const r = await db.execute(sql`
      INSERT INTO edify_chat_message (
        tenant_id, user_id, session_id, question, answer, citations, suggested,
        model, tokens_in, tokens_out
      ) VALUES (
        ${tenantId}, ${userPartyId}, ${resolvedSessionId}, ${cleanQ}, ${validated.answer},
        ${JSON.stringify(validated.citations)}::jsonb,
        ${validated.suggestedAction ? JSON.stringify(validated.suggestedAction) : null}::jsonb,
        ${resolvedModel}, ${usage.in}, ${usage.out}
      )
      RETURNING id, asked_at
    `);
    const row = r.rows[0] as { id: string; asked_at: string };
    return { messageId: row.id, askedAt: row.asked_at, sessionId: resolvedSessionId };
  });

  // Audit log entry — useful when reviewing what the assistant has been asked.
  await withTenant(tenantId, async (db) => {
    // Phase 3: the "actor" is the human user asking Edify (userId is the
    // acting app_user.id passed in via configurable(state).userId).
    const actorPartyId = await resolveActorPartyId(db, tenantId, userId);
    await db.execute(sql`
      INSERT INTO audit_log (tenant_id, actor_type, actor_party_id, action, target_type, target_id, context)
      VALUES (
        ${tenantId}, 'user', ${actorPartyId}, 'edify_asked', 'edify_chat_message', ${persisted.messageId},
        ${JSON.stringify({ question: cleanQ.slice(0, 200), sessionId: persisted.sessionId, suggestedAction: validated.suggestedAction?.action ?? null, model: resolvedModel, tokensIn: usage.in, tokensOut: usage.out })}::jsonb
      )
    `);
  });

  return {
    messageId: persisted.messageId,
    sessionId: persisted.sessionId,
    question: cleanQ,
    answer: validated.answer,
    citations: validated.citations,
    suggestedAction: validated.suggestedAction,
    askedAt: new Date(persisted.askedAt).toISOString(),
  };
}

// ── Session helpers ────────────────────────────────────────────────────────

export async function listEdifySessions(
  tenantId: string,
  userId: string,
  limit = 50,
): Promise<EdifySessionSummary[]> {
  const safeLimit = Math.min(200, Math.max(1, limit | 0 || 50));
  return await withTenant(tenantId, async (db) => {
    // Phase 2: session.user_id stores party.id.
    const userPartyId = await partyIdFromAppUserId(db, userId);
    if (!userPartyId) return [];
    const r = await db.execute(sql`
      SELECT
        s.id,
        s.title,
        s.created_at AS "createdAt",
        s.last_at    AS "lastAt",
        (SELECT COUNT(*)::int FROM edify_chat_message m WHERE m.session_id = s.id) AS "messageCount",
        (SELECT m.question FROM edify_chat_message m WHERE m.session_id = s.id ORDER BY m.asked_at DESC LIMIT 1) AS "preview"
      FROM edify_chat_session s
      WHERE s.user_id = ${userPartyId}
      ORDER BY s.last_at DESC
      LIMIT ${safeLimit}
    `);
    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      id: row.id as string,
      title: (row.title as string | null) ?? null,
      createdAt: new Date(row.createdAt as string).toISOString(),
      lastAt: new Date(row.lastAt as string).toISOString(),
      messageCount: Number(row.messageCount) || 0,
      preview: row.preview ? String(row.preview).slice(0, 80) : null,
    }));
  });
}

export async function getEdifySession(
  tenantId: string,
  userId: string,
  sessionId: string,
): Promise<{ session: EdifySessionSummary; messages: EdifyAnswer[] } | null> {
  return await withTenant(tenantId, async (db) => {
    const userPartyId = await partyIdFromAppUserId(db, userId);
    if (!userPartyId) return null;
    const sR = await db.execute(sql`
      SELECT
        id, title,
        created_at AS "createdAt",
        last_at    AS "lastAt"
      FROM edify_chat_session
      WHERE id = ${sessionId} AND user_id = ${userPartyId}
      LIMIT 1
    `);
    if (sR.rows.length === 0) return null;
    const s = sR.rows[0] as Record<string, unknown>;

    const mR = await db.execute(sql`
      SELECT id, asked_at AS "askedAt", question, answer, citations, suggested
      FROM edify_chat_message
      WHERE session_id = ${sessionId}
      ORDER BY asked_at ASC
    `);
    const messages: EdifyAnswer[] = (mR.rows as Array<Record<string, unknown>>).map((row) => ({
      messageId: row.id as string,
      sessionId,
      askedAt: new Date(row.askedAt as string).toISOString(),
      question: row.question as string,
      answer: row.answer as string,
      citations: (row.citations as EdifyCitation[] | null) ?? [],
      suggestedAction: (row.suggested as EdifySuggestedAction | null) ?? null,
    }));

    return {
      session: {
        id: s.id as string,
        title: (s.title as string | null) ?? null,
        createdAt: new Date(s.createdAt as string).toISOString(),
        lastAt: new Date(s.lastAt as string).toISOString(),
        messageCount: messages.length,
        preview: messages.length > 0 ? messages[messages.length - 1]!.question.slice(0, 80) : null,
      },
      messages,
    };
  });
}

export async function deleteEdifySession(
  tenantId: string,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  return await withTenant(tenantId, async (db) => {
    const userPartyId = await partyIdFromAppUserId(db, userId);
    if (!userPartyId) return false;
    const r = await db.execute(sql`
      DELETE FROM edify_chat_session
      WHERE id = ${sessionId} AND user_id = ${userPartyId}
      RETURNING id
    `);
    return r.rows.length > 0;
  });
}

export async function renameEdifySession(
  tenantId: string,
  userId: string,
  sessionId: string,
  title: string,
): Promise<boolean> {
  const t = title.trim().slice(0, 200);
  if (!t) throw new Error("title empty");
  return await withTenant(tenantId, async (db) => {
    const userPartyId = await partyIdFromAppUserId(db, userId);
    if (!userPartyId) return false;
    const r = await db.execute(sql`
      UPDATE edify_chat_session
      SET title = ${t}
      WHERE id = ${sessionId} AND user_id = ${userPartyId}
      RETURNING id
    `);
    return r.rows.length > 0;
  });
}
