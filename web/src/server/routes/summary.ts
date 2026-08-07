import { Router } from "@/server/http";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";

export const summaryRouter = Router();

// Aggregates used in page headers + filter chips. Single round trip.
summaryRouter.get("/", async (req, res, next) => {
  try {
    const data = await withTenant(req.tenantId!, async (db) => {
      // Count only *currently active* leads — a soft-deleted lead has its
      // `lead` party_role end-dated. The lead table row is preserved for
      // audit, but shouldn't inflate the sidebar badge.
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
        JOIN work_item wi ON wi.id = l.work_item_id
        JOIN party p      ON p.id  = wi.party_id
        WHERE EXISTS (
          SELECT 1 FROM party_role pr
          WHERE pr.party_id = p.id AND pr.role = 'lead' AND pr.valid_to IS NULL
        )
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

      // Case counts for the sidebar badge + dashboard hero. Field name kept
      // as `tickets` in the response for now to avoid touching every call
      // site that reads `summary.tickets.open`. The web layer renames it.
      const cases = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE status NOT IN ('closed','resolved','cancelled'))::int AS "open",
          COUNT(*) FILTER (WHERE due_at < NOW() AND status NOT IN ('closed','resolved','cancelled'))::int AS "overdue"
        FROM support_case
      `);

      return { overall: overall.rows[0], byStage: byStage.rows, cases: cases.rows[0] };
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
