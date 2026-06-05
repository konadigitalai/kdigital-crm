import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

export const cohortsRouter = Router();

const STATUSES = ["upcoming", "running", "completed", "cancelled"];
const SLOTS = ["morning", "afternoon", "evening"];

cohortsRouter.get("/", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          c.id,
          c.name,
          c.code,
          c.slot,
          c.time_label  AS "timeLabel",
          c.schedule,
          c.start_date  AS "startDate",
          c.end_date    AS "endDate",
          c.seats,
          c.status,
          c.enabled,
          c.course_id   AS "courseId",
          co.name       AS "courseName",
          co.code       AS "courseCode",
          co.enabled    AS "courseEnabled",
          co.program_id AS "programId",
          p.name        AS "programName",
          p.enabled     AS "programEnabled",
          (SELECT COUNT(*)::int FROM batch_assignment ba WHERE ba.cohort_id = c.id)                            AS "enrolmentCount",
          (SELECT COUNT(*)::int FROM batch_assignment ba WHERE ba.cohort_id = c.id AND ba.status = 'active')   AS "activeCount"
        FROM cohort c
        LEFT JOIN course  co ON co.id = c.course_id
        LEFT JOIN program p  ON p.id  = co.program_id
        ORDER BY c.enabled DESC, p.name NULLS LAST, co.name NULLS LAST, c.start_date NULLS LAST, c.name
      `);
      return r.rows;
    });
    res.json({ cohorts: rows });
  } catch (err) {
    next(err);
  }
});

cohortsRouter.post("/", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const courseId = String(b.courseId ?? "").trim();
    const name = String(b.name ?? "").trim();
    if (!courseId || !/^[0-9a-fA-F-]{36}$/.test(courseId)) return res.status(400).json({ error: "courseId required" });
    if (!name) return res.status(400).json({ error: "name is required" });
    const code      = b.code      ? String(b.code).trim()      : null;
    const slot      = b.slot ? String(b.slot).trim() : null;
    if (slot && !SLOTS.includes(slot)) return res.status(400).json({ error: "slot invalid" });
    const timeLabel = b.timeLabel ? String(b.timeLabel).trim() : null;
    const schedule  = b.schedule  ? String(b.schedule).trim()  : null;
    const startDate = b.startDate ? String(b.startDate).trim() : null;
    const endDate   = b.endDate   ? String(b.endDate).trim()   : null;
    const seats     = b.seats != null && b.seats !== "" ? Number(b.seats) : null;
    const status    = String(b.status ?? "upcoming").trim();
    if (!STATUSES.includes(status)) return res.status(400).json({ error: "status invalid" });

    const created = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        INSERT INTO cohort
          (tenant_id, course_id, name, code, slot, time_label, schedule, start_date, end_date, seats, status, enabled)
        VALUES
          (current_tenant(), ${courseId}, ${name}, ${code}, ${slot}, ${timeLabel}, ${schedule},
           ${startDate}, ${endDate}, ${seats}, ${status}, true)
        RETURNING id, name, code, slot, time_label AS "timeLabel", schedule,
                  start_date AS "startDate", end_date AS "endDate",
                  seats, status, enabled, course_id AS "courseId"
      `);
      return r.rows[0];
    });
    res.status(201).json({ cohort: created });
  } catch (err) {
    next(err);
  }
});

cohortsRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "invalid id" });
    const b = req.body ?? {};

    const sets: ReturnType<typeof sql>[] = [];
    if (b.name !== undefined)      sets.push(sql`name = ${String(b.name).trim()}`);
    if (b.code !== undefined)      sets.push(sql`code = ${b.code ? String(b.code).trim() : null}`);
    if (b.slot !== undefined) {
      if (b.slot !== null && b.slot !== "" && !SLOTS.includes(String(b.slot))) {
        return res.status(400).json({ error: "slot invalid" });
      }
      sets.push(sql`slot = ${b.slot === "" ? null : b.slot}`);
    }
    if (b.timeLabel !== undefined) sets.push(sql`time_label = ${b.timeLabel ? String(b.timeLabel).trim() : null}`);
    if (b.schedule !== undefined)  sets.push(sql`schedule = ${b.schedule ? String(b.schedule).trim() : null}`);
    if (b.startDate !== undefined) sets.push(sql`start_date = ${b.startDate ? String(b.startDate).trim() : null}`);
    if (b.endDate !== undefined)   sets.push(sql`end_date   = ${b.endDate   ? String(b.endDate).trim()   : null}`);
    if (b.seats !== undefined)     sets.push(sql`seats = ${b.seats !== "" && b.seats != null ? Number(b.seats) : null}`);
    if (b.status !== undefined) {
      if (!STATUSES.includes(String(b.status))) return res.status(400).json({ error: "status invalid" });
      sets.push(sql`status = ${String(b.status)}`);
    }
    if (b.enabled !== undefined)   sets.push(sql`enabled = ${Boolean(b.enabled)}`);

    if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });

    const updated = await withTenant(req.tenantId!, async (db) => {
      const setClause = sql.join(sets, sql`, `);
      const r = await db.execute(sql`
        UPDATE cohort SET ${setClause}
        WHERE id = ${id}
        RETURNING id, name, code, slot, time_label AS "timeLabel", schedule,
                  start_date AS "startDate", end_date AS "endDate",
                  seats, status, enabled, course_id AS "courseId"
      `);
      return r.rows[0];
    });
    if (!updated) return res.status(404).json({ error: "cohort not found" });
    res.json({ cohort: updated });
  } catch (err) {
    next(err);
  }
});
