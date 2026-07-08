import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

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

// ─── Per-user view preferences ─────────────────────────────────────────
//
// Each user can hide/reorder saved-view tabs on any list surface (leads,
// pipeline, learners, cases, etc). Preferences live in user_view_preference
// keyed by (user_id, view_id) — a NULL view_id represents the "All leads"
// pseudo-view, so a user can hide the default tab too if they want.
//
// GET  /me/view-preferences?scope=pipeline_list
// PATCH /me/view-preferences  — body: { scope, preferences: [{viewId|null, hidden, sortOrder}, …] }

meRouter.get("/view-preferences", async (req, res, next) => {
  try {
    if (!req.userId || !req.tenantId) return res.status(401).json({ error: "not authenticated" });
    const scope = String(req.query.scope ?? "").trim();
    if (!scope) return res.status(400).json({ error: "scope query param required" });
    const rows = await withTenant(req.tenantId, async (db) => {
      const r = await db.execute(sql`
        SELECT view_id     AS "viewId",
               hidden,
               sort_order  AS "sortOrder",
               updated_at  AS "updatedAt"
        FROM user_view_preference
        WHERE user_id = ${req.userId} AND scope = ${scope}
      `);
      return r.rows;
    });
    res.json({ scope, preferences: rows });
  } catch (err) { next(err); }
});

// PATCH — upsert one or more preference rows. Body:
//   { scope: 'pipeline_list',
//     preferences: [{ viewId: '<uuid>'|null, hidden?: boolean, sortOrder?: number }, ...] }
// Any preference not included keeps its previous value.
meRouter.patch("/view-preferences", async (req, res, next) => {
  try {
    if (!req.userId || !req.tenantId) return res.status(401).json({ error: "not authenticated" });
    const scope = String(req.body?.scope ?? "").trim();
    if (!scope) return res.status(400).json({ error: "scope is required" });
    const prefs = Array.isArray(req.body?.preferences) ? req.body.preferences : [];
    if (prefs.length === 0) return res.json({ ok: true, updated: 0 });

    let updated = 0;
    await withTenant(req.tenantId, async (db) => {
      for (const p of prefs) {
        if (typeof p !== "object" || p === null) continue;
        const rawViewId = (p as { viewId?: unknown }).viewId;
        const viewId = rawViewId === null || rawViewId === undefined ? null
          : (typeof rawViewId === "string" && /^[0-9a-fA-F-]{36}$/.test(rawViewId) ? rawViewId : null);
        // Reject non-null-non-uuid values to prevent malformed inserts.
        if (rawViewId != null && viewId === null) continue;

        const hidden = typeof (p as { hidden?: unknown }).hidden === "boolean"
          ? (p as { hidden: boolean }).hidden : null;
        const sortOrder = typeof (p as { sortOrder?: unknown }).sortOrder === "number"
          ? Math.floor((p as { sortOrder: number }).sortOrder) : null;

        if (hidden === null && sortOrder === null) continue; // nothing to change

        // UPSERT keyed on the appropriate partial unique index.
        if (viewId === null) {
          await db.execute(sql`
            INSERT INTO user_view_preference (tenant_id, user_id, view_id, scope, hidden, sort_order)
            VALUES (${req.tenantId}, ${req.userId}, NULL, ${scope},
                    ${hidden ?? false}, ${sortOrder ?? 0})
            ON CONFLICT (user_id, scope) WHERE view_id IS NULL
            DO UPDATE SET
              hidden     = COALESCE(${hidden}, user_view_preference.hidden),
              sort_order = COALESCE(${sortOrder}, user_view_preference.sort_order),
              updated_at = NOW()
          `);
        } else {
          await db.execute(sql`
            INSERT INTO user_view_preference (tenant_id, user_id, view_id, scope, hidden, sort_order)
            VALUES (${req.tenantId}, ${req.userId}, ${viewId}, ${scope},
                    ${hidden ?? false}, ${sortOrder ?? 0})
            ON CONFLICT (user_id, view_id) WHERE view_id IS NOT NULL
            DO UPDATE SET
              hidden     = COALESCE(${hidden}, user_view_preference.hidden),
              sort_order = COALESCE(${sortOrder}, user_view_preference.sort_order),
              updated_at = NOW()
          `);
        }
        updated += 1;
      }
    });
    res.json({ ok: true, updated });
  } catch (err) { next(err); }
});
