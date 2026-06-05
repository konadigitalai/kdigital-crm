import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

export const summaryRouter = Router();

// Aggregates used in page headers + filter chips. Single round trip.
summaryRouter.get("/", async (req, res, next) => {
  try {
    const data = await withTenant(req.tenantId!, async (db) => {
      const overall = await db.execute(sql`
        SELECT
          COUNT(*)::int                                            AS "total",
          COUNT(*) FILTER (WHERE l.heat = 'hot')::int              AS "hot",
          COUNT(*) FILTER (WHERE l.heat = 'warm')::int             AS "warm",
          COUNT(*) FILTER (WHERE l.heat = 'cold')::int             AS "cold",
          COUNT(*) FILTER (WHERE l.heat = 'hot' AND l.score >= 80
                                AND l.stage IN ('demo','neg'))::int AS "hotOvernight",
          (SELECT COUNT(*)::int FROM approval WHERE status = 'pending') AS "pendingApprovals",
          (SELECT COUNT(*)::int FROM agent_run WHERE live = true)       AS "liveAgents"
        FROM lead l
      `);

      const byStage = await db.execute(sql`
        SELECT
          l.stage AS stage,
          COUNT(*)::int AS count,
          SUM(d.value)::numeric AS deal_value_sum
        FROM lead l
        LEFT JOIN deal d ON d.work_item_id = l.work_item_id
        WHERE l.stage IS NOT NULL
        GROUP BY l.stage
      `);

      return { overall: overall.rows[0], byStage: byStage.rows };
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Format an INR-like sum from a numeric — handles up to crores.
// Used by the pipeline route below.
export function formatINR(n: number): string {
  if (!n || isNaN(n)) return "—";
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(1).replace(/\.0$/, "")}Cr`;
  if (n >= 1_00_000)    return `₹${Math.round(n / 1_00_000)}L`;
  if (n >= 1_000)       return `₹${Math.round(n / 1_000)}k`;
  return `₹${Math.round(n)}`;
}
