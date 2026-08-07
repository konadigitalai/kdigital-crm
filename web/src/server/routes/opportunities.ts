// B2B opportunity pipeline — /opportunities.
//
// An opportunity IS a `deal`, which sits on the work_item spine. That spine
// already supplies the number (DEAL-3142), the owner, the open/closed state,
// the priority and — importantly — the activity timeline, so a corporate deal
// gets notes, calls and emails through exactly the same machinery a lead does.
// This router owns the sales-specific half: stage, amount, close dates.
//
// Two invariants are enforced in SQL rather than here, so no code path can
// skip them: a closed deal has an actual_close_date and an open one does not
// (deal_close_date_check), and stage_updated_at is stamped by a trigger when
// the stage actually moves. "Days in stage" is therefore a real number.

import { Router } from "@/server/http";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";

export const opportunitiesRouter = Router();

const UUID = /^[0-9a-fA-F-]{36}$/;

const STAGES = ["qualification", "discovery", "proposal", "negotiation", "closed_won", "closed_lost"] as const;
const CLOSED_STAGES = ["closed_won", "closed_lost"] as const;
const TYPES = ["corporate_training", "hiring", "consulting", "renewal", "upsell"] as const;

type Stage = typeof STAGES[number];

function pickEnum<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  if (!(allowed as readonly string[]).includes(s)) {
    throw Object.assign(new Error(`${field} must be one of: ${allowed.join(", ")}`), { code: "BAD_ENUM" });
  }
  return s as T[number];
}

const isClosed = (s: string) => (CLOSED_STAGES as readonly string[]).includes(s);

const OPP_SELECT = sql`
  SELECT
    d.work_item_id AS "workItemId",
    wi.number,
    d.name,
    d.stage,
    d.stage_updated_at AS "stageUpdatedAt",
    -- What the board renders as "14d in stage". Computed here so every caller
    -- gets the same number.
    GREATEST(0, EXTRACT(DAY FROM (now() - d.stage_updated_at))::int) AS "daysInStage",
    d.opportunity_type AS "opportunityType",
    d.value,
    d.currency,
    d.probability,
    d.expected_revenue     AS "expectedRevenue",
    d.expected_close_date  AS "expectedCloseDate",
    d.actual_close_date    AS "actualCloseDate",
    d.next_action          AS "nextAction",
    d.description,
    d.account_party_id     AS "accountPartyId",
    acc.name               AS "accountName",
    d.primary_contact_party_id AS "primaryContactPartyId",
    con.name               AS "primaryContactName",
    wi.assignee_id         AS "ownerPartyId",
    own.name               AS "ownerName",
    wi.state,
    wi.priority,
    d.created_at           AS "createdAt",
    d.updated_at           AS "updatedAt"
  FROM deal d
  JOIN work_item wi ON wi.id = d.work_item_id
  LEFT JOIN party acc ON acc.id = d.account_party_id
  LEFT JOIN party con ON con.id = d.primary_contact_party_id
  LEFT JOIN party own ON own.id = wi.assignee_id
`;

// ─── List ─────────────────────────────────────────────────────────────────

opportunitiesRouter.get("/", async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "").trim();
    const stage = String(req.query.stage ?? "").trim();
    const accountId = String(req.query.accountId ?? "").trim();
    // Default hides won/lost — a pipeline board is about what is still live.
    const includeClosed = req.query.includeClosed === "1" || req.query.includeClosed === "true";

    const payload = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        ${OPP_SELECT}
        WHERE ${includeClosed || stage ? sql`true` : sql`d.stage NOT IN ('closed_won','closed_lost')`}
          AND ${stage ? sql`d.stage = ${stage}` : sql`true`}
          AND ${accountId && UUID.test(accountId) ? sql`d.account_party_id = ${accountId}` : sql`true`}
          AND ${q ? sql`(d.name ILIKE ${"%" + q + "%"} OR wi.number ILIKE ${"%" + q + "%"} OR acc.name ILIKE ${"%" + q + "%"})` : sql`true`}
        ORDER BY d.expected_close_date NULLS LAST, d.value DESC NULLS LAST
      `);
      // Per-stage totals for the board header. One query rather than counting
      // client-side, so the numbers are right even when the list is filtered.
      const totals = await db.execute(sql`
        SELECT d.stage, COUNT(*)::int AS count, COALESCE(SUM(d.value), 0) AS value
          FROM deal d GROUP BY d.stage
      `);
      return { opportunities: r.rows, stageTotals: totals.rows };
    });

    res.json(payload);
  } catch (err) { next(err); }
});

opportunitiesRouter.get("/:workItemId", async (req, res, next) => {
  try {
    const id = String(req.params.workItemId);
    if (!UUID.test(id)) return res.status(400).json({ error: "invalid id" });
    const found = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`${OPP_SELECT} WHERE d.work_item_id = ${id}`);
      return r.rows[0] ?? null;
    });
    if (!found) return res.status(404).json({ error: "opportunity not found" });
    res.json({ opportunity: found });
  } catch (err) { next(err); }
});

// ─── Create ───────────────────────────────────────────────────────────────

opportunitiesRouter.post("/", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const name = String(b.name ?? "").trim();
    const accountPartyId = b.accountPartyId ? String(b.accountPartyId).trim() : null;

    if (!name) return res.status(400).json({ error: "name is required" });
    if (!accountPartyId || !UUID.test(accountPartyId)) {
      return res.status(400).json({ error: "accountPartyId is required" });
    }

    let stage: Stage, oppType;
    try {
      stage   = (pickEnum(b.stage, STAGES, "stage") ?? "qualification") as Stage;
      oppType = pickEnum(b.opportunityType, TYPES, "opportunityType");
    } catch (err) { return res.status(400).json({ error: (err as Error).message }); }

    const actualCloseDate = b.actualCloseDate || null;
    if (isClosed(stage) && !actualCloseDate) {
      return res.status(400).json({ error: "a closed opportunity needs an actualCloseDate" });
    }
    if (!isClosed(stage) && actualCloseDate) {
      return res.status(400).json({ error: "actualCloseDate is only valid on a closed opportunity" });
    }

    const created = await withTenant(req.tenantId!, async (db) => {
      const acc = await db.execute(sql`SELECT party_id FROM account WHERE party_id = ${accountPartyId}`);
      if (!acc.rows[0]) throw Object.assign(new Error("no account"), { code: "NO_ACCOUNT" });

      const wi = await db.execute(sql`
        INSERT INTO work_item (tenant_id, number, type, party_id, assignee_id, state, priority)
        VALUES (
          current_tenant(),
          'DEAL-' || nextval('seq_deal'),
          'deal',
          ${accountPartyId},
          ${b.ownerPartyId && UUID.test(String(b.ownerPartyId)) ? String(b.ownerPartyId) : null},
          ${isClosed(stage) ? "closed" : "open"},
          ${b.priority != null ? Number(b.priority) : 3}
        )
        RETURNING id
      `);
      const workItemId = (wi.rows[0] as { id: string }).id;

      await db.execute(sql`
        INSERT INTO deal (
          tenant_id, work_item_id, name, account_party_id, primary_contact_party_id,
          opportunity_type, stage, value, currency, probability, expected_revenue,
          expected_close_date, actual_close_date, next_action, description
        ) VALUES (
          current_tenant(), ${workItemId}, ${name}, ${accountPartyId},
          ${b.primaryContactPartyId && UUID.test(String(b.primaryContactPartyId)) ? String(b.primaryContactPartyId) : null},
          ${oppType}, ${stage},
          ${b.value != null && b.value !== "" ? String(b.value) : null},
          ${b.currency ? String(b.currency).trim() : "INR"},
          ${b.probability != null && b.probability !== "" ? Number(b.probability) : null},
          ${b.expectedRevenue != null && b.expectedRevenue !== "" ? String(b.expectedRevenue) : null},
          ${b.expectedCloseDate || null}, ${actualCloseDate},
          ${b.nextAction  ? String(b.nextAction).trim()  : null},
          ${b.description ? String(b.description).trim() : null}
        )
      `);

      const r = await db.execute(sql`${OPP_SELECT} WHERE d.work_item_id = ${workItemId}`);
      return r.rows[0];
    });

    res.status(201).json({ opportunity: created });
  } catch (err) {
    if ((err as { code?: string }).code === "NO_ACCOUNT") {
      return res.status(400).json({ error: "account not found" });
    }
    next(err);
  }
});

// ─── Update ───────────────────────────────────────────────────────────────

opportunitiesRouter.patch("/:workItemId", async (req, res, next) => {
  try {
    const id = String(req.params.workItemId);
    if (!UUID.test(id)) return res.status(400).json({ error: "invalid id" });
    const b = req.body ?? {};

    let stage: Stage | null = null;
    let oppType;
    try {
      stage   = (pickEnum(b.stage, STAGES, "stage")) as Stage | null;
      oppType = pickEnum(b.opportunityType, TYPES, "opportunityType");
    } catch (err) { return res.status(400).json({ error: (err as Error).message }); }

    const updated = await withTenant(req.tenantId!, async (db) => {
      const cur = await db.execute(sql`
        SELECT d.stage, d.actual_close_date FROM deal d WHERE d.work_item_id = ${id}
      `);
      const row = cur.rows[0] as { stage: string; actual_close_date: string | null } | undefined;
      if (!row) return null;

      const nextStage = stage ?? row.stage;
      // Moving to a closed stage without being told a date is the common case
      // (someone drags the card). Default to today rather than rejecting —
      // but only when the caller did not say otherwise.
      let nextCloseDate = b.actualCloseDate !== undefined ? (b.actualCloseDate || null) : row.actual_close_date;
      if (isClosed(nextStage) && !nextCloseDate) nextCloseDate = new Date().toISOString().slice(0, 10);
      if (!isClosed(nextStage)) nextCloseDate = null;

      const sets: ReturnType<typeof sql>[] = [];
      if (b.name !== undefined) {
        const n = String(b.name).trim();
        if (!n) throw Object.assign(new Error("empty name"), { code: "EMPTY_NAME" });
        sets.push(sql`name = ${n}`);
      }
      if (stage !== null)              sets.push(sql`stage = ${stage}`);
      if (b.opportunityType !== undefined) sets.push(sql`opportunity_type = ${oppType}`);
      if (b.value !== undefined)       sets.push(sql`value = ${b.value != null && b.value !== "" ? String(b.value) : null}`);
      if (b.currency !== undefined)    sets.push(sql`currency = ${b.currency ? String(b.currency).trim() : "INR"}`);
      if (b.probability !== undefined) sets.push(sql`probability = ${b.probability != null && b.probability !== "" ? Number(b.probability) : null}`);
      if (b.expectedRevenue !== undefined) sets.push(sql`expected_revenue = ${b.expectedRevenue != null && b.expectedRevenue !== "" ? String(b.expectedRevenue) : null}`);
      if (b.expectedCloseDate !== undefined) sets.push(sql`expected_close_date = ${b.expectedCloseDate || null}`);
      if (b.nextAction !== undefined)  sets.push(sql`next_action = ${b.nextAction ? String(b.nextAction).trim() : null}`);
      if (b.description !== undefined) sets.push(sql`description = ${b.description ? String(b.description).trim() : null}`);
      if (b.primaryContactPartyId !== undefined) {
        const c = b.primaryContactPartyId ? String(b.primaryContactPartyId).trim() : null;
        if (c && !UUID.test(c)) throw Object.assign(new Error("bad contact"), { code: "BAD_CONTACT" });
        sets.push(sql`primary_contact_party_id = ${c}`);
      }
      // Always written when the stage changes, because the CHECK pairs them.
      if (stage !== null || b.actualCloseDate !== undefined) {
        sets.push(sql`actual_close_date = ${nextCloseDate}`);
      }

      if (sets.length > 0) {
        await db.execute(sql`UPDATE deal SET ${sql.join(sets, sql`, `)} WHERE work_item_id = ${id}`);
      }

      // work_item.state mirrors the sales stage so the generic work-item
      // queries (activity feed, my-work counts) stay honest.
      const wiSets: ReturnType<typeof sql>[] = [];
      if (stage !== null) wiSets.push(sql`state = ${isClosed(stage) ? "closed" : "open"}`);
      if (b.ownerPartyId !== undefined) {
        const o = b.ownerPartyId ? String(b.ownerPartyId).trim() : null;
        if (o && !UUID.test(o)) throw Object.assign(new Error("bad owner"), { code: "BAD_OWNER" });
        wiSets.push(sql`assignee_id = ${o}`);
      }
      if (b.priority !== undefined) wiSets.push(sql`priority = ${Number(b.priority)}`);
      if (wiSets.length > 0) {
        await db.execute(sql`UPDATE work_item SET ${sql.join(wiSets, sql`, `)} WHERE id = ${id}`);
      }

      const detail = await db.execute(sql`${OPP_SELECT} WHERE d.work_item_id = ${id}`);
      return detail.rows[0] ?? null;
    });

    if (!updated) return res.status(404).json({ error: "opportunity not found" });
    res.json({ opportunity: updated });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EMPTY_NAME")  return res.status(400).json({ error: "name cannot be empty" });
    if (code === "BAD_CONTACT") return res.status(400).json({ error: "invalid primaryContactPartyId" });
    if (code === "BAD_OWNER")   return res.status(400).json({ error: "invalid ownerPartyId" });
    next(err);
  }
});
