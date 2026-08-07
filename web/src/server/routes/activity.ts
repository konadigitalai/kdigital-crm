import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

export const activityRouter = Router();

// Home-page feed: top-level events, not per-record timeline rows.
// We distinguish them by tag — record-page rows have tag IN ('ai','you'),
// home-page feed rows have tag IN ('auto','sent','need').
activityRouter.get("/", async (req, res, next) => {
  try {
    const limit = Number(req.query.limit ?? 10);
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          a.id, a.actor_type AS "actorType", a.actor_name AS "actorName",
          a.verb, a.detail, a.tag,
          a.icon_key AS "iconKey", a.icon_bg AS "iconBg", a.icon_stroke AS "iconStroke",
          a.payload, a.ts,
          wi.number AS "workItemNumber"
        FROM activity a
        LEFT JOIN work_item wi ON wi.id = a.work_item_id
        WHERE a.tag IN ('auto','sent','need')
        ORDER BY a.ts DESC
        LIMIT ${limit}
      `);
      return r.rows;
    });
    res.json({ feed: rows });
  } catch (err) {
    next(err);
  }
});
