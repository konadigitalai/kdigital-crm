// Manual "Share to Slack" — surface-specific field whitelists, record
// fetchers, and Block Kit renderers. Distinct from `slack.ts` (which is
// for automated event posts). Both end up calling the same low-level
// `postToSlack` and writing to `slack_delivery_log`.
//
// Three surfaces today: leads, learners, cases. Adding a fourth means:
//   1. Add it to SURFACES below
//   2. Add a fetchRecord_<surface>() that returns a flat record
//   3. Add a SHARE_FIELDS_<surface> array of field metadata
//   4. Update routeUrlFor() if the deep-link path differs

import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";
import type { SlackBlock, SlackPayload } from "./slack";

export type ShareSurface = "leads" | "learners" | "cases";
export const SHARE_SURFACES: readonly ShareSurface[] = ["leads", "learners", "cases"];
export function isShareSurface(s: string): s is ShareSurface {
  return (SHARE_SURFACES as readonly string[]).includes(s);
}

// ─── Field whitelists ─────────────────────────────────────────────────────
//
// Single source of truth for "what can an admin pick to include in shares?"
// Each entry: stable key (used in DB + UI checkbox), human label, optional
// formatter. The formatter receives the flat record returned by fetchRecord.
//
// Keep entries small and presentation-friendly — these end up in Slack.

export interface ShareField {
  key: string;
  label: string;
  // Read the value from the flat record. Returns null/undefined to omit the row.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  read: (record: Record<string, any>) => string | number | null | undefined;
}

const SHARE_FIELDS_LEADS: ShareField[] = [
  { key: "name",         label: "Name",          read: (r) => r.name },
  { key: "number",       label: "Lead #",        read: (r) => r.number },
  { key: "phone",        label: "Phone",         read: (r) => joinPhone(r.phoneCountryCode, r.phone) },
  { key: "email",        label: "Email",         read: (r) => r.email },
  { key: "city",         label: "City",          read: (r) => r.city },
  { key: "program",      label: "Program",       read: (r) => r.program },
  { key: "source",       label: "Source",        read: (r) => r.sourceLabel ?? r.source },
  { key: "advisorName",  label: "Advisor",       read: (r) => r.advisorName },
  { key: "stage",        label: "Stage",         read: (r) => r.stageLabel ?? r.stage },
  { key: "rating",       label: "Rating",        read: (r) => r.rating },
  { key: "score",        label: "Score",         read: (r) => r.score },
  { key: "heat",         label: "Heat",          read: (r) => r.heat },
  { key: "value",        label: "Price quoted",  read: (r) => r.value ? `₹${Number(r.value).toLocaleString("en-IN")}` : null },
  { key: "nextFollowupAt", label: "Next follow-up", read: (r) => fmtDate(r.nextFollowupAt) },
  { key: "demoAttendedAt", label: "Demo attended",  read: (r) => fmtDate(r.demoAttendedAt) },
  { key: "description",  label: "Description",   read: (r) => r.description },
];

const SHARE_FIELDS_LEARNERS: ShareField[] = [
  { key: "name",          label: "Name",            read: (r) => r.name },
  { key: "phone",         label: "Phone",           read: (r) => joinPhone(r.phoneCountryCode, r.phone) },
  { key: "email",         label: "Email",           read: (r) => r.email },
  { key: "city",          label: "City",            read: (r) => r.city },
  { key: "primaryProgram", label: "Program",        read: (r) => r.primaryProgram },
  { key: "primaryStatus",  label: "Program status", read: (r) => r.primaryStatus },
  { key: "totalCourses",  label: "Courses",         read: (r) => r.totalCourses },
  { key: "activeCourses", label: "Active courses",  read: (r) => r.activeCourses },
  { key: "totalBatches",  label: "Batches",         read: (r) => r.totalBatches },
  { key: "activeBatches", label: "Active batches",  read: (r) => r.activeBatches },
  { key: "learnerSince",  label: "Learner since",   read: (r) => fmtDate(r.learnerSince) },
];

const SHARE_FIELDS_CASES: ShareField[] = [
  { key: "number",         label: "Case #",       read: (r) => r.number },
  { key: "subject",        label: "Subject",      read: (r) => r.subject },
  { key: "status",         label: "Status",       read: (r) => r.status },
  { key: "priority",       label: "Priority",     read: (r) => priorityLabel(r.priority) },
  { key: "category",       label: "Category",     read: (r) => r.category },
  { key: "requesterName",  label: "Requester",    read: (r) => r.requesterName },
  { key: "requesterEmail", label: "Email",        read: (r) => r.requesterEmail },
  { key: "requesterPhone", label: "Phone",        read: (r) => r.requesterPhone },
  { key: "assigneeName",   label: "Assignee",     read: (r) => r.assigneeName ?? "unassigned" },
  { key: "dueAt",          label: "Due",          read: (r) => fmtDateTime(r.dueAt) },
  { key: "createdAt",      label: "Opened",       read: (r) => fmtDateTime(r.createdAt) },
  { key: "description",    label: "Description",  read: (r) => r.description },
];

export const SHARE_FIELD_CATALOG: Record<ShareSurface, ShareField[]> = {
  leads:    SHARE_FIELDS_LEADS,
  learners: SHARE_FIELDS_LEARNERS,
  cases:    SHARE_FIELDS_CASES,
};

// Sensible defaults so the admin UI starts somewhere reasonable.
export const SHARE_DEFAULT_KEYS: Record<ShareSurface, string[]> = {
  leads:    ["name", "phone", "email", "program", "source", "advisorName"],
  learners: ["name", "phone", "email", "primaryProgram", "primaryStatus"],
  cases:    ["number", "subject", "priority", "category", "requesterName", "assigneeName"],
};

// ─── Record fetchers ──────────────────────────────────────────────────────
//
// Each returns a flat object the field readers can pluck from, or null if
// the record doesn't exist. We do these inside withTenant so RLS scopes.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchShareRecord(surface: ShareSurface, tenantId: string, recordId: string): Promise<Record<string, any> | null> {
  if (surface === "leads")    return fetchLead(tenantId, recordId);
  if (surface === "learners") return fetchLearner(tenantId, recordId);
  if (surface === "cases")    return fetchCase(tenantId, recordId);
  return null;
}

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchLead(tenantId: string, idOrNumber: string): Promise<Record<string, any> | null> {
  return withTenant(tenantId, async (db) => {
    const r = await db.execute(
      isUuid(idOrNumber)
        ? sql`
            SELECT
              wi.id, wi.number,
              p.name, p.email, p.phone, p.phone_country_code AS "phoneCountryCode", p.city,
              l.program, l.source, l.source_label AS "sourceLabel",
              l.value, l.stage, l.stage_label AS "stageLabel",
              l.score, l.heat, l.rating,
              l.description,
              l.next_followup_at AS "nextFollowupAt",
              l.demo_attended_at AS "demoAttendedAt",
              u.name AS "advisorName"
            FROM lead l
            JOIN work_item wi ON wi.id = l.work_item_id
            JOIN party p ON p.id = wi.party_id
            LEFT JOIN app_user u ON u.party_id = l.advisor_id
            WHERE wi.id = ${idOrNumber} AND wi.type = 'lead'
            LIMIT 1
          `
        : sql`
            SELECT
              wi.id, wi.number,
              p.name, p.email, p.phone, p.phone_country_code AS "phoneCountryCode", p.city,
              l.program, l.source, l.source_label AS "sourceLabel",
              l.value, l.stage, l.stage_label AS "stageLabel",
              l.score, l.heat, l.rating,
              l.description,
              l.next_followup_at AS "nextFollowupAt",
              l.demo_attended_at AS "demoAttendedAt",
              u.name AS "advisorName"
            FROM lead l
            JOIN work_item wi ON wi.id = l.work_item_id
            JOIN party p ON p.id = wi.party_id
            LEFT JOIN app_user u ON u.party_id = l.advisor_id
            WHERE wi.number = ${idOrNumber} AND wi.type = 'lead'
            LIMIT 1
          `,
    );
    return (r.rows[0] as Record<string, unknown>) ?? null;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchLearner(tenantId: string, partyId: string): Promise<Record<string, any> | null> {
  return withTenant(tenantId, async (db) => {
    if (!isUuid(partyId)) return null;
    const r = await db.execute(sql`
      SELECT
        p.id   AS "partyId",
        p.name, p.email, p.phone, p.phone_country_code AS "phoneCountryCode", p.city,
        (
          SELECT pr.valid_from FROM party_role pr
          WHERE pr.party_id = p.id AND pr.role = 'learner' ORDER BY valid_from ASC LIMIT 1
        ) AS "learnerSince",
        (
          SELECT pgm.name FROM enrolment e
          JOIN program pgm ON pgm.id = e.program_id
          WHERE e.party_id = p.id ORDER BY e.created_at DESC LIMIT 1
        ) AS "primaryProgram",
        (
          SELECT e.status FROM enrolment e
          WHERE e.party_id = p.id ORDER BY e.created_at DESC LIMIT 1
        ) AS "primaryStatus",
        (SELECT COUNT(*)::int FROM course_assignment ca WHERE ca.party_id = p.id) AS "totalCourses",
        (SELECT COUNT(*)::int FROM course_assignment ca WHERE ca.party_id = p.id AND ca.status = 'active') AS "activeCourses",
        (SELECT COUNT(*)::int FROM batch_assignment ba WHERE ba.party_id = p.id) AS "totalBatches",
        (SELECT COUNT(*)::int FROM batch_assignment ba WHERE ba.party_id = p.id AND ba.status = 'active') AS "activeBatches"
      FROM party p
      WHERE p.id = ${partyId}
        AND EXISTS (
          SELECT 1 FROM party_role pr WHERE pr.party_id = p.id AND pr.role = 'learner'
        )
      LIMIT 1
    `);
    return (r.rows[0] as Record<string, unknown>) ?? null;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchCase(tenantId: string, idOrNumber: string): Promise<Record<string, any> | null> {
  return withTenant(tenantId, async (db) => {
    const r = await db.execute(
      isUuid(idOrNumber)
        ? sql`
            SELECT
              wi.id, wi.number, wi.created_at AS "createdAt",
              t.subject, t.description, t.category, t.priority, t.status,
              t.requester_name AS "requesterName",
              t.requester_email AS "requesterEmail",
              t.requester_phone AS "requesterPhone",
              t.due_at AS "dueAt",
              u.name AS "assigneeName"
            FROM support_case t
            JOIN work_item wi ON wi.id = t.work_item_id
            LEFT JOIN app_user u ON u.party_id = wi.assignee_id
            WHERE wi.id = ${idOrNumber} AND wi.type = 'support_case'
            LIMIT 1
          `
        : sql`
            SELECT
              wi.id, wi.number, wi.created_at AS "createdAt",
              t.subject, t.description, t.category, t.priority, t.status,
              t.requester_name AS "requesterName",
              t.requester_email AS "requesterEmail",
              t.requester_phone AS "requesterPhone",
              t.due_at AS "dueAt",
              u.name AS "assigneeName"
            FROM support_case t
            JOIN work_item wi ON wi.id = t.work_item_id
            LEFT JOIN app_user u ON u.party_id = wi.assignee_id
            WHERE wi.number = ${idOrNumber} AND wi.type = 'support_case'
            LIMIT 1
          `,
    );
    return (r.rows[0] as Record<string, unknown>) ?? null;
  });
}

// ─── Block Kit rendering ──────────────────────────────────────────────────

const HEADER_DEFAULTS: Record<ShareSurface, (r: Record<string, unknown>) => string> = {
  leads:    (r) => `📇 Lead — ${(r.number as string) ?? ""}: ${(r.name as string) ?? ""}`,
  learners: (r) => `🎓 Learner — ${(r.name as string) ?? ""}`,
  cases:    (r) => `🆘 Case — ${(r.number as string) ?? ""}: ${(r.subject as string) ?? ""}`,
};

const ROUTE_BASE: Record<ShareSurface, string> = {
  leads:    "/records",
  learners: "/learners",
  cases:    "/cases",
};

export function renderShare(opts: {
  surface: ShareSurface;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  record: Record<string, any>;
  fieldKeys: string[];
  headerTemplate: string | null;
  notes: string | null;
  sharedByName: string | null;
}): SlackPayload {
  const { surface, record, fieldKeys, headerTemplate, notes, sharedByName } = opts;
  const catalog = SHARE_FIELD_CATALOG[surface];
  const fields: { type: string; text: string }[] = [];
  for (const key of fieldKeys) {
    const def = catalog.find((f) => f.key === key);
    if (!def) continue;
    const v = def.read(record);
    if (v == null || v === "") continue;
    fields.push({ type: "mrkdwn", text: `*${def.label}*\n${String(v)}` });
  }

  const headerText = headerTemplate
    ? substitute(headerTemplate, record)
    : HEADER_DEFAULTS[surface](record);

  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: headerText } },
  ];
  if (fields.length > 0) {
    // Slack caps a section at 10 fields; chunk if needed.
    for (let i = 0; i < fields.length; i += 10) {
      blocks.push({ type: "section", fields: fields.slice(i, i + 10) });
    }
  }
  if (notes && notes.trim()) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Notes from ${sharedByName ?? "the team"}*\n${notes.trim()}` },
    });
  }

  // Deep-link button + fallback context line.
  const recordKey = surface === "learners" ? record.partyId : record.number;
  if (recordKey) {
    const base = (process.env.WEB_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
    const url = `${base}${ROUTE_BASE[surface]}/${encodeURIComponent(String(recordKey))}`;
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View in CRM" },
          url,
          style: "primary",
          action_id: "view_in_crm",
        },
      ],
    });
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${url}|Open in CRM>` }],
    });
  }

  return { text: headerText, blocks };
}

// ─── helpers ──────────────────────────────────────────────────────────────

function substitute(template: string, payload: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = payload[key];
    if (v == null) return "—";
    return String(v);
  });
}

function joinPhone(cc: unknown, phone: unknown): string | null {
  const c = cc != null && String(cc).trim() ? String(cc).trim() : "";
  const p = phone != null && String(phone).trim() ? String(phone).trim() : "";
  if (!c && !p) return null;
  return [c, p].filter(Boolean).join(" ");
}

function fmtDate(v: unknown): string | null {
  if (!v) return null;
  try {
    return new Date(String(v)).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  } catch { return String(v); }
}
function fmtDateTime(v: unknown): string | null {
  if (!v) return null;
  try {
    return new Date(String(v)).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
  } catch { return String(v); }
}

function priorityLabel(p: unknown): string {
  const n = Number(p);
  if (n === 1) return "Urgent";
  if (n === 2) return "High";
  if (n === 3) return "Medium";
  if (n === 4) return "Low";
  return String(p);
}
