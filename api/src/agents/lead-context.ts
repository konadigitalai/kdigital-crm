// Shared lead-context loader. Both the Scoring agent and the NBA agent need
// the same rich slice of lead state to produce useful output: profile, payment
// trail, free-form description, recent activity (with payload + channel +
// actor), previous AI judgement, identifiers, attributes, rating.
//
// This file is the single source of truth for "what does Claude see when it
// reasons about a lead". Adding a new field once → both agents pick it up.

import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

export interface ActivityRow {
  actorType: string | null;
  actorName: string | null;
  channel: string | null;
  verb: string;
  detail: string | null;
  tag: string | null;
  payload: unknown;
  ts: Date;
}

export interface LeadContext {
  workItemId: string;
  number: string;
  partyId: string;
  name: string;
  email: string | null;
  phone: string | null;
  program: string | null;
  city: string | null;
  source: string | null;
  sourceLabel: string | null;
  stage: string | null;
  stageLabel: string | null;
  description: string | null;
  value: string | null;
  advisorName: string | null;
  identifiers: unknown;
  attributes: unknown;
  // Money / payment trail
  feePaid: string | null;
  feeDue: string | null;
  dueDate: Date | null;
  registeredDate: Date | null;
  paymentProofUrl: string | null;
  // Previous AI judgement
  prevScore: number | null;
  prevHeat: string | null;
  rating: string;
  prevScoreReason: string | null;
  prevScoreLabel: string | null;
  prevScoreDesc: string | null;
  nbaHeadline: string | null;
  nbaWhy: string | null;
  nbaConfidence: number | null;
  prevSignals: { text: string; weight: string; kind: string }[];
  recentActivity: ActivityRow[];
  noteCount: number;
  ageDays: number | null;
  daysSinceLastTouch: number | null;
}

export async function loadLeadContext(
  tenantId: string,
  idOrNumber: string,
): Promise<LeadContext | null> {
  return await withTenant(tenantId, async (db) => {
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(idOrNumber);
    const baseSql = sql`
      SELECT
        wi.id              AS "workItemId",
        wi.number          AS "number",
        wi.party_id        AS "partyId",
        wi.created_at      AS "leadCreatedAt",
        p.name, p.email AS "partyEmail", p.phone AS "partyPhone",
        p.identifiers, p.attributes AS "partyAttributes",
        l.program, l.city, l.source, l.source_label AS "sourceLabel",
        l.stage, l.stage_label AS "stageLabel",
        l.value, l.description,
        l.score AS "prevScore", l.heat AS "prevHeat", l.rating AS "rating",
        l.score_reason AS "prevScoreReason",
        l.score_label  AS "prevScoreLabel",
        l.score_desc   AS "prevScoreDesc",
        l.nba_headline AS "nbaHeadline",
        l.nba_why      AS "nbaWhy",
        l.nba_confidence AS "nbaConfidence",
        l.fee_paid AS "feePaid",
        l.fee_due  AS "feeDue",
        l.due_date AS "dueDate",
        l.registered_date AS "registeredDate",
        l.payment_proof_url AS "paymentProofUrl",
        u.name AS "advisorName"
      FROM lead l
      JOIN work_item wi ON wi.id = l.work_item_id
      JOIN party p      ON p.id  = wi.party_id
      LEFT JOIN app_user u ON u.id = l.advisor_id`;
    const r = await db.execute(
      isUuid
        ? sql`${baseSql} WHERE wi.id = ${idOrNumber} LIMIT 1`
        : sql`${baseSql} WHERE wi.number = ${idOrNumber} LIMIT 1`,
    );
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const workItemId = row.workItemId as string;

    const sigs = await db.execute(sql`
      SELECT text, weight, kind FROM lead_score_signal
      WHERE work_item_id = ${workItemId}
      ORDER BY rank
      LIMIT 12
    `);

    const acts = await db.execute(sql`
      SELECT actor_type AS "actorType", actor_name AS "actorName",
             channel, verb, detail, tag, payload, ts
      FROM activity
      WHERE work_item_id = ${workItemId}
      ORDER BY ts DESC
      LIMIT 15
    `);

    const noteCountR = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM activity
      WHERE work_item_id = ${workItemId}
        AND (verb ILIKE '%note%' OR (payload ->> 'kind') = 'note')
    `);
    const noteCount = Number((noteCountR.rows[0] as { n: number }).n);

    const leadCreatedAt = row.leadCreatedAt as Date | null;
    const ageDays = leadCreatedAt
      ? Math.max(0, Math.round((Date.now() - new Date(leadCreatedAt).getTime()) / 86_400_000))
      : null;
    const lastTs = (acts.rows[0] as { ts?: Date } | undefined)?.ts;
    const daysSinceLastTouch = lastTs
      ? Math.max(0, Math.round((Date.now() - new Date(lastTs).getTime()) / 86_400_000))
      : null;

    const partyAttrs = row.partyAttributes && typeof row.partyAttributes === "object"
      ? row.partyAttributes
      : null;

    return {
      workItemId,
      number: row.number as string,
      partyId: row.partyId as string,
      name: row.name as string,
      email: (row.partyEmail as string | null) ?? null,
      phone: (row.partyPhone as string | null) ?? null,
      program: (row.program as string | null) ?? null,
      city: (row.city as string | null) ?? null,
      source: (row.source as string | null) ?? null,
      sourceLabel: (row.sourceLabel as string | null) ?? null,
      stage: (row.stage as string | null) ?? null,
      stageLabel: (row.stageLabel as string | null) ?? null,
      description: (row.description as string | null) ?? null,
      value: (row.value as string | null) ?? null,
      advisorName: (row.advisorName as string | null) ?? null,
      identifiers: row.identifiers ?? null,
      attributes: partyAttrs,
      feePaid: (row.feePaid as string | null) ?? null,
      feeDue: (row.feeDue as string | null) ?? null,
      dueDate: (row.dueDate as Date | null) ?? null,
      registeredDate: (row.registeredDate as Date | null) ?? null,
      paymentProofUrl: (row.paymentProofUrl as string | null) ?? null,
      prevScore: (row.prevScore as number | null) ?? null,
      prevHeat: (row.prevHeat as string | null) ?? null,
      rating: (row.rating as string | null) ?? "new lead",
      prevScoreReason: (row.prevScoreReason as string | null) ?? null,
      prevScoreLabel: (row.prevScoreLabel as string | null) ?? null,
      prevScoreDesc: (row.prevScoreDesc as string | null) ?? null,
      nbaHeadline: (row.nbaHeadline as string | null) ?? null,
      nbaWhy: (row.nbaWhy as string | null) ?? null,
      nbaConfidence: (row.nbaConfidence as number | null) ?? null,
      prevSignals: sigs.rows as { text: string; weight: string; kind: string }[],
      recentActivity: acts.rows as unknown as ActivityRow[],
      noteCount,
      ageDays,
      daysSinceLastTouch,
    };
  });
}

// ─── Formatting helpers — used by every agent's prompt builder. ───────────

export function formatActivity(a: ActivityRow): string {
  const when = a.ts ? new Date(a.ts).toISOString().replace("T", " ").slice(0, 16) : "unknown";
  const who = a.actorName ?? a.actorType ?? "unknown";
  const channel = a.channel ? ` [${a.channel}]` : "";
  const tag = a.tag ? ` (${a.tag})` : "";
  const payload =
    a.payload && typeof a.payload === "object"
      ? Object.entries(a.payload as Record<string, unknown>)
          .filter(([k]) => !["approvalId", "runWorkItemId", "iconKey", "iconBg", "iconStroke"].includes(k))
          .map(([k, v]) => {
            const s = typeof v === "string" ? v : JSON.stringify(v);
            return s && s !== "null" ? `${k}: ${s.slice(0, 220)}` : null;
          })
          .filter(Boolean)
          .join(" · ")
      : "";
  const detail = a.detail ? `: ${a.detail.slice(0, 220)}` : "";
  const tail = payload ? `  ⤷ ${payload}` : "";
  return `  - [${when}] ${who}${channel}${tag} — ${a.verb}${detail}${tail}`;
}

export function fmtINR(s: string | null): string {
  if (!s) return "—";
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return `₹${n.toLocaleString("en-IN")}`;
}

export function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toISOString().slice(0, 10);
}

export function compactJson(o: unknown): string {
  if (!o) return "—";
  if (typeof o === "object" && Object.keys(o as object).length === 0) return "—";
  try {
    const s = JSON.stringify(o);
    return s.length > 400 ? s.slice(0, 397) + "…" : s;
  } catch {
    return "—";
  }
}

// Big rendered block that summarises a lead in a uniform way for any agent.
// Drop into the user-prompt followed by your task-specific question.
export function renderLeadContextBlock(c: LeadContext): string {
  const sigs = c.prevSignals.length
    ? c.prevSignals.map((s) => `  - [${s.weight}] (${s.kind}) ${s.text}`).join("\n")
    : "  (none)";
  const acts = c.recentActivity.length
    ? c.recentActivity.map(formatActivity).join("\n")
    : "  (no activity logged)";

  const moneyTrail =
    c.feePaid || c.feeDue || c.registeredDate || c.dueDate || c.paymentProofUrl
      ? `Money / payment trail:
- Fee paid:        ${fmtINR(c.feePaid)}
- Fee due:         ${fmtINR(c.feeDue)}
- Registered on:   ${fmtDate(c.registeredDate)}
- Due date:        ${fmtDate(c.dueDate)}
- Payment proof:   ${c.paymentProofUrl ? "uploaded" : "—"}`
      : "Money / payment trail: nothing recorded yet.";

  const prevAssessment =
    c.prevScore != null
      ? `Previous AI score:
- Score:        ${c.prevScore} (heat: ${c.prevHeat ?? "n/a"})
- Label:        ${c.prevScoreLabel ?? "—"}
- One-liner:    ${c.prevScoreDesc ?? "—"}
- Reason:       ${c.prevScoreReason ?? "—"}`
      : "Previous AI score: this lead has not been scored before.";

  const lastNba =
    c.nbaHeadline || c.nbaWhy
      ? `Last suggested next-best-action:
- Confidence: ${c.nbaConfidence ?? "—"}
- Headline:   ${c.nbaHeadline ?? "—"}
- Why:        ${c.nbaWhy ?? "—"}`
      : "Last suggested next-best-action: none recorded.";

  return `Lead profile:
- Name:           ${c.name}
- Email / phone:  ${c.email ?? "—"} / ${c.phone ?? "—"}
- City:           ${c.city ?? "unknown"}
- Program:        ${c.program ?? "unspecified"}
- Source:         ${c.sourceLabel ?? c.source ?? "unspecified"}
- Human rating:   ${c.rating}                              (strong prior set by an advisor)
- Lead value:     ${c.value ?? "—"}            (free-form: may be a price, "verbal yes", etc.)
- Advisor owner:  ${c.advisorName ?? "unassigned"}
- Lead age:       ${c.ageDays != null ? `${c.ageDays} day(s)` : "—"}
- Last touched:   ${c.daysSinceLastTouch != null ? `${c.daysSinceLastTouch} day(s) ago` : "—"}
- Notes logged:   ${c.noteCount}

Free-form description (entered by an advisor):
${c.description ? c.description.split("\n").map((l) => "  " + l).join("\n") : "  (none)"}

Identifiers (external IDs / handles):    ${compactJson(c.identifiers)}
Lead attributes JSONB:                  ${compactJson(c.attributes)}

${moneyTrail}

${prevAssessment}

${lastNba}

Score signals already credited:
${sigs}

Recent timeline (newest first):
${acts}`;
}
