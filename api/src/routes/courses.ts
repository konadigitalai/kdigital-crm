import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

export const coursesRouter = Router();

// A course is a reusable module (name + description). Programs are attached
// via the program_course junction — nothing about the course table itself
// knows about programs.

coursesRouter.get("/", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          co.id,
          co.name,
          co.description,
          co.enabled,
          (SELECT COUNT(*)::int FROM program_course pc WHERE pc.course_id = co.id)                                       AS "programCount",
          (SELECT COUNT(*)::int FROM cohort c          WHERE c.course_id = co.id)                                         AS "batchCount",
          (SELECT COUNT(*)::int FROM cohort c          WHERE c.course_id = co.id AND c.status = 'running')                AS "runningBatchCount",
          (SELECT COUNT(*)::int FROM batch_assignment ba
             JOIN cohort c ON c.id = ba.cohort_id
             WHERE c.course_id = co.id AND ba.status = 'active')                                                          AS "activeLearners"
        FROM course co
        ORDER BY co.enabled DESC, co.name
      `);
      return r.rows;
    });
    res.json({ courses: rows });
  } catch (err) {
    next(err);
  }
});

coursesRouter.post("/", async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const description = req.body?.description ? String(req.body.description).trim() : null;
    if (!name) return res.status(400).json({ error: "name is required" });

    const created = await withTenant(req.tenantId!, async (db) => {
      const dup = await db.execute(sql`
        SELECT id FROM course WHERE LOWER(name) = LOWER(${name}) LIMIT 1
      `);
      if (dup.rows[0]) {
        const err = new Error("duplicate");
        (err as { code?: string }).code = "DUP";
        throw err;
      }
      const r = await db.execute(sql`
        INSERT INTO course (tenant_id, name, description, enabled)
        VALUES (current_tenant(), ${name}, ${description}, true)
        RETURNING id, name, description, enabled
      `);
      return {
        ...(r.rows[0] as object),
        programCount: 0,
        batchCount: 0,
        runningBatchCount: 0,
        activeLearners: 0,
      };
    });
    res.status(201).json({ course: created });
  } catch (err) {
    if ((err as { code?: string }).code === "DUP") {
      return res.status(409).json({ error: "A course with that name already exists" });
    }
    next(err);
  }
});

coursesRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "invalid id" });
    const b = req.body ?? {};

    const sets: ReturnType<typeof sql>[] = [];
    if (b.name !== undefined)        sets.push(sql`name = ${String(b.name).trim()}`);
    if (b.description !== undefined) sets.push(sql`description = ${b.description ? String(b.description).trim() : null}`);
    if (b.enabled !== undefined)     sets.push(sql`enabled = ${Boolean(b.enabled)}`);

    if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });

    const updated = await withTenant(req.tenantId!, async (db) => {
      if (b.name !== undefined) {
        const nextName = String(b.name).trim();
        if (!nextName) throw new Error("name cannot be empty");
        const dup = await db.execute(sql`
          SELECT id FROM course WHERE LOWER(name) = LOWER(${nextName}) AND id <> ${id} LIMIT 1
        `);
        if (dup.rows[0]) {
          const err = new Error("duplicate");
          (err as { code?: string }).code = "DUP";
          throw err;
        }
      }
      const setClause = sql.join(sets, sql`, `);
      const r = await db.execute(sql`
        UPDATE course SET ${setClause}
        WHERE id = ${id}
        RETURNING id, name, description, enabled,
          (SELECT COUNT(*)::int FROM program_course pc WHERE pc.course_id = course.id)                                    AS "programCount",
          (SELECT COUNT(*)::int FROM cohort c          WHERE c.course_id = course.id)                                     AS "batchCount",
          (SELECT COUNT(*)::int FROM cohort c          WHERE c.course_id = course.id AND c.status = 'running')            AS "runningBatchCount",
          (SELECT COUNT(*)::int FROM batch_assignment ba
             JOIN cohort c ON c.id = ba.cohort_id
             WHERE c.course_id = course.id AND ba.status = 'active')                                                      AS "activeLearners"
      `);
      return r.rows[0];
    });
    if (!updated) return res.status(404).json({ error: "course not found" });
    res.json({ course: updated });
  } catch (err) {
    if ((err as { code?: string }).code === "DUP") {
      return res.status(409).json({ error: "A course with that name already exists" });
    }
    next(err);
  }
});
