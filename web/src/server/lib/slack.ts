// Slack dispatcher — load matching rules for an event, evaluate filters,
// render a Block Kit message, POST to the rule's incoming webhook URL,
// and write a delivery log row. NEVER throws — the caller (emitEvent) has
// already committed the originating DB write.
//
// v1 uses incoming webhook URLs (one per rule, paste-from-Slack-app-config).
// v2 will read a per-tenant bot token from `slack_workspace` and call
// chat.postMessage by channel name; the rule shape is forward-compatible
// (channel column already there).

import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";
import type { DomainEvent } from "./events";

interface SlackRuleRow {
  id: string;
  name: string;
  eventType: string;
  filter: Record<string, unknown>;
  webhookUrl: string | null;
  template: string | null;
}

// Block Kit has many variants (header, section, divider, context, actions,
// button…). We accept the full union loosely — the API trusts our own
// builder helpers to emit valid shapes, and the "Block Kit Validator" is
// run by Slack on receipt anyway.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SlackBlock = Record<string, any>;

export interface SlackPayload {
  text: string;
  blocks: SlackBlock[];
}

// ─── Filter evaluation ────────────────────────────────────────────────────
//
// Rule.filter is a small JSON object. v1 supports three primitives:
//   { "source": "referral" }              → equality
//   { "source": ["referral","webinar"] }  → array membership
//   { "priority_lte": 2 }                 → priority ≤ 2 (numeric)
//
// The key (sans `_lte`) must exist in the event payload to be evaluable;
// missing keys → rule does NOT match (fail-closed).
function ruleMatches(filter: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const [k, want] of Object.entries(filter)) {
    if (k.endsWith("_lte")) {
      const baseKey = k.slice(0, -"_lte".length);
      const actual = Number(payload[baseKey]);
      if (Number.isNaN(actual)) return false;
      if (!(actual <= Number(want))) return false;
      continue;
    }
    const actual = payload[k];
    if (Array.isArray(want)) {
      if (!want.includes(actual as string | number)) return false;
    } else {
      if (actual !== want) return false;
    }
  }
  return true;
}

// ─── Template rendering ───────────────────────────────────────────────────
//
// Default templates live here; admins can override with rule.template.
// Substitution uses {{var}} syntax against the flat event payload —
// e.g. {{name}}, {{number}}, {{program}}.
function substitute(template: string, payload: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = payload[key];
    if (v == null) return "—";
    return String(v);
  });
}

// Public web app base URL. Used to build deep-links from Slack messages
// back to the relevant CRM record. Falls back to localhost for dev.
function appBaseUrl(): string {
  return (process.env.WEB_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

// Where in the web app should this event's "View in CRM" button land?
// Lead → /records/LEAD-1234, case → /cases/CSE-1234.
function recordUrlFor(e: DomainEvent): string | null {
  const p = e.context as unknown as Record<string, unknown>;
  const base = appBaseUrl();
  if (e.type === "lead.created") {
    const num = p.number ? String(p.number) : null;
    return num ? `${base}/records/${encodeURIComponent(num)}` : null;
  }
  if (e.type === "case.opened" || e.type === "case.closed") {
    const num = p.number ? String(p.number) : null;
    return num ? `${base}/cases/${encodeURIComponent(num)}` : null;
  }
  return null;
}

// Slack "actions" block with a single link button. Renders as a clickable
// button inside the message — no auth dance, just opens the URL.
function viewInCrmButton(e: DomainEvent, label = "View in CRM"): SlackBlock | null {
  const url = recordUrlFor(e);
  if (!url) return null;
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: label },
        url,
        style: "primary",
        action_id: "view_in_crm",
      },
    ],
  };
}

// Small grey caption row at the bottom — adds a markdown link as a backup
// for clients that don't render buttons (rare, but cheap to include).
function recordContextBlock(e: DomainEvent): SlackBlock | null {
  const url = recordUrlFor(e);
  const p = e.context as unknown as Record<string, unknown>;
  if (!url || !p.number) return null;
  return {
    type: "context",
    elements: [
      { type: "mrkdwn", text: `<${url}|Open ${p.number} in CRM>` },
    ],
  };
}

function defaultBlocksFor(e: DomainEvent): SlackPayload {
  const p = e.context as unknown as Record<string, unknown>;
  const button = viewInCrmButton(e);
  const ctx = recordContextBlock(e);

  if (e.type === "lead.created") {
    const text = `🎯 New lead — ${p.number ?? ""}: ${p.name ?? ""}`;
    return {
      text,
      blocks: [
        { type: "header", text: { type: "plain_text", text } },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Name*\n${p.name ?? "—"}` },
            { type: "mrkdwn", text: `*Phone*\n${p.phone ?? "—"}` },
            { type: "mrkdwn", text: `*Email*\n${p.email ?? "—"}` },
            { type: "mrkdwn", text: `*Course*\n${p.program ?? "—"}` },
            { type: "mrkdwn", text: `*Source*\n${p.sourceLabel ?? p.source ?? "—"}` },
          ],
        },
        ...(button ? [button] : []),
        ...(ctx ? [ctx] : []),
      ],
    };
  }
  if (e.type === "case.opened") {
    const text = `🆘 Case opened — ${p.number ?? ""}: ${p.subject ?? ""}`;
    return {
      text,
      blocks: [
        { type: "header", text: { type: "plain_text", text } },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Subject*\n${p.subject ?? "—"}` },
            { type: "mrkdwn", text: `*Category*\n${p.category ?? "—"}` },
            { type: "mrkdwn", text: `*Priority*\n${p.priority ?? "—"}` },
            { type: "mrkdwn", text: `*Requester*\n${p.requesterName ?? "—"}` },
            { type: "mrkdwn", text: `*Assignee*\n${p.assigneeName ?? "unassigned"}` },
          ],
        },
        ...(button ? [button] : []),
        ...(ctx ? [ctx] : []),
      ],
    };
  }
  if (e.type === "case.closed") {
    const text = `✅ Case closed — ${p.number ?? ""}: ${p.subject ?? ""}`;
    return {
      text,
      blocks: [
        { type: "header", text: { type: "plain_text", text } },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Subject*\n${p.subject ?? "—"}` },
            { type: "mrkdwn", text: `*Resolution*\n${p.resolution ?? "—"}` },
            { type: "mrkdwn", text: `*Code*\n${p.resolutionCode ?? "—"}` },
            { type: "mrkdwn", text: `*Closed by*\n${p.closedByName ?? "—"}` },
          ],
        },
        ...(button ? [button] : []),
        ...(ctx ? [ctx] : []),
      ],
    };
  }
  return { text: `Event: ${e.type}`, blocks: [] };
}

export function renderTemplate(template: string | null, e: DomainEvent): SlackPayload {
  if (!template || !template.trim()) return defaultBlocksFor(e);
  const text = substitute(template, e.context as unknown as Record<string, unknown>);
  const button = viewInCrmButton(e);
  const ctx = recordContextBlock(e);
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      ...(button ? [button] : []),
      ...(ctx ? [ctx] : []),
    ],
  };
}

// ─── Webhook delivery ─────────────────────────────────────────────────────
//
// Slack's incoming-webhook endpoint returns 200 with body "ok" on success
// and a non-200 with a short error body on failure. We capture both.
export async function postToSlack(
  url: string,
  payload: SlackPayload,
): Promise<{ httpStatus: number; ok: boolean; response: string }> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const body = await r.text().catch(() => "");
    return {
      httpStatus: r.status,
      ok: r.ok && body.startsWith("ok"),
      response: body.slice(0, 1000),
    };
  } catch (err) {
    return { httpStatus: 0, ok: false, response: (err as Error).message.slice(0, 1000) };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Public — dispatchSlack ───────────────────────────────────────────────

export async function dispatchSlack(e: DomainEvent): Promise<void> {
  // Look up enabled rules for this (tenant, eventType) and log every send.
  // We do all of this inside one withTenant() so RLS scopes correctly and
  // the log writes succeed even if the network call hangs/fails.
  try {
    await withTenant(e.tenantId, async (db) => {
      const rulesR = await db.execute(sql`
        SELECT id, name, event_type AS "eventType", filter,
               webhook_url AS "webhookUrl", template
        FROM slack_rule
        WHERE event_type = ${e.type} AND enabled = true
      `);
      const rules = rulesR.rows as unknown as SlackRuleRow[];
      const payload = e.context as unknown as Record<string, unknown>;

      for (const rule of rules) {
        if (!rule.webhookUrl) {
          await logDelivery(db, e, rule.id, "error", null, "rule has no webhook_url");
          continue;
        }
        if (!ruleMatches(rule.filter ?? {}, payload)) continue;

        const body = renderTemplate(rule.template, e);
        const r = await postToSlack(rule.webhookUrl, body);
        await logDelivery(
          db,
          e,
          rule.id,
          r.ok ? "ok" : "error",
          r.httpStatus,
          r.response,
        );
      }
    });
  } catch (err) {
    console.error("[slack] dispatch error (swallowed):", (err as Error).message);
  }
}

async function logDelivery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  e: DomainEvent,
  ruleId: string | null,
  status: "ok" | "error",
  httpStatus: number | null,
  response: string | null,
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO slack_delivery_log (tenant_id, rule_id, event_type, status, http_status, response, context)
      VALUES (
        current_tenant(), ${ruleId}, ${e.type}, ${status},
        ${httpStatus}, ${response},
        ${JSON.stringify(e.context)}::jsonb
      )
    `);
  } catch (err) {
    // Last-resort log — we don't want a logging failure to bubble.
    console.error("[slack] failed to write delivery log:", (err as Error).message);
  }
}
