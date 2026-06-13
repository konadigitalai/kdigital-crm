// User Group management. Each group carries a name + permission set + member list.
// All endpoints require groups.manage; mounted in index.ts under /groups.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { isPermission, PERMISSIONS } from "../lib/permissions.js";

export const groupsRouter = Router();

// GET /groups — list groups + permissions + member counts.
groupsRouter.get("/", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          g.id, g.name, g.description, g.is_system, g.created_at,
          COALESCE(
            (SELECT json_agg(p.permission ORDER BY p.permission)
             FROM user_group_permission p WHERE p.group_id = g.id),
            '[]'::json
          ) AS permissions,
          (SELECT COUNT(*)::int FROM user_group_member m WHERE m.group_id = g.id) AS member_count
        FROM user_group g
        ORDER BY g.is_system DESC, g.name
      `);
      return r.rows;
    });
    res.json({ groups: rows, catalog: PERMISSIONS });
  } catch (err) {
    next(err);
  }
});

// POST /groups — create a new group with optional initial permissions.
groupsRouter.post("/", async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const description = req.body?.description ? String(req.body.description).trim() : null;
    const permissions: string[] = Array.isArray(req.body?.permissions) ? req.body.permissions : [];

    if (!name) return res.status(400).json({ error: "Name is required." });
    const bad = permissions.filter((p) => !isPermission(p));
    if (bad.length) return res.status(400).json({ error: `Unknown permissions: ${bad.join(", ")}` });

    const created = await withTenant(req.tenantId!, async (db) => {
      const ins = await db.execute(sql`
        INSERT INTO user_group (tenant_id, name, description, is_system)
        VALUES (${req.tenantId}, ${name}, ${description}, false)
        RETURNING id, name, description, is_system
      `);
      const group = ins.rows[0] as { id: string };
      for (const perm of permissions) {
        await db.execute(sql`
          INSERT INTO user_group_permission (group_id, permission) VALUES (${group.id}, ${perm})
          ON CONFLICT DO NOTHING
        `);
      }
      return ins.rows[0];
    });

    res.status(201).json({ group: created });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("user_group_tenant_name_key")) {
      return res.status(409).json({ error: "A group with that name already exists." });
    }
    next(err);
  }
});

// PATCH /groups/:id — update name/description.
groupsRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const name: string | undefined = req.body?.name;
    const description: string | null | undefined = req.body?.description;

    const updated = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        UPDATE user_group SET
          name = COALESCE(${name ?? null}, name),
          description = COALESCE(${description ?? null}, description)
        WHERE id = ${id}
        RETURNING id, name, description, is_system
      `);
      return r.rows[0] ?? null;
    });
    if (!updated) return res.status(404).json({ error: "Group not found." });
    res.json({ group: updated });
  } catch (err) {
    next(err);
  }
});

// PUT /groups/:id/permissions — replace the group's permission set.
groupsRouter.put("/:id/permissions", async (req, res, next) => {
  try {
    const id = req.params.id;
    const permissions: string[] = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
    const bad = permissions.filter((p) => !isPermission(p));
    if (bad.length) return res.status(400).json({ error: `Unknown permissions: ${bad.join(", ")}` });

    const result = await withTenant(req.tenantId!, async (db) => {
      const g = await db.execute(sql`SELECT id, name, is_system FROM user_group WHERE id = ${id}`);
      const group = g.rows[0] as { id: string; name: string; is_system: boolean } | undefined;
      if (!group) return { ok: false as const, status: 404, error: "Group not found." };
      // Only the Administrators group must keep users.manage so the tenant
      // cannot lock itself out of admin. Other system groups are free to
      // change shape.
      if (group.name === "Administrators" && !permissions.includes("users.manage")) {
        return {
          ok: false as const,
          status: 400,
          error: "Administrators group must keep users.manage.",
        };
      }
      await db.execute(sql`DELETE FROM user_group_permission WHERE group_id = ${id}`);
      for (const perm of permissions) {
        await db.execute(sql`
          INSERT INTO user_group_permission (group_id, permission) VALUES (${id}, ${perm})
        `);
      }
      return { ok: true as const, permissions };
    });

    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true, permissions: result.permissions });
  } catch (err) {
    next(err);
  }
});

// DELETE /groups/:id — refuses for system groups.
groupsRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const result = await withTenant(req.tenantId!, async (db) => {
      const g = await db.execute(sql`SELECT id, is_system FROM user_group WHERE id = ${id}`);
      const group = g.rows[0] as { id: string; is_system: boolean } | undefined;
      if (!group) return { ok: false as const, status: 404, error: "Group not found." };
      if (group.is_system) return { ok: false as const, status: 409, error: "System groups cannot be deleted." };
      await db.execute(sql`DELETE FROM user_group WHERE id = ${id}`);
      return { ok: true as const };
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
