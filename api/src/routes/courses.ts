import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

export const coursesRouter = Router();

coursesRouter.get("/", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          co.id,
          co.name,
          co.code,
          co.enabled,
          co.program_id   AS "programId",
          p.name          AS "programName",
          p.enabled       AS "programEnabled",
          (SELECT COUNT(*)::int FROM cohort c WHERE c.course_id = co.id)                          AS "batchCount",
          (SELECT COUNT(*)::int FROM cohort c WHERE c.course_id = co.id AND c.status = 'running') AS "runningBatchCount",
          (SELECT COUNT(*)::int FROM batch_assignment ba
            JOIN cohort c ON c.id = ba.cohort_id
            WHERE c.course_id = co.id AND ba.status = 'active')                                    AS "activeLearners"
        FROM course co
        JOIN program p ON p.id = co.program_id
        ORDER BY co.enabled DESC, p.name, co.name
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
    const programId = String(req.body?.programId ?? "").trim();
    const name = String(req.body?.name ?? "").trim();
    const code = req.body?.code ? String(req.body.code).trim() : null;
    if (!programId || !/^[0-9a-fA-F-]{36}$/.test(programId)) return res.status(400).json({ error: "programId required" });
    if (!name) return res.status(400).json({ error: "name is required" });

    const created = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        INSERT INTO course (tenant_id, program_id, name, code, enabled)
        VALUES (current_tenant(), ${programId}, ${name}, ${code}, true)
        RETURNING id, name, code, enabled, program_id AS "programId"
      `);
      return r.rows[0];
    });
    res.status(201).json({ course: created });
  } catch (err) {
    next(err);
  }
});

coursesRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "invalid id" });
    const b = req.body ?? {};

    const sets: ReturnType<typeof sql>[] = [];
    if (b.name !== undefined)    sets.push(sql`name = ${String(b.name).trim()}`);
    if (b.code !== undefined)    sets.push(sql`code = ${b.code ? String(b.code).trim() : null}`);
    if (b.enabled !== undefined) sets.push(sql`enabled = ${Boolean(b.enabled)}`);

    if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });

    const updated = await withTenant(req.tenantId!, async (db) => {
      const setClause = sql.join(sets, sql`, `);
      const r = await db.execute(sql`
        UPDATE course SET ${setClause}
        WHERE id = ${id}
        RETURNING id, name, code, enabled, program_id AS "programId"
      `);
      return r.rows[0];
    });
    if (!updated) return res.status(404).json({ error: "course not found" });
    res.json({ course: updated });
  } catch (err) {
    next(err);
  }
});
