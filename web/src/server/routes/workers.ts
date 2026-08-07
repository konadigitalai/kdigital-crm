// Workforce directory — /workers.
//
// A worker is a satellite of `party`, so this router never stores a name, an
// email or a phone number: those live on party + contact_point and are edited
// through /parties. What it owns is the employment record — designation,
// department, reporting line, shift, skills, and the two flags the scheduler
// filters on (trainer_capable, deployment_available).
//
// Creating a worker therefore has two paths:
//   POST { partyId }  — this person is already in the CRM, employ them
//   POST { name, … }  — create the person and employ them in one step
// The first is the one that matters: it stops the directory becoming a
// second, divergent copy of people the CRM already knows.

import { Router } from "@/server/http";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";

export const workersRouter = Router();

const UUID = /^[0-9a-fA-F-]{36}$/;

const WORKER_TYPES      = ["employee", "contractor", "trainer", "intern", "vendor"] as const;
const EMPLOYMENT_TYPES  = ["full_time", "part_time", "contract", "intern"] as const;
const WORKER_STATUSES   = ["active", "on_leave", "notice_period", "exited"] as const;

// One shape for the list and the detail, so the table and the drawer can't
// disagree about what a worker is.
const WORKER_SELECT = sql`
  SELECT
    w.party_id            AS "partyId",
    w.employee_number     AS "employeeNumber",
    p.name,
    p.email,
    p.phone,
    p.city,
    w.worker_type         AS "workerType",
    w.designation,
    w.department,
    w.employment_type     AS "employmentType",
    w.date_of_joining     AS "dateOfJoining",
    w.date_of_exit        AS "dateOfExit",
    w.reporting_to_party_id AS "reportingToPartyId",
    mgr.name              AS "reportingToName",
    w.status,
    w.timezone,
    w.working_hours_per_week AS "workingHoursPerWeek",
    w.shift,
    w.skills,
    w.trainer_capable      AS "trainerCapable",
    w.deployment_available AS "deploymentAvailable",
    w.created_at           AS "createdAt",
    w.updated_at           AS "updatedAt",
    (SELECT COUNT(*)::int FROM worker r WHERE r.reporting_to_party_id = w.party_id) AS "directReportCount",
    -- What this person is actually on the hook for right now. Batches they
    -- train, not batches that exist.
    (SELECT COUNT(*)::int FROM cohort c
      WHERE (c.trainer_id = w.party_id OR c.co_trainer_id = w.party_id)
        AND c.enabled = true AND c.status IN ('upcoming','running'))            AS "activeBatchCount",
    (SELECT COUNT(*)::int FROM lead l WHERE l.advisor_id = w.party_id)          AS "leadCount"
  FROM worker w
  JOIN party p ON p.id = w.party_id
  LEFT JOIN party mgr ON mgr.id = w.reporting_to_party_id
`;

function normaliseSkills(input: unknown): string[] | undefined {
  if (input === undefined) return undefined;
  if (input === null) return [];
  const raw = Array.isArray(input) ? input : String(input).split(",");
  const out: string[] = [];
  for (const item of raw) {
    const s = String(item ?? "").trim();
    // Case-insensitive dedupe: "Python" and "python" are one skill.
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

function pickEnum<T extends readonly string[]>(
  value: unknown, allowed: T, field: string,
): T[number] | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  if (!(allowed as readonly string[]).includes(s)) {
    const err = new Error(`${field} must be one of: ${allowed.join(", ")}`);
    (err as { code?: string }).code = "BAD_ENUM";
    throw err;
  }
  return s as T[number];
}

// ─── List ─────────────────────────────────────────────────────────────────

workersRouter.get("/", async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "").trim();
    // ?trainers=1 is what every trainer picker in the app calls. It is a
    // filter here rather than a separate endpoint so the shape is identical.
    const trainersOnly = req.query.trainers === "1" || req.query.trainers === "true";
    const includeExited = req.query.includeExited === "1" || req.query.includeExited === "true";

    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        ${WORKER_SELECT}
        WHERE ${includeExited ? sql`true` : sql`w.status <> 'exited'`}
          AND ${trainersOnly ? sql`w.trainer_capable = true` : sql`true`}
          AND ${q
            ? sql`(p.name ILIKE ${"%" + q + "%"}
                OR w.employee_number ILIKE ${"%" + q + "%"}
                OR w.designation ILIKE ${"%" + q + "%"}
                OR w.department ILIKE ${"%" + q + "%"}
                OR EXISTS (SELECT 1 FROM unnest(w.skills) s WHERE s ILIKE ${"%" + q + "%"}))`
            : sql`true`}
        ORDER BY (w.status = 'active') DESC, p.name
      `);
      return r.rows;
    });
    res.json({ workers: rows });
  } catch (err) { next(err); }
});

// ─── Detail ───────────────────────────────────────────────────────────────

workersRouter.get("/:partyId", async (req, res, next) => {
  try {
    const partyId = String(req.params.partyId);
    if (!UUID.test(partyId)) return res.status(400).json({ error: "invalid partyId" });

    const found = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`${WORKER_SELECT} WHERE w.party_id = ${partyId}`);
      if (!r.rows[0]) return null;
      const reports = await db.execute(sql`
        SELECT w.party_id AS "partyId", p.name, w.designation, w.status
          FROM worker w JOIN party p ON p.id = w.party_id
         WHERE w.reporting_to_party_id = ${partyId}
         ORDER BY p.name
      `);
      return { ...(r.rows[0] as object), directReports: reports.rows };
    });

    if (!found) return res.status(404).json({ error: "worker not found" });
    res.json({ worker: found });
  } catch (err) { next(err); }
});

// ─── Create ───────────────────────────────────────────────────────────────

workersRouter.post("/", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const partyId = b.partyId ? String(b.partyId).trim() : null;
    const name = b.name ? String(b.name).trim() : null;

    if (!partyId && !name) {
      return res.status(400).json({ error: "either partyId (employ an existing person) or name (create one) is required" });
    }
    if (partyId && !UUID.test(partyId)) return res.status(400).json({ error: "invalid partyId" });

    let workerType, employmentType, status;
    try {
      workerType     = pickEnum(b.workerType,     WORKER_TYPES,     "workerType")     ?? "employee";
      employmentType = pickEnum(b.employmentType, EMPLOYMENT_TYPES, "employmentType");
      status         = pickEnum(b.status,         WORKER_STATUSES,  "status")         ?? "active";
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    const reportingTo = b.reportingToPartyId ? String(b.reportingToPartyId).trim() : null;
    if (reportingTo && !UUID.test(reportingTo)) {
      return res.status(400).json({ error: "invalid reportingToPartyId" });
    }

    const created = await withTenant(req.tenantId!, async (db) => {
      let personId = partyId;

      if (!personId) {
        const ins = await db.execute(sql`
          INSERT INTO party (tenant_id, kind, name, email, phone, city, is_internal)
          VALUES (current_tenant(), 'person', ${name},
                  ${b.email ? String(b.email).trim() : null},
                  ${b.phone ? String(b.phone).trim() : null},
                  ${b.city  ? String(b.city).trim()  : null},
                  true)
          RETURNING id
        `);
        personId = (ins.rows[0] as { id: string }).id;
      } else {
        const p = await db.execute(sql`SELECT id, kind FROM party WHERE id = ${personId}`);
        const row = p.rows[0] as { kind: string } | undefined;
        if (!row) throw Object.assign(new Error("party not found"), { code: "NO_PARTY" });
        if (row.kind !== "person") throw Object.assign(new Error("party is not a person"), { code: "NOT_PERSON" });
        const existing = await db.execute(sql`SELECT party_id FROM worker WHERE party_id = ${personId}`);
        if (existing.rows[0]) throw Object.assign(new Error("already a worker"), { code: "DUP" });
      }

      await db.execute(sql`
        INSERT INTO worker (
          tenant_id, party_id, worker_type, designation, department, employment_type,
          date_of_joining, date_of_exit, reporting_to_party_id, status, timezone,
          working_hours_per_week, shift, skills, trainer_capable, deployment_available
        ) VALUES (
          current_tenant(), ${personId}, ${workerType},
          ${b.designation ? String(b.designation).trim() : null},
          ${b.department  ? String(b.department).trim()  : null},
          ${employmentType},
          ${b.dateOfJoining || null}, ${b.dateOfExit || null},
          ${reportingTo}, ${status},
          ${b.timezone ? String(b.timezone).trim() : "Asia/Kolkata"},
          ${b.workingHoursPerWeek != null && b.workingHoursPerWeek !== "" ? String(b.workingHoursPerWeek) : null},
          ${b.shift ? String(b.shift).trim() : null},
          ${normaliseSkills(b.skills) ?? []},
          ${Boolean(b.trainerCapable)}, ${Boolean(b.deploymentAvailable)}
        )
      `);

      // Employment is a party role, not just a satellite row — so the party
      // timeline shows when they joined the same way it shows a lead
      // converting. Role vocabulary extended in post-0092.
      await db.execute(sql`
        INSERT INTO party_role (tenant_id, party_id, role, valid_from)
        VALUES (current_tenant(), ${personId}, 'worker', COALESCE(${b.dateOfJoining || null}::date, CURRENT_DATE))
        ON CONFLICT DO NOTHING
      `);

      const r = await db.execute(sql`${WORKER_SELECT} WHERE w.party_id = ${personId}`);
      return r.rows[0];
    });

    res.status(201).json({ worker: created });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "NO_PARTY")   return res.status(400).json({ error: "party not found" });
    if (code === "NOT_PERSON") return res.status(400).json({ error: "partyId must reference a person, not an organisation" });
    if (code === "DUP")        return res.status(409).json({ error: "that person is already in the workforce directory" });
    next(err);
  }
});

// ─── Update ───────────────────────────────────────────────────────────────

workersRouter.patch("/:partyId", async (req, res, next) => {
  try {
    const partyId = String(req.params.partyId);
    if (!UUID.test(partyId)) return res.status(400).json({ error: "invalid partyId" });
    const b = req.body ?? {};

    const sets: ReturnType<typeof sql>[] = [];
    try {
      if (b.workerType !== undefined)     sets.push(sql`worker_type = ${pickEnum(b.workerType, WORKER_TYPES, "workerType")}`);
      if (b.employmentType !== undefined) sets.push(sql`employment_type = ${pickEnum(b.employmentType, EMPLOYMENT_TYPES, "employmentType")}`);
      if (b.status !== undefined)         sets.push(sql`status = ${pickEnum(b.status, WORKER_STATUSES, "status")}`);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    if (b.designation !== undefined) sets.push(sql`designation = ${b.designation ? String(b.designation).trim() : null}`);
    if (b.department  !== undefined) sets.push(sql`department  = ${b.department  ? String(b.department).trim()  : null}`);
    if (b.dateOfJoining !== undefined) sets.push(sql`date_of_joining = ${b.dateOfJoining || null}`);
    if (b.dateOfExit    !== undefined) sets.push(sql`date_of_exit    = ${b.dateOfExit    || null}`);
    if (b.timezone !== undefined) sets.push(sql`timezone = ${b.timezone ? String(b.timezone).trim() : "Asia/Kolkata"}`);
    if (b.shift    !== undefined) sets.push(sql`shift    = ${b.shift ? String(b.shift).trim() : null}`);
    if (b.workingHoursPerWeek !== undefined) {
      sets.push(sql`working_hours_per_week = ${b.workingHoursPerWeek != null && b.workingHoursPerWeek !== "" ? String(b.workingHoursPerWeek) : null}`);
    }
    if (b.trainerCapable      !== undefined) sets.push(sql`trainer_capable      = ${Boolean(b.trainerCapable)}`);
    if (b.deploymentAvailable !== undefined) sets.push(sql`deployment_available = ${Boolean(b.deploymentAvailable)}`);

    const skills = normaliseSkills(b.skills);
    if (skills !== undefined) sets.push(sql`skills = ${skills}`);

    if (b.reportingToPartyId !== undefined) {
      const to = b.reportingToPartyId ? String(b.reportingToPartyId).trim() : null;
      if (to && !UUID.test(to)) return res.status(400).json({ error: "invalid reportingToPartyId" });
      if (to === partyId) return res.status(400).json({ error: "a worker cannot report to themselves" });
      sets.push(sql`reporting_to_party_id = ${to}`);
    }

    if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });

    const updated = await withTenant(req.tenantId!, async (db) => {
      // Reporting lines form a tree. Without this check, setting A's manager
      // to B when B already reports to A produces a cycle that the org-chart
      // query then walks forever.
      if (b.reportingToPartyId) {
        const cycle = await db.execute(sql`
          WITH RECURSIVE up AS (
            SELECT party_id, reporting_to_party_id FROM worker WHERE party_id = ${String(b.reportingToPartyId)}
            UNION ALL
            SELECT w.party_id, w.reporting_to_party_id
              FROM worker w JOIN up ON up.reporting_to_party_id = w.party_id
          )
          SELECT 1 FROM up WHERE party_id = ${partyId} LIMIT 1
        `);
        if (cycle.rows[0]) throw Object.assign(new Error("cycle"), { code: "CYCLE" });
      }

      const r = await db.execute(sql`
        UPDATE worker SET ${sql.join(sets, sql`, `)} WHERE party_id = ${partyId} RETURNING party_id
      `);
      if (!r.rows[0]) return null;
      const detail = await db.execute(sql`${WORKER_SELECT} WHERE w.party_id = ${partyId}`);
      return detail.rows[0];
    });

    if (!updated) return res.status(404).json({ error: "worker not found" });
    res.json({ worker: updated });
  } catch (err) {
    if ((err as { code?: string }).code === "CYCLE") {
      return res.status(400).json({ error: "that reporting line would create a cycle" });
    }
    next(err);
  }
});

// No DELETE. Someone leaving is PATCH { status: 'exited', dateOfExit }, so the
// batches they taught and the leads they owned keep resolving to a name.
