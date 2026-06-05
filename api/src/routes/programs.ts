import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

export const programsRouter = Router();

// ─── List programs (with lead counts so admin UI can show usage) ──────────

programsRouter.get("/", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          p.id,
          p.name,
          p.track,
          p.price,
          p.enabled,
          p.attributes,
          (SELECT COUNT(*)::int FROM lead l       WHERE l.program_id = p.id)   AS "leadCount",
          (SELECT COUNT(*)::int FROM course co    WHERE co.program_id = p.id)  AS "courseCount",
          (SELECT COUNT(*)::int FROM cohort c JOIN course co ON co.id = c.course_id WHERE co.program_id = p.id) AS "batchCount",
          (SELECT COUNT(*)::int FROM enrolment e WHERE e.program_id = p.id)    AS "enrolmentCount"
        FROM program p
        ORDER BY p.enabled DESC, p.name
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
    const name = String(req.body?.name ?? "").trim();
    const track = req.body?.track ? String(req.body.track).trim() : null;
    const price = req.body?.price != null && req.body.price !== "" ? String(req.body.price) : null;
    if (!name) return res.status(400).json({ error: "name is required" });

    const created = await withTenant(req.tenantId!, async (db) => {
      const dup = await db.execute(sql`
        SELECT id FROM program WHERE LOWER(name) = LOWER(${name}) LIMIT 1
      `);
      if (dup.rows[0]) {
        const err = new Error("duplicate");
        (err as { code?: string }).code = "DUP";
        throw err;
      }
      const r = await db.execute(sql`
        INSERT INTO program (tenant_id, name, track, price)
        VALUES (current_tenant(), ${name}, ${track}, ${price})
        RETURNING id, name, track, price, enabled
      `);
      return r.rows[0];
    });

    return res.status(201).json({ program: created });
  } catch (err) {
    if ((err as { code?: string }).code === "DUP") {
      return res.status(409).json({ error: "A program with that name already exists" });
    }
    return next(err);
  }
});

// ─── Update program ───────────────────────────────────────────────────────

programsRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "invalid id" });
    const name = req.body?.name != null ? String(req.body.name).trim() : null;
    const track = req.body?.track !== undefined ? (req.body.track ? String(req.body.track).trim() : null) : undefined;
    const enabled = req.body?.enabled !== undefined ? Boolean(req.body.enabled) : undefined;
    const price = req.body?.price !== undefined
      ? (req.body.price === "" || req.body.price === null ? null : String(req.body.price))
      : undefined;

    if (name !== null && !name) return res.status(400).json({ error: "name cannot be empty" });

    const updated = await withTenant(req.tenantId!, async (db) => {
      const sets: ReturnType<typeof sql>[] = [];
      if (name !== null)         sets.push(sql`name = ${name}`);
      if (track !== undefined)   sets.push(sql`track = ${track}`);
      if (enabled !== undefined) sets.push(sql`enabled = ${enabled}`);
      if (price !== undefined)   sets.push(sql`price = ${price}`);
      if (sets.length === 0) {
        const r = await db.execute(sql`SELECT id, name, track, price, enabled FROM program WHERE id = ${id}`);
        return r.rows[0];
      }
      const setClause = sql.join(sets, sql`, `);
      const r = await db.execute(sql`
        UPDATE program SET ${setClause}
        WHERE id = ${id}
        RETURNING id, name, track, price, enabled
      `);
      return r.rows[0];
    });

    if (!updated) return res.status(404).json({ error: "program not found" });

    // Keep lead.program (denormalized text) in sync if name changed.
    if (name) {
      await withTenant(req.tenantId!, async (db) => {
        await db.execute(sql`UPDATE lead SET program = ${name} WHERE program_id = ${id}`);
      });
    }

    return res.json({ program: updated });
  } catch (err) {
    return next(err);
  }
});

// Note: there is intentionally no DELETE handler. Programs are retired via
// PATCH { enabled: false } so historical leads/enrolments stay queryable.
