import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { requirePermission } from "../middleware/require.js";
import { draftFollowup } from "../agents/outreach.js";
import { scoreLead, scoreAllOpen } from "../agents/scoring.js";
import { suggestNba } from "../agents/nba.js";
import { runForecast, getLatestForecast } from "../agents/forecast.js";
import { askEdify, listEdifySessions, getEdifySession, deleteEdifySession, renameEdifySession } from "../agents/edify.js";
import { metaFor } from "../lib/agent-meta.js";
import { partyIdFromAppUserId } from "../lib/party/resolve.js";

export const agentsRouter = Router();

// ── Home-page agent cards. Visual + descriptive fields come from the code-side
//    AGENT_META registry; run rows only contribute the live status pill, target
//    string, and the 24h run count. This way agent cards never go blank just
//    because a fresh agent_run row didn't populate visual columns.
agentsRouter.get("/runs", requirePermission("agents.read"), async (req, res, next) => {
  try {
    const data = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          a.key, a.name, a.enabled,
          ( SELECT json_build_object(
              'status',     ar.status,
              'target',     ar.target,
              'live',       ar.live,
              'startedAt',  ar.started_at,
              'finishedAt', ar.finished_at
            )
            FROM agent_run ar
            WHERE ar.tenant_id = a.tenant_id AND ar.agent_key = a.key
            ORDER BY ar.started_at DESC
            LIMIT 1
          ) AS "lastRun",
          ( SELECT COUNT(*)::int FROM agent_run ar2
            WHERE ar2.tenant_id = a.tenant_id AND ar2.agent_key = a.key
              AND ar2.status = 'completed'
              AND ar2.started_at > NOW() - INTERVAL '24 hours'
          ) AS "completed24h"
        FROM agent a
        WHERE a.enabled = true
        ORDER BY
          CASE a.domain WHEN 'sales' THEN 0 ELSE 1 END,
          a.name
      `);
      // The forecast card overlays its metric from the latest snapshot rather
      // than just counting runs — same row, just richer copy.
      const fc = await db.execute(sql`
        SELECT numbers, narrative FROM forecast_snapshot
        ORDER BY generated_at DESC
        LIMIT 1
      `);
      return { rows: r.rows, forecast: fc.rows[0] ?? null };
    });

    const forecastSnap = data.forecast as { numbers?: { totals?: { weightedPipelineINR?: number } }; narrative?: { headline?: string; monthTargetReadout?: string } } | null;

    const cards = (data.rows as Array<Record<string, unknown>>).map((row) => {
      const key = row.key as string;
      const meta = metaFor(key);
      const last = row.lastRun as
        | { status: string; target: string | null; live: boolean; startedAt: string; finishedAt: string | null }
        | null;
      const isLive = !!last && last.live && last.status === "running";
      const target = last?.target ?? null;
      const completed = (row.completed24h as number) ?? 0;

      let metricValue = String(completed);
      let rightPill = meta.rightPill;
      let status = isLive
        ? `Running · ${target ?? meta.metricLabel}`
        : last
        ? `Idle · ${target ?? "ready"}`
        : `Idle · ready`;

      if (key === "forecast" && forecastSnap?.numbers?.totals?.weightedPipelineINR != null) {
        const w = forecastSnap.numbers.totals.weightedPipelineINR;
        metricValue =
          w >= 1_00_00_000
            ? `₹${(w / 1_00_00_000).toFixed(1).replace(/\.0$/, "")}Cr`
            : w >= 1_00_000
            ? `₹${Math.round(w / 1_00_000)}L`
            : w >= 1_000
            ? `₹${Math.round(w / 1_000)}k`
            : `₹${w}`;
        if (forecastSnap.narrative?.monthTargetReadout) {
          rightPill = forecastSnap.narrative.monthTargetReadout.slice(0, 60);
        }
        if (forecastSnap.narrative?.headline) {
          status = `Idle · ${forecastSnap.narrative.headline.slice(0, 80)}`;
        }
      }

      return {
        id: key,
        name: row.name,
        glyph: meta.glyph,
        iconKey: meta.iconKey,
        desc: meta.desc,
        live: isLive,
        status,
        target,
        metricLabel: meta.metricLabel,
        metricValue,
        rightPill,
      };
    });

    res.json({ runs: cards });
  } catch (err) {
    next(err);
  }
});

// ── Sidebar "Recent agent runs" — real rows from the last 24h.
agentsRouter.get("/recent", requirePermission("agents.read"), async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT ar.work_item_id AS "id",
               ar.agent_key    AS "agentKey",
               a.name          AS "agentName",
               ar.target, ar.status, ar.live, ar.started_at AS "startedAt"
        FROM agent_run ar
        JOIN agent a ON a.tenant_id = ar.tenant_id AND a.key = ar.agent_key
        WHERE ar.started_at > NOW() - INTERVAL '24 hours'
        ORDER BY ar.live DESC, ar.started_at DESC
        LIMIT 12
      `);
      return r.rows as Array<{
        id: string; agentKey: string; agentName: string;
        target: string | null; status: string;
        live: boolean; startedAt: Date;
      }>;
    });

    const recent = rows.map((row) => ({
      id: row.id,
      agentKey: row.agentKey,
      label: `${row.agentName}${row.target ? ` · ${row.target}` : ""}`,
      status:
        row.live && row.status === "running"
          ? ("run" as const)
          : row.status === "completed"
          ? ("done" as const)
          : ("wait" as const),
    }));
    res.json({ recent });
  } catch (err) {
    next(err);
  }
});

// ── Catalog (admin Agents page). One row per registered agent + last-run metrics.
agentsRouter.get("/catalog", requirePermission("agents.read"), async (req, res, next) => {
  try {
    const data = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          a.key, a.name, a.domain, a.operates_on AS "operatesOn", a.enabled,
          COALESCE(ap.mode, 'supervised') AS mode,
          (
            SELECT json_build_object(
              'workItemId', wi.id,
              'startedAt',  ar.started_at,
              'finishedAt', ar.finished_at,
              'status',     ar.status,
              'target',     ar.target,
              'live',       ar.live,
              'steps',      ar.steps
            )
            FROM agent_run ar
            JOIN work_item wi ON wi.id = ar.work_item_id
            WHERE ar.tenant_id = a.tenant_id AND ar.agent_key = a.key
            ORDER BY ar.started_at DESC
            LIMIT 1
          ) AS "lastRun",
          (
            SELECT COUNT(*)::int FROM agent_run ar2
            WHERE ar2.tenant_id = a.tenant_id AND ar2.agent_key = a.key
              AND ar2.started_at > NOW() - INTERVAL '24 hours'
          ) AS "runsToday"
        FROM agent a
        LEFT JOIN approval_policy ap
          ON ap.tenant_id = a.tenant_id AND ap.action_type = a.key
        ORDER BY
          CASE a.domain WHEN 'sales' THEN 0 ELSE 1 END,
          a.name
      `);
      return r.rows;
    });
    // Merge the implementation registry so the UI can pick the right panel
    // (live action UI vs "not yet available" placeholder) per agent.
    const enriched = (data as Array<Record<string, unknown>>).map((row) => {
      const m = metaFor(row.key as string);
      return {
        ...row,
        status: m.status,
        capabilities: m.capabilities ?? [],
        phase: m.phase ?? null,
        missing: m.missing ?? null,
      };
    });
    res.json({ agents: enriched });
  } catch (err) {
    next(err);
  }
});

// ── Per-agent run history. Used by /agents/[key] detail pages.
agentsRouter.get("/:key/runs", requirePermission("agents.read"), async (req, res, next) => {
  try {
    const key = String(req.params.key);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 10)));
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          ar.work_item_id   AS "workItemId",
          wi.number         AS "number",
          ar.agent_key      AS "agentKey",
          ar.status         AS "status",
          ar.target         AS "target",
          ar.live           AS "live",
          ar.steps          AS "steps",
          ar.started_at     AS "startedAt",
          ar.finished_at    AS "finishedAt"
        FROM agent_run ar
        JOIN work_item wi ON wi.id = ar.work_item_id
        WHERE ar.agent_key = ${key}
        ORDER BY ar.started_at DESC
        LIMIT ${limit}
      `);
      return r.rows;
    });
    res.json({ runs: rows });
  } catch (err) {
    next(err);
  }
});

// ── Run on demand: outreach drafts an email for one lead.
agentsRouter.post(
  "/outreach/draft/:idOrNumber",
  requirePermission("agents.run"),
  async (req, res, next) => {
    try {
      const result = await draftFollowup(req.tenantId!, String(req.params.idOrNumber));
      res.status(201).json(result);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg === "Lead not found") return res.status(404).json({ error: msg });
      next(err);
    }
  },
);

// ── Run on demand: scoring re-scores one lead.
agentsRouter.post(
  "/scoring/score/:idOrNumber",
  requirePermission("agents.run"),
  async (req, res, next) => {
    try {
      const result = await scoreLead(req.tenantId!, String(req.params.idOrNumber));
      res.json(result);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg === "Lead not found") return res.status(404).json({ error: msg });
      next(err);
    }
  },
);

// ── Edify chat assistant. Asking = agents.run (it can hit the LLM with the
//    user's data). Listing/reading sessions = agents.read. Sessions are
//    per-user; only the owning user can read or write to one.

agentsRouter.post("/edify/ask", requirePermission("agents.run"), async (req, res, next) => {
  try {
    const question = String(req.body?.question ?? "").trim();
    const sessionId = req.body?.sessionId ? String(req.body.sessionId) : null;
    if (!question) return res.status(400).json({ error: "Question required" });
    const out = await askEdify(req.tenantId!, req.userId!, question, sessionId);
    res.json(out);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (/empty|too long/i.test(msg)) return res.status(400).json({ error: msg });
    next(err);
  }
});

agentsRouter.get("/edify/sessions", requirePermission("agents.read"), async (req, res, next) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const sessions = await listEdifySessions(req.tenantId!, req.userId!, limit);
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

agentsRouter.get("/edify/sessions/:id", requirePermission("agents.read"), async (req, res, next) => {
  try {
    const data = await getEdifySession(req.tenantId!, req.userId!, String(req.params.id));
    if (!data) return res.status(404).json({ error: "Session not found" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

agentsRouter.patch("/edify/sessions/:id", requirePermission("agents.run"), async (req, res, next) => {
  try {
    const title = String(req.body?.title ?? "");
    const ok = await renameEdifySession(req.tenantId!, req.userId!, String(req.params.id), title);
    if (!ok) return res.status(404).json({ error: "Session not found" });
    res.json({ ok: true });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (/empty/i.test(msg)) return res.status(400).json({ error: msg });
    next(err);
  }
});

agentsRouter.delete("/edify/sessions/:id", requirePermission("agents.run"), async (req, res, next) => {
  try {
    const ok = await deleteEdifySession(req.tenantId!, req.userId!, String(req.params.id));
    if (!ok) return res.status(404).json({ error: "Session not found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Forecast: aggregate + Claude-narrate a tenant-wide pipeline briefing.
agentsRouter.post(
  "/forecast/run",
  requirePermission("agents.run"),
  async (req, res, next) => {
    try {
      // Phase 2: forecast_snapshot.generated_by now FKs party.id — resolve
      // the caller's app_user.id (from req.userId) to their party.id first.
      const generatedByPartyId = req.userId
        ? await withTenant(req.tenantId!, (db) => partyIdFromAppUserId(db, req.userId!))
        : null;
      const snapshot = await runForecast(req.tenantId!, generatedByPartyId);
      res.json(snapshot);
    } catch (err) {
      next(err);
    }
  },
);

agentsRouter.get(
  "/forecast/latest",
  requirePermission("agents.read"),
  async (req, res, next) => {
    try {
      const snapshot = await getLatestForecast(req.tenantId!);
      res.json(snapshot);
    } catch (err) {
      next(err);
    }
  },
);

// ── Run on demand: NBA agent picks the next best action for one lead.
agentsRouter.post(
  "/nba/suggest/:idOrNumber",
  requirePermission("agents.run"),
  async (req, res, next) => {
    try {
      const result = await suggestNba(req.tenantId!, String(req.params.idOrNumber));
      res.json(result);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg === "Lead not found") return res.status(404).json({ error: msg });
      next(err);
    }
  },
);

// ── Bulk: re-score every open lead.
agentsRouter.post(
  "/scoring/score-all",
  requirePermission("agents.run"),
  async (req, res, next) => {
    try {
      const result = await scoreAllOpen(req.tenantId!);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── Admin toggles: enable/disable + autonomy mode.
agentsRouter.patch("/:key", requirePermission("users.manage"), async (req, res, next) => {
  try {
    const key = String(req.params.key);
    const enabled = typeof req.body?.enabled === "boolean" ? req.body.enabled : undefined;
    const mode = req.body?.mode != null ? String(req.body.mode) : undefined;
    if (mode && !["auto", "supervised", "manual"].includes(mode)) {
      return res.status(400).json({ error: "mode must be auto|supervised|manual" });
    }
    const ok = await withTenant(req.tenantId!, async (db) => {
      if (enabled !== undefined) {
        const r = await db.execute(sql`
          UPDATE agent SET enabled = ${enabled} WHERE key = ${key} RETURNING key
        `);
        if (r.rows.length === 0) return false;
      }
      if (mode) {
        await db.execute(sql`
          INSERT INTO approval_policy (tenant_id, action_type, mode)
          VALUES (${req.tenantId}, ${key}, ${mode})
          ON CONFLICT (tenant_id, action_type)
          DO UPDATE SET mode = EXCLUDED.mode
        `);
      }
      return true;
    });
    if (!ok) return res.status(404).json({ error: "Agent not found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
