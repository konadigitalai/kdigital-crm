import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { formatINR } from "./summary.js";

export const pipelineRouter = Router();

// Stage labels + AI strip notes are pure presentation; counts/sums come from the DB.
const STAGE_ORDER: { key: string; label: string; aiNote?: string | null }[] = [
  { key: "new",  label: "New inbound" },
  { key: "qual", label: "Qualified" },
  { key: "demo", label: "Demo / Trial" },
  { key: "neg",  label: "Negotiation" },
  { key: "won",  label: "Enrolled" },
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
          l.avatar           AS avatar,
          l.nba_icon         AS "nbaIcon",
          l.nba_label        AS "nbaLabel",
          l.nba_ghost        AS "nbaGhost"
        FROM lead l
        JOIN work_item wi ON wi.id = l.work_item_id
        JOIN party p      ON p.id  = wi.party_id
        WHERE EXISTS (
          SELECT 1 FROM party_role pr
          WHERE pr.party_id = p.id AND pr.role = 'lead' AND pr.valid_to IS NULL
        )
        ORDER BY l.score DESC NULLS LAST
      `);

      // Real per-stage totals. We derive the "sum" from each lead's free-form
      // value field (₹1.49L / ₹99k / ₹59k …). Excludes converted leads.
      const totalsR = await db.execute(sql`
        SELECT
          l.stage AS stage,
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
        WHERE l.stage IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM party_role pr
            WHERE pr.party_id = wi.party_id AND pr.role = 'lead' AND pr.valid_to IS NULL
          )
        GROUP BY l.stage
      `);

      return { rows: rowsR.rows, totals: totalsR.rows };
    });

    const totalsByStage = new Map<string, { count: number; sum: number }>();
    for (const t of result.totals as Array<{ stage: string; count: number; sum: string | number }>) {
      totalsByStage.set(t.stage, { count: t.count, sum: Number(t.sum) || 0 });
    }
    const rows = result.rows as Array<{ stage: string; [k: string]: unknown }>;

    const grouped = STAGE_ORDER.map((s) => {
      const t = totalsByStage.get(s.key) ?? { count: 0, sum: 0 };
      const stageLeads = rows.filter((l) => l.stage === s.key);
      // AI strip note — only show on stages where an agent did something visible.
      let aiNote: string | null = null;
      if (s.key === "new" && t.count > 0) {
        aiNote = `Agent welcomed **${t.count}** leads & sent the syllabus automatically.`;
      } else if (s.key === "demo" && t.count > 0) {
        aiNote = `Scheduler booked **${t.count}** demos & sent prep checklists.`;
      } else if (s.key === "won" && t.count > 0) {
        aiNote = `Agent asked **${t.count}** enrollees for referrals.`;
      }
      return {
        key: s.key,
        label: s.label,
        count: t.count,
        sum: formatINR(t.sum),
        aiNote,
        leads: stageLeads,
      };
    });

    res.json({ columns: grouped });
  } catch (err) {
    next(err);
  }
});
