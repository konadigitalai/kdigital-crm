import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { formatINR } from "./summary.js";

export const pipelineRouter = Router();

// Pipeline columns are driven by lead.rating. Order = funnel direction.
// `key` is what the API+UI use; `label` is the human display string.
const RATING_ORDER: { key: string; label: string }[] = [
  { key: "new lead",  label: "New lead" },
  { key: "attempted", label: "Attempted" },
  { key: "cold",      label: "Cold" },
  { key: "warm",      label: "Warm" },
  { key: "hot",       label: "Hot" },
  { key: "superhot",  label: "Super hot" },
  { key: "enrolled",  label: "Enrolled" },
];

pipelineRouter.get("/", async (req, res, next) => {
  try {
    const result = await withTenant(req.tenantId!, async (db) => {
      const rowsR = await db.execute(sql`
        SELECT
          wi.id              AS id,
          wi.number          AS number,
          p.name             AS name,
          l.initials         AS initials,
          l.city             AS city,
          l.program          AS program,
          l.value            AS value,
          l.stage            AS stage,
          l.stage_label      AS "stageLabel",
          l.score            AS score,
          l.heat             AS heat,
          l.rating           AS rating,
          l.avatar           AS avatar,
          l.nba_icon         AS "nbaIcon",
          l.nba_label        AS "nbaLabel",
          l.nba_ghost        AS "nbaGhost",
          l.next_followup_at AS "nextFollowupAt",
          l.demo_attended_at AS "demoAttendedAt"
        FROM lead l
        JOIN work_item wi ON wi.id = l.work_item_id
        JOIN party p      ON p.id  = wi.party_id
        WHERE EXISTS (
          SELECT 1 FROM party_role pr
          WHERE pr.party_id = p.id AND pr.role = 'lead' AND pr.valid_to IS NULL
        )
        ORDER BY l.score DESC NULLS LAST
      `);

      // Per-rating totals + sum of free-form value strings. Active leads only.
      const totalsR = await db.execute(sql`
        SELECT
          l.rating AS rating,
          COUNT(*)::int AS count,
          SUM(
            CASE
              WHEN l.value ~ '^₹[0-9.]+L$'  THEN (regexp_replace(l.value, '[₹L]', '', 'g'))::numeric * 100000
              WHEN l.value ~ '^₹[0-9.]+Cr$' THEN (regexp_replace(l.value, '[₹Cr]', '', 'g'))::numeric * 10000000
              WHEN l.value ~ '^₹[0-9.]+k$'  THEN (regexp_replace(l.value, '[₹k]', '', 'g'))::numeric * 1000
              ELSE 0
            END
          )::numeric AS sum
        FROM lead l
        JOIN work_item wi ON wi.id = l.work_item_id
        WHERE l.rating IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM party_role pr
            WHERE pr.party_id = wi.party_id AND pr.role = 'lead' AND pr.valid_to IS NULL
          )
        GROUP BY l.rating
      `);

      return { rows: rowsR.rows, totals: totalsR.rows };
    });

    const totalsByRating = new Map<string, { count: number; sum: number }>();
    for (const t of result.totals as Array<{ rating: string; count: number; sum: string | number }>) {
      totalsByRating.set(t.rating, { count: t.count, sum: Number(t.sum) || 0 });
    }
    const rows = result.rows as Array<{ rating: string; [k: string]: unknown }>;

    const grouped = RATING_ORDER.map((s) => {
      const t = totalsByRating.get(s.key) ?? { count: 0, sum: 0 };
      const ratingLeads = rows.filter((l) => l.rating === s.key);
      // AI strip note — short copy keyed to the rating bucket.
      let aiNote: string | null = null;
      if (s.key === "new lead" && t.count > 0) {
        aiNote = `Welcome agent shipped syllabus to **${t.count}** new leads.`;
      } else if (s.key === "attempted" && t.count > 0) {
        aiNote = `Scoring agent flagged **${t.count}** for re-engagement.`;
      } else if (s.key === "hot" && t.count > 0) {
        aiNote = `**${t.count}** leads ready for demo or proposal — pick your move.`;
      } else if (s.key === "superhot" && t.count > 0) {
        aiNote = `**${t.count}** ready to close — Outreach agent is drafting.`;
      } else if (s.key === "enrolled" && t.count > 0) {
        aiNote = `Onboarding agent asked **${t.count}** enrolees for referrals.`;
      }
      return {
        key: s.key,
        label: s.label,
        count: t.count,
        sum: formatINR(t.sum),
        aiNote,
        leads: ratingLeads,
      };
    });

    res.json({ columns: grouped });
  } catch (err) {
    next(err);
  }
});
