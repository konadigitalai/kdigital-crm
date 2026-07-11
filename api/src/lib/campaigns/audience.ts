// Campaign audience resolver.
//
// Translates a client-side FilterState tree (the same shape the FE filter
// engine emits in web/src/components/filter/types.ts) into a parameterized
// SQL WHERE over `lead JOIN party`. Returns the matched (party_id, work_item_id)
// tuples so the caller can materialize campaign_recipient rows.
//
// Safety:
//   - Field names come from a strict allowlist (see AUDIENCE_FIELDS below).
//     Anything not in the allowlist is silently dropped so a rogue payload
//     can't inject a column reference.
//   - Values are always bound via Drizzle's tagged template — no string
//     concatenation of user input into SQL.
//   - Only `and`/`or` top-level combinators are respected. Mixing is not
//     supported yet (matches the FE, which is flat).

import { sql, type SQL } from "drizzle-orm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Exec = { execute: (q: SQL) => Promise<any> };

export type OperatorKey =
  | "is" | "is_not"
  | "contains" | "not_contains"
  | "starts_with" | "ends_with"
  | "gt" | "gte" | "lt" | "lte"
  | "between"
  | "is_any_of" | "is_none_of"
  | "is_empty" | "is_not_empty";

export interface FilterRule {
  fieldKey: string;
  operator: OperatorKey;
  value:    unknown;
}

export interface FilterState {
  combinator: "and" | "or";
  rules: FilterRule[];
}

/** Allowed audience fields — must map cleanly to a column on lead or party.
 *  `expr` is spliced raw into SQL (safe: string constant), so it may include
 *  a table qualifier and an optional cast (e.g. "l.stage", "p.name",
 *  "l.next_followup_at::timestamptz"). `kind` tells the resolver which
 *  operators are valid. */
type FieldKind = "text" | "number" | "enum" | "date";
interface AudienceField {
  expr: string;
  kind: FieldKind;
}

const AUDIENCE_FIELDS: Record<string, AudienceField> = {
  // Party (contact) columns
  name:              { expr: "p.name",             kind: "text"   },
  email:             { expr: "p.email",            kind: "text"   },
  phone:             { expr: "p.phone",            kind: "text"   },
  city:              { expr: "p.city",             kind: "text"   },

  // Lead columns
  number:            { expr: "wi.number",          kind: "text"   },
  program:           { expr: "l.program",          kind: "text"   },
  source:            { expr: "l.source",           kind: "text"   },
  sourceLabel:       { expr: "l.source_label",     kind: "text"   },
  stage:             { expr: "l.stage",            kind: "enum"   },
  stageLabel:        { expr: "l.stage_label",      kind: "text"   },
  heat:              { expr: "l.heat",             kind: "enum"   },
  rating:            { expr: "l.rating",           kind: "enum"   },
  score:             { expr: "l.score",            kind: "number" },
  value:             { expr: "l.value",            kind: "number" },
  feePaid:           { expr: "l.fee_paid",         kind: "number" },
  feeDue:            { expr: "l.fee_due",          kind: "number" },
  leadStatus:        { expr: "l.lead_status",      kind: "text"   },
  deliveryMode:      { expr: "l.delivery_mode",    kind: "text"   },
  nextFollowupAt:    { expr: "l.next_followup_at", kind: "date"   },
  demoAttendedAt:    { expr: "l.demo_attended_at", kind: "date"   },
  visitedDate:       { expr: "l.visited_date",     kind: "date"   },
  visitingDate:      { expr: "l.visiting_date",    kind: "date"   },
  registeredDate:    { expr: "l.registered_date",  kind: "date"   },
  createdAt:         { expr: "wi.created_at",      kind: "date"   },
};

export function listAudienceFields(): string[] {
  return Object.keys(AUDIENCE_FIELDS);
}

/** Build a single rule's WHERE fragment. Returns null if the rule references
 *  an unknown field or an operator that doesn't apply — the caller should
 *  drop null fragments before combining. */
function ruleToSql(rule: FilterRule): SQL | null {
  const field = AUDIENCE_FIELDS[rule.fieldKey];
  if (!field) return null;
  const col = sql.raw(field.expr);
  const v = rule.value;

  switch (rule.operator) {
    case "is":
      return sql`${col} = ${normalize(v, field.kind)}`;
    case "is_not":
      return sql`${col} IS DISTINCT FROM ${normalize(v, field.kind)}`;
    case "contains":
      return field.kind === "text"
        ? sql`${col} ILIKE ${"%" + String(v ?? "") + "%"}`
        : null;
    case "not_contains":
      return field.kind === "text"
        ? sql`(${col} IS NULL OR ${col} NOT ILIKE ${"%" + String(v ?? "") + "%"})`
        : null;
    case "starts_with":
      return field.kind === "text"
        ? sql`${col} ILIKE ${String(v ?? "") + "%"}`
        : null;
    case "ends_with":
      return field.kind === "text"
        ? sql`${col} ILIKE ${"%" + String(v ?? "")}`
        : null;
    case "gt":
      return sql`${col} >  ${normalize(v, field.kind)}`;
    case "gte":
      return sql`${col} >= ${normalize(v, field.kind)}`;
    case "lt":
      return sql`${col} <  ${normalize(v, field.kind)}`;
    case "lte":
      return sql`${col} <= ${normalize(v, field.kind)}`;
    case "between": {
      if (!Array.isArray(v) || v.length !== 2) return null;
      return sql`${col} BETWEEN ${normalize(v[0], field.kind)} AND ${normalize(v[1], field.kind)}`;
    }
    case "is_any_of": {
      const arr = Array.isArray(v) ? v : [];
      if (arr.length === 0) return null;
      const bound = arr.map((el) => normalize(el, field.kind));
      const list = sql.join(bound.map((b) => sql`${b}`), sql`, `);
      return sql`${col} IN (${list})`;
    }
    case "is_none_of": {
      const arr = Array.isArray(v) ? v : [];
      if (arr.length === 0) return null;
      const bound = arr.map((el) => normalize(el, field.kind));
      const list = sql.join(bound.map((b) => sql`${b}`), sql`, `);
      return sql`(${col} IS NULL OR ${col} NOT IN (${list}))`;
    }
    case "is_empty":
      return sql`(${col} IS NULL${field.kind === "text" ? sql` OR ${col} = ''` : sql``})`;
    case "is_not_empty":
      return sql`(${col} IS NOT NULL${field.kind === "text" ? sql` AND ${col} <> ''` : sql``})`;
  }
}

function normalize(v: unknown, kind: FieldKind): string | number | null {
  if (v === null || v === undefined || v === "") return null;
  if (kind === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return String(v);
}

/** Build the WHERE clause for a full filter tree. Returns `sql`TRUE`` when
 *  no rules produce a fragment (i.e. audience = everyone in the lead pool). */
function stateToWhere(state: FilterState): SQL {
  const parts = (state.rules ?? [])
    .map(ruleToSql)
    .filter((f): f is SQL => f !== null);
  if (parts.length === 0) return sql`TRUE`;
  const joiner = state.combinator === "or" ? sql` OR ` : sql` AND `;
  return sql`(${sql.join(parts, joiner)})`;
}

// ─── Public API ───────────────────────────────────────────────────────────

export interface AudienceRow {
  partyId:      string;
  workItemId:   string;
  name:         string | null;
  phone:        string | null;
  leadNumber:   string;
  program:      string | null;
  stage:        string | null;
}

export interface ResolveOpts {
  /** Cap the number of rows returned. Defaults to 5000. */
  limit?: number;
  /** Optional COUNT-only mode. Returns count in `.count` and empty rows. */
  countOnly?: boolean;
}

/** Resolve an audience filter into a set of live-lead rows. */
export async function resolveAudience(
  db: Exec,
  state: FilterState,
  opts: ResolveOpts = {},
): Promise<{ count: number; rows: AudienceRow[] }> {
  const where = stateToWhere(state);
  const limit = Math.min(Math.max(opts.limit ?? 5000, 1), 50000);

  // Only "live" leads — same predicate used by GET /leads.
  const liveLead = sql`
    EXISTS (
      SELECT 1 FROM party_role pr
      WHERE pr.party_id = p.id
        AND pr.role     = 'lead'
        AND pr.valid_to IS NULL
    )
  `;

  if (opts.countOnly) {
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM lead l
      JOIN work_item wi ON wi.id = l.work_item_id
      JOIN party p      ON p.id  = wi.party_id
      WHERE ${liveLead} AND ${where}
    `);
    return { count: Number((r.rows[0] as { count: number })?.count ?? 0), rows: [] };
  }

  const r = await db.execute(sql`
    SELECT
      p.id       AS "partyId",
      wi.id      AS "workItemId",
      wi.number  AS "leadNumber",
      p.name     AS name,
      p.phone    AS phone,
      l.program  AS program,
      l.stage    AS stage
    FROM lead l
    JOIN work_item wi ON wi.id = l.work_item_id
    JOIN party p      ON p.id  = wi.party_id
    WHERE ${liveLead} AND ${where}
    ORDER BY wi.created_at DESC
    LIMIT ${limit}
  `);
  const rows = r.rows as AudienceRow[];
  return { count: rows.length, rows };
}
