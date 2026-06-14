import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { requirePermission } from "../middleware/require.js";

export const meRouter = Router();

// /me — returns the authenticated user and their permission set.
meRouter.get("/", async (req, res) => {
  if (!req.user) {
    res.json({ me: null });
    return;
  }
  const u = req.user;
  const initials = (u.name ?? u.email)
    .trim()
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  res.json({
    me: {
      id: u.id,
      name: u.name ?? u.email,
      email: u.email,
      role: u.role,
      initials,
      permissions: Array.from(req.permissions ?? []),
    },
  });
});

// /me/clients — clients assigned to the calling user. Used by the timesheet
// dropdown so employees only see clients they're allowed to bill against.
meRouter.get("/clients", requirePermission("timesheets.read.self"), async (req, res, next) => {
  try {
    if (!req.userId) return res.status(401).json({ error: "Not authenticated" });
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT c.id, c.name, c.code, c.description, c.active
        FROM client c
        JOIN client_assignment ca ON ca.client_id = c.id
        WHERE ca.user_id = ${req.userId} AND c.active = true
        ORDER BY lower(c.name)
      `);
      return r.rows;
    });
    res.json({ clients: rows });
  } catch (err) {
    next(err);
  }
});
