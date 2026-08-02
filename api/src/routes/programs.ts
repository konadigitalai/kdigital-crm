import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

export const programsRouter = Router();

const DURATION_UNITS = ["weeks", "months"] as const;
type DurationUnit = typeof DURATION_UNITS[number];

function normaliseCourseIds(input: unknown): string[] | null {
  if (input === undefined) return null;
  if (input === null) return [];
  if (!Array.isArray(input)) throw new Error("courseIds must be an array");
  const clean: string[] = [];
  for (const raw of input) {
    const id = String(raw ?? "").trim();
    if (!id) continue;
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error(`courseIds: '${id}' invalid`);
    if (!clean.includes(id)) clean.push(id);
  }
  return clean;
}

// SQL fragment that shapes a full program row with stack + courses aggregate.
//
// Every program_course subquery below filters component_type = 'course'. Since
// post-0087 that table also holds programme→programme references: a composite
// pathway such as Forward Deployed AI Engineer lists seven other programmes
// among its twelve components. Counting those as courses would have the CRM
// report 12 courses next to a list of 5.
const PROGRAM_SELECT = sql`
  SELECT
    p.id,
    p.name,
    p.description,
    p.price,
    p.duration_value AS "durationValue",
    p.duration_unit  AS "durationUnit",
    p.enabled,
    p.stack_id       AS "stackId",
    s.name           AS "stackName",
    p.registry_id      AS "registryId",
    p.short_code       AS "shortCode",
    p.full_name        AS "fullName",
    p.programme_type   AS "programmeType",
    p.family,
    p.credential_type  AS "credentialType",
    p.delivery_modes   AS "deliveryModes",
    p.catalogue_version AS "catalogueVersion",
    p.catalogue_status  AS "catalogueStatus",
    (SELECT COUNT(*)::int FROM lead l               WHERE l.program_id = p.id)                                        AS "leadCount",
    (SELECT COUNT(*)::int FROM program_course pc    WHERE pc.program_id = p.id AND pc.component_type = 'course')       AS "courseCount",
    (SELECT COUNT(*)::int FROM program_course pc    WHERE pc.program_id = p.id AND pc.component_type = 'programme')    AS "referencedProgrammeCount",
    (SELECT COUNT(*)::int FROM cohort c
       JOIN program_course pc ON pc.course_id = c.course_id
       WHERE pc.program_id = p.id AND pc.component_type = 'course')                                                    AS "batchCount",
    (SELECT COUNT(*)::int FROM enrolment e          WHERE e.program_id = p.id)                                        AS "enrolmentCount",
    COALESCE(
      (SELECT json_agg(json_build_object(
                 'id', co.id, 'name', co.name, 'rank', pc.rank,
                 'registryId', co.registry_id,
                 'role', pc.component_role,
                 'specialisationGroup', pc.specialisation_group,
                 'required', pc.required
               ) ORDER BY pc.rank, co.name)
         FROM program_course pc
         JOIN course co ON co.id = pc.course_id
         WHERE pc.program_id = p.id AND pc.component_type = 'course'),
      '[]'::json
    ) AS courses,
    COALESCE(
      (SELECT json_agg(json_build_object(
                 'id', cp.id, 'name', cp.name, 'rank', pc.rank,
                 'registryId', cp.registry_id,
                 'role', pc.component_role
               ) ORDER BY pc.rank, cp.name)
         FROM program_course pc
         JOIN program cp ON cp.id = pc.child_program_id
         WHERE pc.program_id = p.id AND pc.component_type = 'programme'),
      '[]'::json
    ) AS "referencedProgrammes"
  FROM program p
  LEFT JOIN stack s ON s.id = p.stack_id
`;

// ─── List programs ────────────────────────────────────────────────────────

programsRouter.get("/", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        ${PROGRAM_SELECT}
        ORDER BY p.enabled DESC, s.name NULLS LAST, p.name
      `);
      return r.rows;
    });
    res.json({ programs: rows });
  } catch (err) {
    next(err);
  }
});

// ─── Create program ───────────────────────────────────────────────────────

programsRouter.post("/", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const name = String(b.name ?? "").trim();
    const stackId = String(b.stackId ?? "").trim();
    const description = b.description ? String(b.description).trim() : null;
    const price = b.price != null && b.price !== "" ? String(b.price) : null;

    const durationValueRaw = b.durationValue;
    const durationValue = durationValueRaw != null && durationValueRaw !== ""
      ? Number(durationValueRaw)
      : null;
    if (durationValue !== null && (!Number.isInteger(durationValue) || durationValue <= 0)) {
      return res.status(400).json({ error: "durationValue must be a positive integer" });
    }
    const durationUnit: DurationUnit | null = b.durationUnit
      ? String(b.durationUnit).trim() as DurationUnit
      : null;
    if (durationUnit && !DURATION_UNITS.includes(durationUnit)) {
      return res.status(400).json({ error: "durationUnit must be 'weeks' or 'months'" });
    }
    if ((durationValue === null) !== (durationUnit === null)) {
      return res.status(400).json({ error: "durationValue and durationUnit must be set together" });
    }

    let courseIds: string[] | null;
    try {
      courseIds = normaliseCourseIds(b.courseIds) ?? [];
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    if (!name)    return res.status(400).json({ error: "name is required" });
    if (!stackId || !/^[0-9a-fA-F-]{36}$/.test(stackId)) {
      return res.status(400).json({ error: "stackId is required" });
    }

    const created = await withTenant(req.tenantId!, async (db) => {
      const dup = await db.execute(sql`
        SELECT id FROM program WHERE LOWER(name) = LOWER(${name}) LIMIT 1
      `);
      if (dup.rows[0]) {
        const err = new Error("duplicate");
        (err as { code?: string }).code = "DUP";
        throw err;
      }
      const stack = await db.execute(sql`SELECT id FROM stack WHERE id = ${stackId} LIMIT 1`);
      if (!stack.rows[0]) {
        const err = new Error("stack not found");
        (err as { code?: string }).code = "NO_STACK";
        throw err;
      }
      const ins = await db.execute(sql`
        INSERT INTO program (tenant_id, stack_id, name, description, price, duration_value, duration_unit)
        VALUES (current_tenant(), ${stackId}, ${name}, ${description}, ${price}, ${durationValue}, ${durationUnit})
        RETURNING id
      `);
      const id = (ins.rows[0] as { id: string }).id;

      if (courseIds && courseIds.length > 0) {
        // Verify all course ids exist under the same tenant (RLS narrows the
        // SELECT so we just count).
        const courseRows = await db.execute(sql`
          SELECT id FROM course WHERE id IN (${sql.join(courseIds.map((c) => sql`${c}`), sql`, `)})
        `);
        if (courseRows.rows.length !== courseIds.length) {
          const err = new Error("one or more courseIds not found");
          (err as { code?: string }).code = "NO_COURSE";
          throw err;
        }
        // Bulk insert junction rows with an incrementing rank.
        const values = courseIds.map((cid, idx) => sql`(current_tenant(), ${id}, 'course', ${cid}, ${idx})`);
        await db.execute(sql`
          INSERT INTO program_course (tenant_id, program_id, component_type, course_id, rank)
          VALUES ${sql.join(values, sql`, `)}
        `);
      }

      const r = await db.execute(sql`${PROGRAM_SELECT} WHERE p.id = ${id}`);
      return r.rows[0];
    });

    return res.status(201).json({ program: created });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "DUP")       return res.status(409).json({ error: "A program with that name already exists" });
    if (code === "NO_STACK")  return res.status(400).json({ error: "stack not found" });
    if (code === "NO_COURSE") return res.status(400).json({ error: "one or more courseIds not found" });
    return next(err);
  }
});

// ─── Update program ───────────────────────────────────────────────────────

programsRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "invalid id" });
    const b = req.body ?? {};

    const name = b.name != null ? String(b.name).trim() : null;
    const stackId = b.stackId !== undefined
      ? (b.stackId ? String(b.stackId).trim() : null)
      : undefined;
    if (stackId !== undefined && stackId !== null && !/^[0-9a-fA-F-]{36}$/.test(stackId)) {
      return res.status(400).json({ error: "invalid stackId" });
    }
    if (stackId === null) return res.status(400).json({ error: "stackId cannot be null" });
    const description = b.description !== undefined
      ? (b.description ? String(b.description).trim() : null)
      : undefined;
    const enabled = b.enabled !== undefined ? Boolean(b.enabled) : undefined;
    const price = b.price !== undefined
      ? (b.price === "" || b.price === null ? null : String(b.price))
      : undefined;

    let durationValueProvided = b.durationValue !== undefined;
    let durationUnitProvided  = b.durationUnit  !== undefined;
    let durationValue: number | null = null;
    let durationUnit: DurationUnit | null = null;
    if (durationValueProvided) {
      durationValue = b.durationValue != null && b.durationValue !== ""
        ? Number(b.durationValue) : null;
      if (durationValue !== null && (!Number.isInteger(durationValue) || durationValue <= 0)) {
        return res.status(400).json({ error: "durationValue must be a positive integer" });
      }
    }
    if (durationUnitProvided) {
      durationUnit = b.durationUnit
        ? String(b.durationUnit).trim() as DurationUnit
        : null;
      if (durationUnit && !DURATION_UNITS.includes(durationUnit)) {
        return res.status(400).json({ error: "durationUnit must be 'weeks' or 'months'" });
      }
    }
    // Enforce pair-consistency if both are provided in the patch.
    if (durationValueProvided && durationUnitProvided
        && (durationValue === null) !== (durationUnit === null)) {
      return res.status(400).json({ error: "durationValue and durationUnit must be set together" });
    }

    let courseIds: string[] | null;
    try {
      courseIds = normaliseCourseIds(b.courseIds);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    if (name !== null && !name) return res.status(400).json({ error: "name cannot be empty" });

    const updated = await withTenant(req.tenantId!, async (db) => {
      if (stackId !== undefined && stackId !== null) {
        const stack = await db.execute(sql`SELECT id FROM stack WHERE id = ${stackId} LIMIT 1`);
        if (!stack.rows[0]) {
          const err = new Error("stack not found");
          (err as { code?: string }).code = "NO_STACK";
          throw err;
        }
      }

      const sets: ReturnType<typeof sql>[] = [];
      if (name !== null)                sets.push(sql`name = ${name}`);
      if (stackId !== undefined)        sets.push(sql`stack_id = ${stackId}`);
      if (description !== undefined)    sets.push(sql`description = ${description}`);
      if (enabled !== undefined)        sets.push(sql`enabled = ${enabled}`);
      if (price !== undefined)          sets.push(sql`price = ${price}`);
      if (durationValueProvided)        sets.push(sql`duration_value = ${durationValue}`);
      if (durationUnitProvided)         sets.push(sql`duration_unit = ${durationUnit}`);

      if (sets.length > 0) {
        const setClause = sql.join(sets, sql`, `);
        const r = await db.execute(sql`
          UPDATE program SET ${setClause}
          WHERE id = ${id}
          RETURNING id
        `);
        if (!r.rows[0]) return null;
      } else {
        const r = await db.execute(sql`SELECT id FROM program WHERE id = ${id}`);
        if (!r.rows[0]) return null;
      }

      // Sync junction if courseIds provided (empty array = clear all).
      if (courseIds !== null) {
        // Validate any incoming ids.
        if (courseIds.length > 0) {
          const courseRows = await db.execute(sql`
            SELECT id FROM course WHERE id IN (${sql.join(courseIds.map((c) => sql`${c}`), sql`, `)})
          `);
          if (courseRows.rows.length !== courseIds.length) {
            const err = new Error("one or more courseIds not found");
            (err as { code?: string }).code = "NO_COURSE";
            throw err;
          }
        }

        // Courses only. A programme reference has a NULL course_id and is not
        // this endpoint's to add or remove — it comes from the registry.
        const existing = await db.execute(sql`
          SELECT course_id FROM program_course
          WHERE program_id = ${id} AND component_type = 'course'
        `);
        const existingSet = new Set(existing.rows.map((r) => (r as { course_id: string }).course_id));
        const nextSet = new Set(courseIds);
        const toDelete = [...existingSet].filter((c) => !nextSet.has(c));
        const toInsert = courseIds.filter((c) => !existingSet.has(c));

        if (toDelete.length > 0) {
          await db.execute(sql`
            DELETE FROM program_course
            WHERE program_id = ${id}
              AND component_type = 'course'
              AND course_id IN (${sql.join(toDelete.map((c) => sql`${c}`), sql`, `)})
          `);
        }
        if (toInsert.length > 0) {
          // Continue rank from the current max so ordering stays stable.
          const maxRankRow = await db.execute(sql`
            SELECT COALESCE(MAX(rank), -1) AS max FROM program_course WHERE program_id = ${id}
          `);
          const start = Number((maxRankRow.rows[0] as { max: number }).max) + 1;
          const values = toInsert.map((cid, i) =>
            sql`(current_tenant(), ${id}, 'course', ${cid}, ${start + i})`);
          await db.execute(sql`
            INSERT INTO program_course (tenant_id, program_id, component_type, course_id, rank)
            VALUES ${sql.join(values, sql`, `)}
          `);
        }
      }

      const detail = await db.execute(sql`${PROGRAM_SELECT} WHERE p.id = ${id}`);
      return detail.rows[0];
    });

    if (!updated) return res.status(404).json({ error: "program not found" });

    // Keep lead.program (denormalized text) in sync if the name changed.
    if (name) {
      await withTenant(req.tenantId!, async (db) => {
        await db.execute(sql`UPDATE lead SET program = ${name} WHERE program_id = ${id}`);
      });
    }

    return res.json({ program: updated });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "NO_STACK")  return res.status(400).json({ error: "stack not found" });
    if (code === "NO_COURSE") return res.status(400).json({ error: "one or more courseIds not found" });
    return next(err);
  }
});

// No DELETE — retire via PATCH { enabled: false } so historical leads +
// enrolments stay queryable.
