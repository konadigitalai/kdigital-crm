import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

export const stacksRouter = Router();

// ─── List stacks (with program counts for admin table) ───────────────────

stacksRouter.get("/", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          s.id,
          s.name,
          s.description,
          s.enabled,
          (SELECT COUNT(*)::int FROM program p WHERE p.stack_id = s.id) AS "programCount"
        FROM stack s
        ORDER BY s.enabled DESC, s.name
      `);
      return r.rows;
    });
    res.json({ stacks: rows });
  } catch (err) {
    next(err);
  }
});

// ─── Create stack ────────────────────────────────────────────────────────

stacksRouter.post("/", async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const description = req.body?.description ? String(req.body.description).trim() : null;
    if (!name) return res.status(400).json({ error: "name is required" });

    const created = await withTenant(req.tenantId!, async (db) => {
      const dup = await db.execute(sql`
        SELECT id FROM stack WHERE LOWER(name) = LOWER(${name}) LIMIT 1
      `);
      if (dup.rows[0]) {
        const err = new Error("duplicate");
        (err as { code?: string }).code = "DUP";
        throw err;
      }
      const r = await db.execute(sql`
        INSERT INTO stack (tenant_id, name, description)
        VALUES (current_tenant(), ${name}, ${description})
        RETURNING id, name, description, enabled
      `);
      return { ...(r.rows[0] as object), programCount: 0 };
    });

    return res.status(201).json({ stack: created });
  } catch (err) {
    if ((err as { code?: string }).code === "DUP") {
      return res.status(409).json({ error: "A stack with that name already exists" });
    }
    return next(err);
  }
});

// ─── Update stack ────────────────────────────────────────────────────────

stacksRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "invalid id" });
    const b = req.body ?? {};
    const name = b.name != null ? String(b.name).trim() : null;
    const description = b.description !== undefined
      ? (b.description ? String(b.description).trim() : null)
      : undefined;
    const enabled = b.enabled !== undefined ? Boolean(b.enabled) : undefined;

    if (name !== null && !name) return res.status(400).json({ error: "name cannot be empty" });

    const updated = await withTenant(req.tenantId!, async (db) => {
      if (name) {
        const dup = await db.execute(sql`
          SELECT id FROM stack WHERE LOWER(name) = LOWER(${name}) AND id <> ${id} LIMIT 1
        `);
        if (dup.rows[0]) {
          const err = new Error("duplicate");
          (err as { code?: string }).code = "DUP";
          throw err;
        }
      }

      const sets: ReturnType<typeof sql>[] = [];
      if (name !== null)              sets.push(sql`name = ${name}`);
      if (description !== undefined)  sets.push(sql`description = ${description}`);
      if (enabled !== undefined)      sets.push(sql`enabled = ${enabled}`);
      if (sets.length === 0) {
        const r = await db.execute(sql`
          SELECT s.id, s.name, s.description, s.enabled,
            (SELECT COUNT(*)::int FROM program p WHERE p.stack_id = s.id) AS "programCount"
          FROM stack s WHERE s.id = ${id}
        `);
        return r.rows[0];
      }
      const setClause = sql.join(sets, sql`, `);
      const r = await db.execute(sql`
        UPDATE stack SET ${setClause}
        WHERE id = ${id}
        RETURNING id, name, description, enabled,
          (SELECT COUNT(*)::int FROM program p WHERE p.stack_id = stack.id) AS "programCount"
      `);
      return r.rows[0];
    });

    if (!updated) return res.status(404).json({ error: "stack not found" });
    return res.json({ stack: updated });
  } catch (err) {
    if ((err as { code?: string }).code === "DUP") {
      return res.status(409).json({ error: "A stack with that name already exists" });
    }
    return next(err);
  }
});

// No DELETE — retire via PATCH { enabled: false } so historical programs
// keep their stack membership queryable.
