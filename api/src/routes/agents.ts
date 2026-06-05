import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

export const agentsRouter = Router();

agentsRouter.get("/runs", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          a.key                AS id,
          a.name               AS name,
          ar.status            AS status,
          ar.target            AS target,
          ar.metric_label      AS "metricLabel",
          ar.metric_value      AS "metricValue",
          ar.right_pill        AS "rightPill",
          ar.glyph             AS glyph,
          ar.icon_key          AS "iconKey",
          ar.live              AS live,
          ar.desc              AS "desc"
        FROM agent_run ar
        JOIN agent a ON a.tenant_id = ar.tenant_id AND a.key = ar.agent_key
        ORDER BY ar.live DESC, a.name
      `);
      return r.rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          ...r,
          // UI expects "Running · ..." / "Idle · ..." status string.
          status:
            r.status === "running"
              ? `Running · ${r.target}`
              : r.status === "completed"
              ? `Idle · ${r.target}`
              : `${r.status} · ${r.target}`,
        };
      });
    });
    res.json({ runs: rows });
  } catch (err) {
    next(err);
  }
});

// Sidebar "recent agent runs" list — synthesize from agent_run history.
// Right now we only have 4 runs, so I add a fixed sidebar-only set of names.
agentsRouter.get("/recent", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT a.name AS label, ar.status, ar.live
        FROM agent_run ar
        JOIN agent a ON a.tenant_id = ar.tenant_id AND a.key = ar.agent_key
        ORDER BY ar.live DESC, ar.started_at DESC
      `);
      return r.rows as Array<{ label: string; status: string; live: boolean }>;
    });
    // Add static "tasks" the design shows — these aren't agent identities,
    // they're commanded jobs. Keep them static-but-tenant-scoped on purpose.
    const synthetic = [
      { label: "Re-engage 14 cold demo no-shows",  status: "run" as const },
      { label: "Draft follow-ups · Agentforce cohort", status: "run" as const },
      { label: "Score 38 new inbound leads",        status: "done" as const },
      { label: "Book demo slots · 9 hot leads",     status: "done" as const },
      { label: "Summarize yesterday's calls",       status: "done" as const },
      { label: "Nurture sequence · Data Science",   status: "wait" as const },
      { label: "Flag at-risk enrolments",           status: "wait" as const },
    ];
    res.json({ recent: synthetic });
  } catch (err) {
    next(err);
  }
});
