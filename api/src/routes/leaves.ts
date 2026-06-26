// Leaves — self-marked. Open to any authenticated user; the legacy
// leaves.read.self permission gate was removed after the Auth0 cutover
// because that permission isn't in the Auth0 catalog. Add it back to
// Auth0 and reinstate `requirePermission("leaves.read.self")` on these
// handlers if access ever needs tightening again.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

export const leavesRouter = Router();

const KINDS = new Set(["sick", "personal", "vacation", "wfh", "holiday"]);
const HALF = new Set(["full", "am", "pm"]);

leavesRouter.get("/", async (req, res, next) => {
  try {
    const targetUserId = req.query.userId ? String(req.query.userId) : req.userId!;
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    if (targetUserId !== req.userId && !req.permissions?.has("leaves.read.all")) {
      return res.status(403).json({ error: "Cannot read another user's leaves" });
    }
    const rows = await withTenant(req.tenantId!, async (db) => {
      if (from && to) {
        const r = await db.execute(sql`
          SELECT id, user_id AS "userId", date, kind, half_day AS "halfDay", note, created_at AS "createdAt"
          FROM leave_day
          WHERE user_id = ${targetUserId} AND date BETWEEN ${from} AND ${to}
          ORDER BY date
        `);
        return r.rows;
      }
      const r = await db.execute(sql`
        SELECT id, user_id AS "userId", date, kind, half_day AS "halfDay", note, created_at AS "createdAt"
        FROM leave_day
        WHERE user_id = ${targetUserId}
        ORDER BY date DESC
        LIMIT 100
      `);
      return r.rows;
    });
    res.json({ leaves: rows });
  } catch (err) {
    next(err);
  }
});

leavesRouter.post("/", async (req, res, next) => {
  try {
    const date = String(req.body?.date ?? "").trim();
    const kind = String(req.body?.kind ?? "").trim();
    const halfDay = req.body?.halfDay ? String(req.body.halfDay) : "full";
    const note = req.body?.note ? String(req.body.note).trim() : null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    if (!KINDS.has(kind)) return res.status(400).json({ error: "kind invalid" });
    if (!HALF.has(halfDay)) return res.status(400).json({ error: "halfDay invalid" });

    const created = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        INSERT INTO leave_day (tenant_id, user_id, date, kind, half_day, note)
        VALUES (${req.tenantId}, ${req.userId}, ${date}, ${kind}, ${halfDay}, ${note})
        ON CONFLICT (user_id, date) DO UPDATE SET kind = EXCLUDED.kind, half_day = EXCLUDED.half_day, note = EXCLUDED.note
        RETURNING id, user_id AS "userId", date, kind, half_day AS "halfDay", note, created_at AS "createdAt"
      `);
      return r.rows[0];
    });
    res.status(201).json({ leave: created });
  } catch (err) {
    next(err);
  }
});

leavesRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const b = req.body ?? {};
    if (b.kind !== undefined && !KINDS.has(String(b.kind))) return res.status(400).json({ error: "kind invalid" });
    if (b.halfDay !== undefined && !HALF.has(String(b.halfDay))) return res.status(400).json({ error: "halfDay invalid" });
    const out = await withTenant(req.tenantId!, async (db) => {
      const own = await db.execute(sql`SELECT user_id FROM leave_day WHERE id = ${id}`);
      const ownerRow = own.rows[0] as { user_id: string } | undefined;
      if (!ownerRow) return { kind: "not-found" as const };
      if (ownerRow.user_id !== req.userId) return { kind: "forbidden" as const };
      const r = await db.execute(sql`
        UPDATE leave_day SET
          kind = COALESCE(${b.kind ?? null}, kind),
          half_day = COALESCE(${b.halfDay ?? null}, half_day),
          note = COALESCE(${b.note ?? null}, note)
        WHERE id = ${id}
        RETURNING id, user_id AS "userId", date, kind, half_day AS "halfDay", note, created_at AS "createdAt"
      `);
      return { kind: "ok" as const, leave: r.rows[0] };
    });
    if (out.kind === "not-found") return res.status(404).json({ error: "Leave not found" });
    if (out.kind === "forbidden") return res.status(403).json({ error: "Not your leave" });
    res.json({ leave: out.leave });
  } catch (err) {
    next(err);
  }
});

leavesRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const out = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        DELETE FROM leave_day WHERE id = ${id} AND user_id = ${req.userId} RETURNING id
      `);
      return r.rows.length > 0;
    });
    if (!out) return res.status(404).json({ error: "Leave not found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
