// Client CRUD + employee assignments. Admins (clients.manage) manage the full
// list; everyone else uses GET /clients which returns only their assigned
// clients (driven by client_assignment).

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { requirePermission } from "../middleware/require.js";

export const clientsRouter = Router();

// GET /clients — admins see everything, others see only what they're assigned to.
clientsRouter.get("/", async (req, res, next) => {
  try {
    const isAdmin = req.permissions?.has("clients.manage") ?? false;
    const userId = req.userId!;
    const rows = await withTenant(req.tenantId!, async (db) => {
      if (isAdmin) {
        const r = await db.execute(sql`
          SELECT
            c.id, c.name, c.code, c.description, c.active, c.created_at AS "createdAt",
            (SELECT COUNT(*)::int FROM client_assignment ca WHERE ca.client_id = c.id) AS "memberCount"
          FROM client c
          ORDER BY c.active DESC, lower(c.name)
        `);
        return r.rows;
      }
      const r = await db.execute(sql`
        SELECT
          c.id, c.name, c.code, c.description, c.active, c.created_at AS "createdAt",
          0 AS "memberCount"
        FROM client c
        JOIN client_assignment ca ON ca.client_id = c.id
        WHERE ca.user_id = ${userId} AND c.active = true
        ORDER BY lower(c.name)
      `);
      return r.rows;
    });
    res.json({ clients: rows });
  } catch (err) {
    next(err);
  }
});

// POST /clients — admin only.
clientsRouter.post("/", requirePermission("clients.manage"), async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const code = req.body?.code ? String(req.body.code).trim() : null;
    const description = req.body?.description ? String(req.body.description).trim() : null;
    if (!name) return res.status(400).json({ error: "Name is required" });

    const created = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        INSERT INTO client (tenant_id, name, code, description)
        VALUES (${req.tenantId}, ${name}, ${code}, ${description})
        RETURNING id, name, code, description, active, created_at AS "createdAt"
      `);
      return r.rows[0];
    });
    res.status(201).json({ client: created });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("client_tenant_name_key")) {
      return res.status(409).json({ error: "A client with that name already exists." });
    }
    next(err);
  }
});

// PATCH /clients/:id — admin only.
clientsRouter.patch("/:id", requirePermission("clients.manage"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const b = req.body ?? {};
    const updated = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        UPDATE client SET
          name = COALESCE(${b.name ?? null}, name),
          code = COALESCE(${b.code ?? null}, code),
          description = COALESCE(${b.description ?? null}, description)
        WHERE id = ${id}
        RETURNING id, name, code, description, active, created_at AS "createdAt"
      `);
      return r.rows[0] ?? null;
    });
    if (!updated) return res.status(404).json({ error: "Client not found" });
    res.json({ client: updated });
  } catch (err) {
    next(err);
  }
});

clientsRouter.post("/:id/activate", requirePermission("clients.manage"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const ok = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`UPDATE client SET active = true WHERE id = ${id} RETURNING id`);
      return r.rows.length > 0;
    });
    if (!ok) return res.status(404).json({ error: "Client not found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

clientsRouter.post("/:id/deactivate", requirePermission("clients.manage"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const ok = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`UPDATE client SET active = false WHERE id = ${id} RETURNING id`);
      return r.rows.length > 0;
    });
    if (!ok) return res.status(404).json({ error: "Client not found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /clients/:id/assignments — admin: list of users assigned to this client.
clientsRouter.get("/:id/assignments", requirePermission("clients.manage"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT u.id, u.name, u.email, u.role, u.active
        FROM client_assignment ca
        JOIN app_user u ON u.id = ca.user_id
        WHERE ca.client_id = ${id}
        ORDER BY u.name
      `);
      return r.rows;
    });
    res.json({ users: rows });
  } catch (err) {
    next(err);
  }
});

// POST /clients/:id/assignments — replace full set.
clientsRouter.post("/:id/assignments", requirePermission("clients.manage"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const userIds: string[] = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
    await withTenant(req.tenantId!, async (db) => {
      await db.execute(sql`DELETE FROM client_assignment WHERE client_id = ${id}`);
      for (const uid of userIds) {
        await db.execute(sql`
          INSERT INTO client_assignment (tenant_id, client_id, user_id)
          VALUES (${req.tenantId}, ${id}, ${uid})
          ON CONFLICT DO NOTHING
        `);
      }
    });
    res.json({ ok: true, count: userIds.length });
  } catch (err) {
    next(err);
  }
});
