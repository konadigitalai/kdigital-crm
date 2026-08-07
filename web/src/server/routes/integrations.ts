// Integrations admin — Slack rule CRUD + manual test send + delivery log read.
//
// Reads: integrations.read · Writes: integrations.manage
// (Both gates applied via the `readWrite` helper at the index.ts mount.)

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { dispatchSlack, postToSlack } from "../lib/slack.js";
import {
  fetchShareRecord,
  isShareSurface,
  renderShare,
  SHARE_DEFAULT_KEYS,
  SHARE_FIELD_CATALOG,
  SHARE_SURFACES,
  type ShareSurface,
} from "../lib/share.js";
import type { DomainEvent, DomainEventType } from "../lib/events.js";

export const integrationsRouter = Router();

const EVENT_TYPES = ["lead.created", "case.opened", "case.closed"] as const;
type SlackEventType = (typeof EVENT_TYPES)[number];

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s);
const isSlackEvent = (s: string): s is SlackEventType =>
  (EVENT_TYPES as readonly string[]).includes(s);

// Accept the canonical incoming-webhook URL shape only. Slack flags leaked
// URLs and revokes them, so don't be too lax here.
const WEBHOOK_URL_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+$/;

function validateRuleInput(b: Record<string, unknown>, partial: boolean): { error?: string } {
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return { error: "name is required" };
    if (name.length > 80) return { error: "name too long (max 80)" };
  } else if (!partial) return { error: "name is required" };

  if (b.eventType !== undefined) {
    if (!isSlackEvent(String(b.eventType))) return { error: "unsupported eventType" };
  } else if (!partial) return { error: "eventType is required" };

  if (b.webhookUrl !== undefined) {
    const u = b.webhookUrl == null || b.webhookUrl === "" ? null : String(b.webhookUrl).trim();
    if (u !== null && !WEBHOOK_URL_RE.test(u)) {
      return { error: "webhookUrl must look like https://hooks.slack.com/services/T.../B.../..." };
    }
  } else if (!partial) return { error: "webhookUrl is required" };

  if (b.filter !== undefined && b.filter !== null && typeof b.filter !== "object") {
    return { error: "filter must be a JSON object" };
  }
  if (b.channel !== undefined && b.channel !== null && typeof b.channel !== "string") {
    return { error: "channel must be a string" };
  }
  if (b.template !== undefined && b.template !== null && typeof b.template !== "string") {
    return { error: "template must be a string" };
  }
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") {
    return { error: "enabled must be a boolean" };
  }
  return {};
}

// ─── GET /slack/rules ─────────────────────────────────────────────────────

integrationsRouter.get("/slack/rules", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          id, tenant_id AS "tenantId", name, event_type AS "eventType",
          enabled, filter, webhook_url AS "webhookUrl", channel, template,
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM slack_rule
        ORDER BY lower(name)
      `);
      return r.rows;
    });
    res.json({ rules: rows });
  } catch (err) { next(err); }
});

// ─── POST /slack/rules ────────────────────────────────────────────────────

integrationsRouter.post("/slack/rules", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const v = validateRuleInput(b, false);
    if (v.error) return res.status(400).json({ error: v.error });

    const created = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        INSERT INTO slack_rule (tenant_id, name, event_type, enabled, filter, webhook_url, channel, template)
        VALUES (
          current_tenant(),
          ${String(b.name).trim()},
          ${String(b.eventType)},
          ${b.enabled === undefined ? true : Boolean(b.enabled)},
          ${JSON.stringify(b.filter ?? {})}::jsonb,
          ${b.webhookUrl ? String(b.webhookUrl).trim() : null},
          ${b.channel ? String(b.channel).trim() : null},
          ${b.template ? String(b.template) : null}
        )
        RETURNING
          id, tenant_id AS "tenantId", name, event_type AS "eventType",
          enabled, filter, webhook_url AS "webhookUrl", channel, template,
          created_at AS "createdAt", updated_at AS "updatedAt"
      `);
      return r.rows[0];
    });
    res.status(201).json({ rule: created });
  } catch (err) { next(err); }
});

// ─── PATCH /slack/rules/:id ───────────────────────────────────────────────

integrationsRouter.patch("/slack/rules/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isUuid(id)) return res.status(400).json({ error: "invalid id" });
    const b = req.body ?? {};
    const v = validateRuleInput(b, true);
    if (v.error) return res.status(400).json({ error: v.error });

    const result = await withTenant(req.tenantId!, async (db) => {
      const exists = await db.execute(sql`SELECT 1 FROM slack_rule WHERE id = ${id}`);
      if (!exists.rows[0]) return { kind: "not-found" as const };

      const sets: ReturnType<typeof sql>[] = [];
      if (b.name !== undefined)       sets.push(sql`name = ${String(b.name).trim()}`);
      if (b.eventType !== undefined)  sets.push(sql`event_type = ${String(b.eventType)}`);
      if (b.enabled !== undefined)    sets.push(sql`enabled = ${Boolean(b.enabled)}`);
      if (b.filter !== undefined)     sets.push(sql`filter = ${JSON.stringify(b.filter ?? {})}::jsonb`);
      if (b.webhookUrl !== undefined) sets.push(sql`webhook_url = ${b.webhookUrl ? String(b.webhookUrl).trim() : null}`);
      if (b.channel !== undefined)    sets.push(sql`channel = ${b.channel ? String(b.channel).trim() : null}`);
      if (b.template !== undefined)   sets.push(sql`template = ${b.template ? String(b.template) : null}`);
      if (sets.length === 0) return { kind: "no-op" as const };

      const set = sql.join(sets, sql`, `);
      const r = await db.execute(sql`
        UPDATE slack_rule SET ${set} WHERE id = ${id}
        RETURNING
          id, tenant_id AS "tenantId", name, event_type AS "eventType",
          enabled, filter, webhook_url AS "webhookUrl", channel, template,
          created_at AS "createdAt", updated_at AS "updatedAt"
      `);
      return { kind: "ok" as const, rule: r.rows[0] };
    });

    if (result.kind === "not-found") return res.status(404).json({ error: "rule not found" });
    if (result.kind === "no-op")     return res.json({ ok: true, noop: true });
    res.json({ rule: result.rule });
  } catch (err) { next(err); }
});

// ─── DELETE /slack/rules/:id ──────────────────────────────────────────────

integrationsRouter.delete("/slack/rules/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isUuid(id)) return res.status(400).json({ error: "invalid id" });
    const removed = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`DELETE FROM slack_rule WHERE id = ${id} RETURNING id`);
      return r.rows[0];
    });
    if (!removed) return res.status(404).json({ error: "rule not found" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── POST /slack/rules/:id/test ───────────────────────────────────────────
//
// Synthesize a representative event for the rule's eventType and dispatch
// it. We only run the dispatcher (not a direct fetch) so the same filter +
// template path runs that real events take, and the delivery log gets a row.

integrationsRouter.post("/slack/rules/:id/test", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isUuid(id)) return res.status(400).json({ error: "invalid id" });

    const rule = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT id, event_type AS "eventType", enabled
        FROM slack_rule WHERE id = ${id}
      `);
      return r.rows[0] as { id: string; eventType: string; enabled: boolean } | undefined;
    });
    if (!rule) return res.status(404).json({ error: "rule not found" });
    if (!isSlackEvent(rule.eventType)) {
      return res.status(409).json({ error: "rule event_type is not supported" });
    }

    // Build a synthesized event matching the type's canonical payload.
    const evt = synthEvent(rule.eventType, req.tenantId!);
    await dispatchSlack(evt);

    // Read back the most-recent delivery row for this rule so the UI can
    // surface what just happened.
    const last = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT id, status, http_status AS "httpStatus", response, sent_at AS "sentAt"
        FROM slack_delivery_log
        WHERE rule_id = ${id}
        ORDER BY sent_at DESC
        LIMIT 1
      `);
      return r.rows[0];
    });

    res.json({ ok: true, lastDelivery: last ?? null });
  } catch (err) { next(err); }
});

// ─── GET /slack/deliveries ────────────────────────────────────────────────

integrationsRouter.get("/slack/deliveries", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          id, rule_id AS "ruleId", event_type AS "eventType",
          status, http_status AS "httpStatus", response, context,
          sent_at AS "sentAt"
        FROM slack_delivery_log
        ORDER BY sent_at DESC
        LIMIT ${limit}
      `);
      return r.rows;
    });
    res.json({ deliveries: rows });
  } catch (err) { next(err); }
});

// ─── helpers ──────────────────────────────────────────────────────────────

function synthEvent(type: DomainEventType, tenantId: string): DomainEvent {
  const occurredAt = new Date().toISOString();
  if (type === "lead.created") {
    return {
      type, tenantId, occurredAt,
      context: {
        leadId: "00000000-0000-0000-0000-000000000000",
        number: "LEAD-TEST",
        name: "Test Lead",
        email: "test@example.com",
        phone: null,
        city: "Hyderabad",
        program: "Data Engineering",
        source: "web",
        sourceLabel: "Website form",
        advisorName: "You (test send)",
        stage: "new",
        score: 75,
        heat: "hot",
        rating: "new lead",
      },
    };
  }
  if (type === "case.opened") {
    return {
      type, tenantId, occurredAt,
      context: {
        caseId: "00000000-0000-0000-0000-000000000000",
        number: "CSE-TEST",
        subject: "Test case from admin → integrations",
        category: "billing",
        priority: 3,
        requesterName: "Test Requester",
        requesterEmail: "test@example.com",
        requesterKind: "external",
        assigneeName: null,
      },
    };
  }
  return {
    type, tenantId, occurredAt,
    context: {
      caseId: "00000000-0000-0000-0000-000000000000",
      number: "CSE-TEST",
      subject: "Test case (closed)",
      resolution: "Resolved by test send.",
      resolutionCode: "fixed",
      closedByName: "You (test send)",
    },
  };
}

// ─── Share-target admin (gated by integrations.read / .manage) ───────────

// GET /slack/share-targets — return one entry per surface, falling back to
// a "not configured" placeholder when the admin hasn't set one up yet. Also
// returns the per-surface field catalog so the admin UI can render the
// checkbox grid.
integrationsRouter.get("/slack/share-targets", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          id, surface, enabled, channel,
          webhook_url AS "webhookUrl",
          field_keys  AS "fieldKeys",
          header_template AS "headerTemplate",
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM slack_share_target
      `);
      return r.rows;
    });
    const bySurface = new Map<string, Record<string, unknown>>();
    for (const row of rows) bySurface.set(row.surface as string, row);

    const targets = SHARE_SURFACES.map((surface) => {
      const existing = bySurface.get(surface);
      if (existing) return existing;
      return {
        id: null, surface,
        enabled: false, channel: null, webhookUrl: null,
        fieldKeys: SHARE_DEFAULT_KEYS[surface], headerTemplate: null,
        createdAt: null, updatedAt: null,
      };
    });

    // Per-surface field catalog — the admin UI checkboxes are built from this.
    const fields: Record<string, { key: string; label: string }[]> = {};
    for (const surface of SHARE_SURFACES) {
      fields[surface] = SHARE_FIELD_CATALOG[surface].map((f) => ({ key: f.key, label: f.label }));
    }

    res.json({ targets, fields });
  } catch (err) { next(err); }
});

// POST /slack/share-targets — upsert. Body shape:
//   { surface, enabled, webhookUrl, channel, fieldKeys, headerTemplate }
// Surface determines the row to update (one per tenant + surface).
integrationsRouter.post("/slack/share-targets", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const surface = String(b.surface ?? "");
    if (!isShareSurface(surface)) {
      return res.status(400).json({ error: "unsupported surface" });
    }
    const webhookUrl = b.webhookUrl == null || b.webhookUrl === "" ? null : String(b.webhookUrl).trim();
    if (webhookUrl !== null && !WEBHOOK_URL_RE.test(webhookUrl)) {
      return res.status(400).json({ error: "webhookUrl must look like https://hooks.slack.com/services/T.../B.../..." });
    }
    if (b.channel !== undefined && b.channel !== null && typeof b.channel !== "string") {
      return res.status(400).json({ error: "channel must be a string" });
    }
    if (b.headerTemplate !== undefined && b.headerTemplate !== null && typeof b.headerTemplate !== "string") {
      return res.status(400).json({ error: "headerTemplate must be a string" });
    }
    const fieldKeys = Array.isArray(b.fieldKeys)
      ? b.fieldKeys.filter((k: unknown): k is string => typeof k === "string")
      : SHARE_DEFAULT_KEYS[surface];
    // Reject unknown field keys early so admins don't save dead config.
    const validKeys = new Set(SHARE_FIELD_CATALOG[surface].map((f) => f.key));
    const bad = fieldKeys.filter((k: string) => !validKeys.has(k));
    if (bad.length > 0) {
      return res.status(400).json({ error: `unknown fieldKeys for ${surface}: ${bad.join(", ")}` });
    }
    const enabled = b.enabled === undefined ? true : Boolean(b.enabled);

    const fieldsLiteral = sqlTextArray(fieldKeys);

    const created = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        INSERT INTO slack_share_target (tenant_id, surface, enabled, channel, webhook_url, field_keys, header_template)
        VALUES (
          current_tenant(), ${surface}, ${enabled},
          ${b.channel ? String(b.channel).trim() : null},
          ${webhookUrl},
          ${fieldsLiteral},
          ${b.headerTemplate ? String(b.headerTemplate) : null}
        )
        ON CONFLICT (tenant_id, surface) DO UPDATE
        SET enabled = EXCLUDED.enabled,
            channel = EXCLUDED.channel,
            webhook_url = EXCLUDED.webhook_url,
            field_keys = EXCLUDED.field_keys,
            header_template = EXCLUDED.header_template
        RETURNING
          id, surface, enabled, channel,
          webhook_url AS "webhookUrl",
          field_keys  AS "fieldKeys",
          header_template AS "headerTemplate",
          created_at AS "createdAt", updated_at AS "updatedAt"
      `);
      return r.rows[0];
    });

    res.json({ target: created });
  } catch (err) { next(err); }
});

// DELETE /slack/share-targets/:surface — clear the row.
integrationsRouter.delete("/slack/share-targets/:surface", async (req, res, next) => {
  try {
    const surface = String(req.params.surface ?? "");
    if (!isShareSurface(surface)) return res.status(400).json({ error: "unsupported surface" });
    await withTenant(req.tenantId!, async (db) => {
      await db.execute(sql`DELETE FROM slack_share_target WHERE surface = ${surface}`);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Bot token + workspace + directory (bot-based dynamic sharing) ───────
//
// The old model was one webhook per channel, pre-configured by an admin.
// The new model lets an operator pick a channel or a user at share time,
// from a cached directory. That requires a workspace bot token + the
// scopes channels:read, groups:read, users:read, chat:write, im:write.
//
// Admin flow:
//   POST /integrations/slack/workspace     ← paste bot token
//   POST /integrations/slack/workspace/test  ← verify (auth.test)
//   POST /integrations/slack/directory/refresh  ← pull channels + users into cache
//   GET  /integrations/slack/directory?kind=channel|user  ← for the share dialog

integrationsRouter.get("/slack/workspace", async (req, res, next) => {
  try {
    const row = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT id,
               team_id     AS "teamId",
               team_name   AS "teamName",
               (bot_token IS NOT NULL) AS "hasToken",
               installed_at AS "installedAt"
        FROM slack_workspace
        LIMIT 1
      `);
      return r.rows[0] ?? null;
    });
    res.json({ workspace: row });
  } catch (err) { next(err); }
});

// POST /integrations/slack/workspace — paste the xoxb-… bot token.
// Body: { botToken: string }
integrationsRouter.post("/slack/workspace", async (req, res, next) => {
  try {
    const raw = (req.body?.botToken ?? "").toString().trim();
    if (!raw) return res.status(400).json({ error: "botToken is required" });
    // Slack bot tokens start with xoxb-. Reject anything else to catch typos
    // early — a paste of a webhook URL, xapp- or xoxp- token would 401 later.
    if (!/^xoxb-/.test(raw)) {
      return res.status(400).json({ error: "botToken must start with xoxb- (Bot User OAuth Token)" });
    }
    // Verify it live before persisting.
    const { authTest } = await import("../lib/slack-api.js");
    let info;
    try { info = await authTest(raw); }
    catch (err) {
      return res.status(400).json({ error: `Token rejected by Slack: ${(err as Error).message}` });
    }
    await withTenant(req.tenantId!, async (db) => {
      // UPSERT — one workspace row per tenant.
      await db.execute(sql`
        INSERT INTO slack_workspace (tenant_id, team_id, team_name, bot_token, installed_at)
        VALUES (current_tenant(), ${info.team_id}, ${info.team}, ${raw}, NOW())
        ON CONFLICT (tenant_id) DO UPDATE
          SET team_id      = EXCLUDED.team_id,
              team_name    = EXCLUDED.team_name,
              bot_token    = EXCLUDED.bot_token,
              installed_at = NOW(),
              updated_at   = NOW()
      `);
    });
    res.json({ ok: true, teamName: info.team, teamId: info.team_id, botUser: info.user });
  } catch (err) { next(err); }
});

integrationsRouter.post("/slack/workspace/test", async (req, res, next) => {
  try {
    const token = await loadBotToken(req.tenantId!);
    if (!token) return res.status(409).json({ error: "No bot token configured" });
    const { authTest } = await import("../lib/slack-api.js");
    try {
      const info = await authTest(token);
      res.json({ ok: true, teamName: info.team, teamId: info.team_id, botUser: info.user, url: info.url });
    } catch (err) {
      return res.status(400).json({ ok: false, error: (err as Error).message });
    }
  } catch (err) { next(err); }
});

// POST /integrations/slack/directory/refresh — hit Slack, upsert into
// slack_channel_cache + slack_user_cache. Returns counts.
integrationsRouter.post("/slack/directory/refresh", async (req, res, next) => {
  try {
    const token = await loadBotToken(req.tenantId!);
    if (!token) return res.status(409).json({ error: "No bot token configured" });
    const { listAllChannels, listAllUsers } = await import("../lib/slack-api.js");
    const [channels, users] = await Promise.all([
      listAllChannels(token),
      listAllUsers(token),
    ]);
    await withTenant(req.tenantId!, async (db) => {
      // Channels — upsert on (tenant_id, slack_id).
      for (const c of channels) {
        await db.execute(sql`
          INSERT INTO slack_channel_cache (tenant_id, slack_id, name, is_private, is_archived, is_member, topic, synced_at)
          VALUES (current_tenant(), ${c.id}, ${c.name}, ${c.is_private ?? false}, ${c.is_archived ?? false}, ${c.is_member ?? false}, ${c.topic?.value ?? null}, NOW())
          ON CONFLICT (tenant_id, slack_id) DO UPDATE
            SET name        = EXCLUDED.name,
                is_private  = EXCLUDED.is_private,
                is_archived = EXCLUDED.is_archived,
                is_member   = EXCLUDED.is_member,
                topic       = EXCLUDED.topic,
                synced_at   = NOW(),
                updated_at  = NOW()
        `);
      }
      // Users — same treatment.
      for (const u of users) {
        await db.execute(sql`
          INSERT INTO slack_user_cache (tenant_id, slack_id, name, real_name, display_name, email, is_bot, is_deleted, image_url, synced_at)
          VALUES (current_tenant(), ${u.id}, ${u.name},
                  ${u.profile?.real_name ?? u.real_name ?? null},
                  ${u.profile?.display_name ?? null},
                  ${u.profile?.email ?? null},
                  ${u.is_bot ?? false}, ${u.deleted ?? false},
                  ${u.profile?.image_72 ?? u.profile?.image_192 ?? null},
                  NOW())
          ON CONFLICT (tenant_id, slack_id) DO UPDATE
            SET name         = EXCLUDED.name,
                real_name    = EXCLUDED.real_name,
                display_name = EXCLUDED.display_name,
                email        = EXCLUDED.email,
                is_bot       = EXCLUDED.is_bot,
                is_deleted   = EXCLUDED.is_deleted,
                image_url    = EXCLUDED.image_url,
                synced_at    = NOW(),
                updated_at   = NOW()
        `);
      }
    });
    res.json({ ok: true, channelCount: channels.length, userCount: users.length });
  } catch (err) { next(err); }
});

// GET /integrations/slack/directory?kind=channel|user
integrationsRouter.get("/slack/directory", async (req, res, next) => {
  try {
    const kind = String(req.query.kind ?? "channel");
    if (kind !== "channel" && kind !== "user") {
      return res.status(400).json({ error: "kind must be channel or user" });
    }
    const rows = await withTenant(req.tenantId!, async (db) => {
      if (kind === "channel") {
        const r = await db.execute(sql`
          SELECT slack_id AS id, name, is_private AS "isPrivate",
                 is_member AS "isMember", topic
          FROM slack_channel_cache
          WHERE is_archived = false
          ORDER BY is_member DESC, name
        `);
        return r.rows;
      }
      const r = await db.execute(sql`
        SELECT slack_id AS id, name,
               COALESCE(display_name, real_name, name) AS "label",
               real_name AS "realName", email, image_url AS "imageUrl"
        FROM slack_user_cache
        WHERE is_deleted = false AND is_bot = false
        ORDER BY COALESCE(display_name, real_name, name)
      `);
      return r.rows;
    });
    res.json({ kind, items: rows });
  } catch (err) { next(err); }
});

// Helper — pull the bot token for the current tenant (or null).
export async function loadBotToken(tenantId: string): Promise<string | null> {
  return withTenant(tenantId, async (db) => {
    const r = await db.execute(sql`
      SELECT bot_token FROM slack_workspace LIMIT 1
    `);
    const row = r.rows[0] as { bot_token: string | null } | undefined;
    return row?.bot_token ?? null;
  });
}

// Helper — pull the CURRENT USER's Slack user token (or null). This is
// the xoxp-… token issued when they clicked "Connect Slack".
export async function loadUserToken(
  tenantId: string,
  appUserId: string,
): Promise<{ token: string; slackUserId: string; slackTeamId: string | null } | null> {
  return withTenant(tenantId, async (db) => {
    const r = await db.execute(sql`
      SELECT user_token AS "token", slack_user_id AS "slackUserId", slack_team_id AS "slackTeamId"
      FROM slack_user_link
      WHERE app_user_id = ${appUserId} AND revoked_at IS NULL
      LIMIT 1
    `);
    return (r.rows[0] as { token: string; slackUserId: string; slackTeamId: string | null } | undefined) ?? null;
  });
}

// ─── Per-CRM-user Slack link — status + directory ──────────────────────
//
// "My" endpoints — scoped to the currently-authenticated app user.
// Returns their Slack connection status and, if connected, the channels
// they personally are members of.

integrationsRouter.get("/slack/my-status", async (req, res, next) => {
  try {
    if (!req.userId) return res.status(401).json({ error: "not authenticated" });
    const link = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT slack_user_id AS "slackUserId",
               slack_team_id AS "slackTeamId",
               connected_at  AS "connectedAt",
               scopes
        FROM slack_user_link
        WHERE app_user_id = ${req.userId} AND revoked_at IS NULL
        LIMIT 1
      `);
      return r.rows[0] ?? null;
    });
    if (!link) return res.json({ connected: false });
    res.json({ connected: true, link });
  } catch (err) { next(err); }
});

// GET /integrations/slack/my-directory?kind=channel|user
//
// channel  → channels the CURRENT USER is in (via THEIR xoxp- token).
//            No caching — memberships change too often, and it's a
//            single API call per share.
// user     → workspace users. We don't need a per-user view for this,
//            so it falls through to the bot-cached list.
integrationsRouter.get("/slack/my-directory", async (req, res, next) => {
  try {
    if (!req.userId) return res.status(401).json({ error: "not authenticated" });
    const kind = String(req.query.kind ?? "channel");
    if (kind !== "channel" && kind !== "user") {
      return res.status(400).json({ error: "kind must be channel or user" });
    }

    if (kind === "user") {
      // Delegate to the bot-cached list — same shape.
      const rows = await withTenant(req.tenantId!, async (db) => {
        const r = await db.execute(sql`
          SELECT slack_id AS id, name,
                 COALESCE(display_name, real_name, name) AS "label",
                 real_name AS "realName", email, image_url AS "imageUrl"
          FROM slack_user_cache
          WHERE is_deleted = false AND is_bot = false
          ORDER BY COALESCE(display_name, real_name, name)
        `);
        return r.rows;
      });
      return res.json({ kind, items: rows });
    }

    // Channels — hit Slack live with the user token, filter is_member.
    const link = await loadUserToken(req.tenantId!, req.userId);
    if (!link) return res.status(409).json({ error: "Slack not connected. Click Connect Slack first." });

    const { listAllChannels } = await import("../lib/slack-api.js");
    let channels;
    try { channels = await listAllChannels(link.token); }
    catch (err) {
      return res.status(502).json({ error: `Slack list_channels failed: ${(err as Error).message}` });
    }
    // For the user-token view we ONLY show channels the user is a
    // member of. That's the whole point of this endpoint.
    const items = channels
      .filter((c) => c.is_member && !c.is_archived)
      .map((c) => ({
        id: c.id, name: c.name,
        isPrivate: !!c.is_private,
        isMember: true,
        topic: c.topic?.value ?? null,
      }));
    res.json({ kind, items });
  } catch (err) { next(err); }
});

// Render literal `ARRAY[$1,$2,...]::text[]` so drizzle binds each element.
// (Mirrors the columnsSqlValue helper in views.ts.)
function sqlTextArray(values: string[]) {
  if (!values || values.length === 0) return sql`'{}'::text[]`;
  const parts = values.map((v) => sql`${v}`);
  return sql`ARRAY[${sql.join(parts, sql`, `)}]::text[]`;
}

// Helpers for the user-facing share router below.
export async function loadShareTarget(tenantId: string, surface: ShareSurface) {
  return withTenant(tenantId, async (db) => {
    const r = await db.execute(sql`
      SELECT
        id, surface, enabled, channel,
        webhook_url AS "webhookUrl",
        field_keys  AS "fieldKeys",
        header_template AS "headerTemplate"
      FROM slack_share_target
      WHERE surface = ${surface}
    `);
    return r.rows[0] as
      | { id: string; surface: string; enabled: boolean; channel: string | null;
          webhookUrl: string | null; fieldKeys: string[]; headerTemplate: string | null }
      | undefined;
  });
}

// ─── Interakt (WhatsApp) config ───────────────────────────────────────────
// The Secret Key is stored server-side only. GET returns a masked view + status;
// PUT upserts the key/enabled flag. Gated by integrations.read / .manage.

function maskKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

integrationsRouter.get("/interakt", async (req, res, next) => {
  try {
    const row = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT api_key AS "apiKey", enabled, last_sync_at AS "lastSyncAt"
        FROM interakt_account LIMIT 1
      `);
      return r.rows[0] as { apiKey: string | null; enabled: boolean; lastSyncAt: string | null } | undefined;
    });
    res.json({
      configured: !!row?.apiKey,
      enabled: row?.enabled ?? true,
      keyMasked: maskKey(row?.apiKey ?? null),
      lastSyncAt: row?.lastSyncAt ?? null,
    });
  } catch (err) {
    next(err);
  }
});

integrationsRouter.put("/interakt", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    // apiKey: undefined = leave unchanged; "" / null = clear; string = set.
    const hasKey = b.apiKey !== undefined;
    const apiKey = hasKey ? (b.apiKey ? String(b.apiKey).trim() : null) : undefined;
    const enabled = b.enabled !== undefined ? Boolean(b.enabled) : undefined;

    await withTenant(req.tenantId!, async (db) => {
      const existing = await db.execute(sql`SELECT id FROM interakt_account LIMIT 1`);
      if (existing.rows[0]) {
        const sets: ReturnType<typeof sql>[] = [];
        if (apiKey !== undefined) sets.push(sql`api_key = ${apiKey}`);
        if (enabled !== undefined) sets.push(sql`enabled = ${enabled}`);
        if (sets.length === 0) return;
        sets.push(sql`updated_at = now()`);
        await db.execute(sql`UPDATE interakt_account SET ${sql.join(sets, sql`, `)}`);
      } else {
        await db.execute(sql`
          INSERT INTO interakt_account (tenant_id, api_key, enabled)
          VALUES (current_tenant(), ${apiKey ?? null}, ${enabled ?? true})
        `);
      }
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export { fetchShareRecord, renderShare };

