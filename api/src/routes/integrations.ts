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

export { fetchShareRecord, renderShare };

