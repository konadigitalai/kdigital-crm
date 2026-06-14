// User management — list/create/update/activate/deactivate/reset-password.
// All endpoints require users.manage; mounted in index.ts under /users.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { hashPassword } from "../lib/passwords.js";
import { revokeAllForUser } from "../lib/sessions.js";

export const usersRouter = Router();

const ROLES = new Set(["admin", "advisor", "service_rep", "readonly"]);

// GET /users — list every user in the tenant + their group memberships.
usersRouter.get("/", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          u.id, u.email, u.name, u.role, u.active, u.created_at,
          (u.password_hash IS NOT NULL) AS has_password,
          COALESCE(
            (
              SELECT json_agg(json_build_object('id', g.id, 'name', g.name) ORDER BY g.name)
              FROM user_group_member m
              JOIN user_group g ON g.id = m.group_id
              WHERE m.user_id = u.id
            ),
            '[]'::json
          ) AS groups
        FROM app_user u
        ORDER BY u.created_at
      `);
      return r.rows;
    });
    res.json({ users: rows });
  } catch (err) {
    next(err);
  }
});

// POST /users — create a new user. Body: { email, name, role, password, groupIds[] }
usersRouter.post("/", async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const name = req.body?.name ? String(req.body.name).trim() : null;
    const role = String(req.body?.role ?? "advisor");
    const password = req.body?.password ? String(req.body.password) : null;
    const groupIds: string[] = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email is required." });
    }
    if (!ROLES.has(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of ${Array.from(ROLES).join(", ")}.` });
    }
    const passwordHash = password ? await hashPassword(password) : null;

    const created = await withTenant(req.tenantId!, async (db) => {
      const ins = await db.execute(sql`
        INSERT INTO app_user (tenant_id, email, name, role, password_hash, active)
        VALUES (${req.tenantId}, ${email}, ${name}, ${role}, ${passwordHash}, true)
        RETURNING id, email, name, role, active
      `);
      const user = ins.rows[0] as { id: string };
      for (const gid of groupIds) {
        await db.execute(sql`
          INSERT INTO user_group_member (user_id, group_id) VALUES (${user.id}, ${gid})
          ON CONFLICT DO NOTHING
        `);
      }
      return ins.rows[0];
    });

    res.status(201).json({ user: created });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("app_user_tenant_email_key")) {
      return res.status(409).json({ error: "A user with that email already exists." });
    }
    next(err);
  }
});

// PATCH /users/:id — update fields (name, role, active) and replace group set.
usersRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const patch = req.body ?? {};
    const newName: string | undefined = patch.name;
    const newRole: string | undefined = patch.role;
    const newActive: boolean | undefined = patch.active;
    const newGroupIds: string[] | undefined = Array.isArray(patch.groupIds) ? patch.groupIds : undefined;

    if (newRole !== undefined && !ROLES.has(newRole)) {
      return res.status(400).json({ error: "Invalid role." });
    }
    if (id === req.userId && newActive === false) {
      return res.status(400).json({ error: "You cannot deactivate yourself." });
    }

    const updated = await withTenant(req.tenantId!, async (db) => {
      // Build a single UPDATE with only the columns provided.
      if (newName !== undefined || newRole !== undefined || newActive !== undefined) {
        await db.execute(sql`
          UPDATE app_user SET
            name = COALESCE(${newName ?? null}, name),
            role = COALESCE(${newRole ?? null}, role),
            active = COALESCE(${newActive ?? null}, active)
          WHERE id = ${id}
        `);
      }
      if (newGroupIds !== undefined) {
        await db.execute(sql`DELETE FROM user_group_member WHERE user_id = ${id}`);
        for (const gid of newGroupIds) {
          await db.execute(sql`
            INSERT INTO user_group_member (user_id, group_id) VALUES (${id}, ${gid})
            ON CONFLICT DO NOTHING
          `);
        }
      }
      const r = await db.execute(sql`
        SELECT id, email, name, role, active FROM app_user WHERE id = ${id}
      `);
      return r.rows[0] ?? null;
    });

    if (!updated) return res.status(404).json({ error: "User not found." });
    if (newActive === false) await revokeAllForUser(id);
    res.json({ user: updated });
  } catch (err) {
    next(err);
  }
});

// POST /users/:id/reset-password — admin-set new password.
usersRouter.post("/:id/reset-password", async (req, res, next) => {
  try {
    const id = req.params.id;
    const password = String(req.body?.password ?? "");
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }
    const hash = await hashPassword(password);
    const ok = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        UPDATE app_user SET password_hash = ${hash} WHERE id = ${id}
        RETURNING id
      `);
      return r.rows.length > 0;
    });
    if (!ok) return res.status(404).json({ error: "User not found." });
    await revokeAllForUser(id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /users/:id/activate, /:id/deactivate — convenience flips.
usersRouter.post("/:id/activate", async (req, res, next) => {
  try {
    const id = req.params.id;
    const ok = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`UPDATE app_user SET active = true WHERE id = ${id} RETURNING id`);
      return r.rows.length > 0;
    });
    if (!ok) return res.status(404).json({ error: "User not found." });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

usersRouter.post("/:id/deactivate", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (id === req.userId) {
      return res.status(400).json({ error: "You cannot deactivate yourself." });
    }
    const ok = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`UPDATE app_user SET active = false WHERE id = ${id} RETURNING id`);
      return r.rows.length > 0;
    });
    if (!ok) return res.status(404).json({ error: "User not found." });
    await revokeAllForUser(id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
