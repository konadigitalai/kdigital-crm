// Campaigns REST — create draft → preview audience → schedule → run.
//
// Mounted at /campaigns behind authMiddleware. Every write requires the
// `messaging.send` permission; reads require `messaging.read`.
//
// The actual dispatch happens in lib/campaigns/worker.ts. This module
// only mutates DB rows — the worker picks up `scheduled`/`running` state
// and drips out per-recipient sends.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { requirePermission } from "../middleware/require.js";
import { resolveActorPartyId } from "../lib/party/resolve.js";
import { resolveAudience, listAudienceFields, type FilterState } from "../lib/campaigns/audience.js";
import { readTwilioConfig, TwilioNotConfigured } from "../lib/twilio/client.js";

export const campaignsRouter = Router();

// ─── GET /campaigns/audience-fields ───────────────────────────────────────
// Static allowlist — FE consumes this so the filter picker can only offer
// fields the resolver actually knows about.

campaignsRouter.get("/audience-fields", requirePermission("messaging.read"), (_req, res) => {
  res.json({ fields: listAudienceFields() });
});

// ─── POST /campaigns/preview ──────────────────────────────────────────────
// Body: { audience: FilterState }
// Returns: { count, sample: AudienceRow[10] }
// Doesn't require a saved campaign yet — used by the new-campaign wizard.

campaignsRouter.post("/preview", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const audience = req.body?.audience as FilterState | undefined;
    if (!audience || typeof audience !== "object") {
      return res.status(400).json({ error: "audience is required" });
    }
    const preview = await withTenant(req.tenantId!, async (db) => {
      const full = await resolveAudience(db, audience, { limit: 5000 });
      return { count: full.count, sample: full.rows.slice(0, 10) };
    });
    res.json(preview);
  } catch (err) { next(err); }
});

// ─── POST /campaigns ──────────────────────────────────────────────────────
// Create a draft.
// Body: {
//   name, contentSid, contentVariableBindings, audience,
//   sendRatePerSec?, dailyCap?, scheduledAt?  (all optional except name+sid+audience)
// }

campaignsRouter.post("/", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const b = req.body as {
      name?: string;
      contentSid?: string;
      contentVariableBindings?: Record<string, string>;
      audience?: FilterState;
      sendRatePerSec?: number;
      dailyCap?: number | null;
      scheduledAt?: string | null;
    };
    const name = String(b.name ?? "").trim();
    const contentSid = String(b.contentSid ?? "").trim();
    if (!name)       return res.status(400).json({ error: "name is required" });
    if (!contentSid) return res.status(400).json({ error: "contentSid is required" });
    if (!b.audience) return res.status(400).json({ error: "audience is required" });

    const bindings = (b.contentVariableBindings && typeof b.contentVariableBindings === "object")
      ? b.contentVariableBindings : {};
    const rate = Math.min(Math.max(Number(b.sendRatePerSec ?? 5), 1), 100);
    const dailyCap = b.dailyCap == null ? null : Math.max(Number(b.dailyCap), 1);

    const row = await withTenant(req.tenantId!, async (db) => {
      // Validate template exists + is approved.
      const tR = await db.execute(sql`
        SELECT approval_status AS "approvalStatus", friendly_name AS "friendlyName"
        FROM wa_template WHERE content_sid = ${contentSid} LIMIT 1
      `);
      const t = tR.rows[0] as { approvalStatus: string; friendlyName: string } | undefined;
      if (!t)                            return { kind: "bad-template" as const, reason: "Unknown template. Sync /templates first." };
      if (t.approvalStatus !== "approved") return { kind: "bad-template" as const, reason: `Template ${t.friendlyName} is ${t.approvalStatus}, not approved.` };

      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const r = await db.execute(sql`
        INSERT INTO campaign (
          tenant_id, name, created_by, channel,
          content_sid, content_variable_bindings, audience,
          status, scheduled_at, send_rate_per_sec, daily_cap
        )
        VALUES (
          current_tenant(), ${name}, ${actorPartyId}, 'whatsapp',
          ${contentSid}, ${JSON.stringify(bindings)}::jsonb, ${JSON.stringify(b.audience)}::jsonb,
          'draft',
          ${b.scheduledAt ? new Date(b.scheduledAt).toISOString() : null},
          ${rate}, ${dailyCap}
        )
        RETURNING id, name, status, scheduled_at AS "scheduledAt"
      `);
      return { kind: "ok" as const, campaign: r.rows[0] };
    });

    if (row.kind === "bad-template") return res.status(400).json({ error: row.reason });
    res.json(row.campaign);
  } catch (err) { next(err); }
});

// ─── POST /campaigns/:id/schedule ─────────────────────────────────────────
// Materializes the audience → campaign_recipient rows and flips the
// campaign to `scheduled`. Once scheduled, the worker owns the campaign;
// only pause/resume/cancel are legal.

campaignsRouter.post("/:id/schedule", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const campaignId = String(req.params.id ?? "");
    if (!/^[0-9a-fA-F-]{36}$/.test(campaignId)) return res.status(400).json({ error: "bad id" });

    // Twilio config is required before we let a campaign go live.
    try { readTwilioConfig(); }
    catch (e) {
      if (e instanceof TwilioNotConfigured) return res.status(503).json({ error: e.message });
      throw e;
    }

    const result = await withTenant(req.tenantId!, async (db) => {
      const cR = await db.execute(sql`
        SELECT id, status, audience, scheduled_at AS "scheduledAt"
        FROM campaign WHERE id = ${campaignId} LIMIT 1
      `);
      const c = cR.rows[0] as { id: string; status: string; audience: FilterState; scheduledAt: string | null } | undefined;
      if (!c) return { kind: "not-found" as const };
      if (c.status !== "draft" && c.status !== "scheduled") {
        return { kind: "bad-state" as const, reason: `campaign is ${c.status}` };
      }

      // Materialize recipients. Skip parties that already exist for this
      // campaign (idempotent re-schedule).
      const aud = await resolveAudience(db, c.audience);
      if (aud.rows.length === 0) {
        return { kind: "empty-audience" as const };
      }

      // Batch insert. ON CONFLICT DO NOTHING on the (campaign_id, party_id)
      // unique index makes this idempotent.
      // We stage rows in chunks of 500 to keep the parameter count bounded.
      const CHUNK = 500;
      let inserted = 0;
      for (let i = 0; i < aud.rows.length; i += CHUNK) {
        const slice = aud.rows.slice(i, i + CHUNK);
        // Build a VALUES list — DRIZZLE bound values via sql.join for safety.
        const valuesSql = sql.join(
          slice.map((row) => sql`(
            current_tenant(),
            ${campaignId}::uuid,
            ${row.partyId}::uuid,
            ${row.workItemId}::uuid,
            'pending'
          )`),
          sql`, `,
        );
        const r = await db.execute(sql`
          INSERT INTO campaign_recipient (tenant_id, campaign_id, party_id, work_item_id, status)
          VALUES ${valuesSql}
          ON CONFLICT (campaign_id, party_id) DO NOTHING
          RETURNING id
        `);
        inserted += r.rows.length;
      }

      await db.execute(sql`
        UPDATE campaign
        SET status = 'scheduled',
            scheduled_at = COALESCE(scheduled_at, NOW())
        WHERE id = ${campaignId}
      `);
      return { kind: "ok" as const, inserted, matched: aud.count };
    });

    if (result.kind === "not-found")      return res.status(404).json({ error: "campaign not found" });
    if (result.kind === "bad-state")      return res.status(400).json({ error: result.reason });
    if (result.kind === "empty-audience") return res.status(400).json({ error: "audience matched 0 leads" });
    res.json(result);
  } catch (err) { next(err); }
});

// ─── POST /campaigns/:id/pause | /resume | /cancel ────────────────────────

async function transitionCampaign(
  req: import("express").Request,
  res: import("express").Response,
  from: string[],
  to: string,
): Promise<void> {
  const campaignId = String(req.params.id ?? "");
  if (!/^[0-9a-fA-F-]{36}$/.test(campaignId)) {
    res.status(400).json({ error: "bad id" });
    return;
  }
  const okRow = await withTenant(req.tenantId!, async (db) => {
    // Passing a JS string[] to Drizzle serializes to a record (`(a,b,c)`),
    // not a text array — so `ANY($::text[])` bombs with
    // `cannot cast type record to text[]`. Build an IN list instead.
    const fromList = sql.join(from.map((s) => sql`${s}`), sql`, `);
    const r = await db.execute(sql`
      UPDATE campaign
      SET status = ${to},
          completed_at = CASE WHEN ${to} = 'cancelled' THEN NOW() ELSE completed_at END
      WHERE id = ${campaignId}
        AND status IN (${fromList})
      RETURNING id, status
    `);
    return r.rows[0] as { id: string; status: string } | undefined;
  });
  if (!okRow) {
    res.status(400).json({ error: `campaign is not in one of: ${from.join(", ")}` });
    return;
  }
  res.json(okRow);
}

campaignsRouter.post("/:id/pause",  requirePermission("messaging.send"), (req, res, next) => {
  transitionCampaign(req, res, ["running", "scheduled"], "paused").catch(next);
});
campaignsRouter.post("/:id/resume", requirePermission("messaging.send"), (req, res, next) => {
  transitionCampaign(req, res, ["paused"], "running").catch(next);
});
campaignsRouter.post("/:id/cancel", requirePermission("messaging.send"), (req, res, next) => {
  transitionCampaign(req, res, ["draft", "scheduled", "running", "paused"], "cancelled").catch(next);
});

// ─── GET /campaigns ───────────────────────────────────────────────────────
// List with progress counters.

campaignsRouter.get("/", requirePermission("messaging.read"), async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          c.id, c.name, c.channel, c.content_sid AS "contentSid",
          c.status, c.scheduled_at AS "scheduledAt",
          c.send_rate_per_sec AS "sendRatePerSec", c.daily_cap AS "dailyCap",
          c.created_at AS "createdAt", c.started_at AS "startedAt", c.completed_at AS "completedAt",
          (SELECT COUNT(*)::int FROM campaign_recipient WHERE campaign_id = c.id) AS "totalRecipients",
          (SELECT COUNT(*)::int FROM campaign_recipient WHERE campaign_id = c.id AND status = 'sent') AS "sentCount",
          (SELECT COUNT(*)::int FROM campaign_recipient WHERE campaign_id = c.id AND status = 'delivered') AS "deliveredCount",
          (SELECT COUNT(*)::int FROM campaign_recipient WHERE campaign_id = c.id AND status = 'failed')     AS "failedCount",
          (SELECT COUNT(*)::int FROM campaign_recipient WHERE campaign_id = c.id AND status = 'pending')    AS "pendingCount",
          (SELECT COUNT(*)::int FROM campaign_recipient WHERE campaign_id = c.id
             AND status IN ('skipped_optout','skipped_no_phone'))                                             AS "skippedCount",
          t.friendly_name AS "templateName"
        FROM campaign c
        LEFT JOIN wa_template t ON t.content_sid = c.content_sid
        ORDER BY c.created_at DESC
      `);
      return r.rows;
    });
    res.json({ campaigns: rows });
  } catch (err) { next(err); }
});

// ─── Trigger CRUD ─────────────────────────────────────────────────────────
// Mounted here (rather than a separate router) so all campaign machinery
// lives under one prefix. Triggers are auto-campaigns behind the scenes.

campaignsRouter.get("/triggers/list", requirePermission("messaging.read"), async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          t.id, t.name, t.event_type AS "eventType", t.condition,
          t.content_sid AS "contentSid", t.variable_bindings AS "variableBindings",
          t.cooldown_hours AS "cooldownHours", t.enabled,
          t.auto_campaign_id AS "autoCampaignId",
          t.created_at AS "createdAt",
          wt.friendly_name AS "templateName",
          (SELECT COUNT(*)::int FROM campaign_trigger_fire f
             WHERE f.trigger_id = t.id) AS "totalFires"
        FROM campaign_trigger t
        LEFT JOIN wa_template wt ON wt.content_sid = t.content_sid
        ORDER BY t.created_at DESC
      `);
      return r.rows;
    });
    res.json({ triggers: rows });
  } catch (err) { next(err); }
});

campaignsRouter.post("/triggers", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const b = req.body as {
      name?: string;
      eventType?: string;
      condition?: Record<string, unknown>;
      contentSid?: string;
      variableBindings?: Record<string, string>;
      cooldownHours?: number;
      enabled?: boolean;
    };
    const name = String(b.name ?? "").trim();
    const eventType = String(b.eventType ?? "").trim();
    const contentSid = String(b.contentSid ?? "").trim();
    if (!name)       return res.status(400).json({ error: "name is required" });
    if (!eventType)  return res.status(400).json({ error: "eventType is required" });
    if (!contentSid) return res.status(400).json({ error: "contentSid is required" });
    const cooldownHours = Math.max(0, Math.min(720, Number(b.cooldownHours ?? 24)));

    const row = await withTenant(req.tenantId!, async (db) => {
      // Validate template.
      const tR = await db.execute(sql`
        SELECT approval_status AS "approvalStatus" FROM wa_template WHERE content_sid = ${contentSid} LIMIT 1
      `);
      const t = tR.rows[0] as { approvalStatus: string } | undefined;
      if (!t) return { kind: "bad-template" as const, reason: "unknown template — sync first" };
      if (t.approvalStatus !== "approved") return { kind: "bad-template" as const, reason: `template is ${t.approvalStatus}` };

      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const r = await db.execute(sql`
        INSERT INTO campaign_trigger (
          tenant_id, name, content_sid, variable_bindings,
          event_type, condition, cooldown_hours, enabled, created_by
        )
        VALUES (
          current_tenant(), ${name}, ${contentSid},
          ${JSON.stringify(b.variableBindings ?? {})}::jsonb,
          ${eventType},
          ${JSON.stringify(b.condition ?? {})}::jsonb,
          ${cooldownHours},
          ${b.enabled === true},
          ${actorPartyId}
        )
        RETURNING id, name, event_type AS "eventType", enabled
      `);
      return { kind: "ok" as const, trigger: r.rows[0] };
    });
    if (row.kind === "bad-template") return res.status(400).json({ error: row.reason });
    res.json(row.trigger);
  } catch (err) { next(err); }
});

campaignsRouter.patch("/triggers/:id", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "bad id" });
    const b = req.body as {
      name?: string;
      condition?: Record<string, unknown>;
      variableBindings?: Record<string, string>;
      cooldownHours?: number;
      enabled?: boolean;
    };
    const sets: import("drizzle-orm").SQL[] = [];
    if (b.name !== undefined)             sets.push(sql`name = ${String(b.name).trim()}`);
    if (b.condition !== undefined)        sets.push(sql`condition = ${JSON.stringify(b.condition)}::jsonb`);
    if (b.variableBindings !== undefined) sets.push(sql`variable_bindings = ${JSON.stringify(b.variableBindings)}::jsonb`);
    if (b.cooldownHours !== undefined)    sets.push(sql`cooldown_hours = ${Math.max(0, Math.min(720, Number(b.cooldownHours)))}`);
    if (b.enabled !== undefined)          sets.push(sql`enabled = ${b.enabled === true}`);
    if (sets.length === 0) return res.status(400).json({ error: "no changes" });
    sets.push(sql`updated_at = NOW()`);

    const row = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        UPDATE campaign_trigger SET ${sql.join(sets, sql`, `)}
        WHERE id = ${id}
        RETURNING id, name, event_type AS "eventType", enabled,
                  auto_campaign_id AS "autoCampaignId",
                  variable_bindings AS "variableBindings",
                  content_sid AS "contentSid"
      `);
      const updated = r.rows[0] as {
        id: string; name: string; eventType: string; enabled: boolean;
        autoCampaignId: string | null;
        variableBindings: Record<string, string>;
        contentSid: string;
      } | undefined;

      // If bindings changed and this trigger has already spawned an
      // auto-campaign, sync the change forward so the campaign worker
      // resolves the new values on future fires. Freezing bindings on the
      // auto-campaign would silently keep sending stale values.
      if (updated?.autoCampaignId && b.variableBindings !== undefined) {
        await db.execute(sql`
          UPDATE campaign
          SET content_variable_bindings = ${JSON.stringify(updated.variableBindings)}::jsonb
          WHERE id = ${updated.autoCampaignId}
        `);
      }
      return updated;
    });
    if (!row) return res.status(404).json({ error: "trigger not found" });
    const { autoCampaignId: _a, variableBindings: _v, contentSid: _c, ...publicRow } = row;
    res.json(publicRow);
  } catch (err) { next(err); }
});

campaignsRouter.delete("/triggers/:id", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "bad id" });
    await withTenant(req.tenantId!, async (db) => {
      await db.execute(sql`DELETE FROM campaign_trigger WHERE id = ${id}`);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── GET /campaigns/:id ───────────────────────────────────────────────────

campaignsRouter.get("/:id", requirePermission("messaging.read"), async (req, res, next) => {
  try {
    const campaignId = String(req.params.id ?? "");
    if (!/^[0-9a-fA-F-]{36}$/.test(campaignId)) return res.status(400).json({ error: "bad id" });
    const row = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          c.id, c.name, c.channel, c.content_sid AS "contentSid",
          c.content_variable_bindings AS "contentVariableBindings",
          c.audience, c.status, c.scheduled_at AS "scheduledAt",
          c.send_rate_per_sec AS "sendRatePerSec", c.daily_cap AS "dailyCap",
          c.created_at AS "createdAt", c.started_at AS "startedAt", c.completed_at AS "completedAt",
          t.friendly_name AS "templateName", t.variables AS "templateVariables"
        FROM campaign c
        LEFT JOIN wa_template t ON t.content_sid = c.content_sid
        WHERE c.id = ${campaignId} LIMIT 1
      `);
      return r.rows[0] ?? null;
    });
    if (!row) return res.status(404).json({ error: "campaign not found" });
    res.json({ campaign: row });
  } catch (err) { next(err); }
});

// ─── GET /campaigns/:id/recipients ────────────────────────────────────────

campaignsRouter.get("/:id/recipients", requirePermission("messaging.read"), async (req, res, next) => {
  try {
    const campaignId = String(req.params.id ?? "");
    if (!/^[0-9a-fA-F-]{36}$/.test(campaignId)) return res.status(400).json({ error: "bad id" });
    const status = String(req.query.status ?? "").trim();
    const limit  = Math.min(Number(req.query.limit ?? 500), 2000);

    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = status
        ? await db.execute(sql`
            SELECT
              cr.id, cr.status, cr.error_code AS "errorCode", cr.error_message AS "errorMessage",
              cr.sent_at AS "sentAt", cr.delivered_at AS "deliveredAt", cr.queued_at AS "queuedAt",
              cr.resolved_variables AS "resolvedVariables",
              p.name AS "partyName", p.phone AS "partyPhone",
              wi.number AS "leadNumber"
            FROM campaign_recipient cr
            JOIN party p ON p.id = cr.party_id
            LEFT JOIN work_item wi ON wi.id = cr.work_item_id
            WHERE cr.campaign_id = ${campaignId} AND cr.status = ${status}
            ORDER BY cr.queued_at DESC
            LIMIT ${limit}
          `)
        : await db.execute(sql`
            SELECT
              cr.id, cr.status, cr.error_code AS "errorCode", cr.error_message AS "errorMessage",
              cr.sent_at AS "sentAt", cr.delivered_at AS "deliveredAt", cr.queued_at AS "queuedAt",
              cr.resolved_variables AS "resolvedVariables",
              p.name AS "partyName", p.phone AS "partyPhone",
              wi.number AS "leadNumber"
            FROM campaign_recipient cr
            JOIN party p ON p.id = cr.party_id
            LEFT JOIN work_item wi ON wi.id = cr.work_item_id
            WHERE cr.campaign_id = ${campaignId}
            ORDER BY cr.queued_at DESC
            LIMIT ${limit}
          `);
      return r.rows;
    });
    res.json({ recipients: rows });
  } catch (err) { next(err); }
});
