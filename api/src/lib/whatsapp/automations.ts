/**
 * WhatsApp automations engine.
 *
 * Runs synchronously inside the webhook's setImmediate processing block
 * (so the 200 OK has already gone out), or inside emitEvent's fanout.
 * v1 actions are all in-process and fast (<2s for the slowest send_text);
 * if we ever add waits or HTTP calls we'll graduate to a job queue.
 *
 * Every fire writes a wa_automation_run row — completed/failed/skipped
 * — so the UI can show what happened without us having to log.
 *
 * Triggers:
 *   - inbound_message_keyword: { keyword?, regex?, caseSensitive? }
 *       Fires per inbound message; matches body/caption.
 *   - new_contact: { } (no config)
 *       Fires when a party was just created from an inbound webhook.
 *   - lead_created: { source? }
 *       Fires from emitEvent('lead.created'). Optional source filter.
 *
 * Actions are run in declared order. If one fails, the rest still try
 * (we capture the error in actions_log and mark the run 'failed' if any
 * action errored). This matches wacrm's behavior — partial runs are
 * useful (an add_tag still helps even if a send_template hit a rate
 * limit). The send_text path checks the 24h window first and skips
 * cleanly if outside.
 */

import { sql } from "drizzle-orm";
import type { DbExec } from "./inbox.js";
import { readMetaCreds, renderTemplateBody, sendTemplate, sendText, type MetaCreds } from "./meta.js";
import { recordOutbound } from "./inbox.js";

// ─── Types ────────────────────────────────────────────────────────────────

export type TriggerType = "inbound_message_keyword" | "new_contact" | "lead_created";
export type ActionType = "send_template" | "send_text" | "add_tag" | "assign_user" | "set_status";

export interface AutomationTrigger {
  type: TriggerType;
  config?: Record<string, unknown>;
}

export interface AutomationAction {
  type: ActionType;
  config: Record<string, unknown>;
}

export interface InboundMessageEvent {
  kind: "inbound_message";
  partyId: string;
  conversationId: string;
  body: string;          // text body or caption; empty for non-text
  inWindow: boolean;     // true since we just received an inbound
}

export interface NewContactEvent {
  kind: "new_contact";
  partyId: string;
  conversationId: string;
}

export interface LeadCreatedEvent {
  kind: "lead_created";
  partyId: string;
  conversationId: string | null;
  source: string | null;
  number: string | null;
}

export type AutomationEvent = InboundMessageEvent | NewContactEvent | LeadCreatedEvent;

// ─── Match: does this trigger fire on this event? ────────────────────────

function matches(trigger: AutomationTrigger, event: AutomationEvent): boolean {
  if (trigger.type === "inbound_message_keyword" && event.kind === "inbound_message") {
    const cfg = trigger.config ?? {};
    const keyword = typeof cfg.keyword === "string" ? cfg.keyword.trim() : "";
    const regex = typeof cfg.regex === "string" ? cfg.regex.trim() : "";
    const caseSensitive = !!cfg.caseSensitive;
    if (!keyword && !regex) return false;
    const body = caseSensitive ? event.body : event.body.toLowerCase();
    if (keyword) {
      const k = caseSensitive ? keyword : keyword.toLowerCase();
      return body.includes(k);
    }
    if (regex) {
      try {
        const re = new RegExp(regex, caseSensitive ? "" : "i");
        return re.test(event.body);
      } catch {
        return false;
      }
    }
    return false;
  }
  if (trigger.type === "new_contact" && event.kind === "new_contact") return true;
  if (trigger.type === "lead_created" && event.kind === "lead_created") {
    const wantSource = (trigger.config?.source as string | undefined)?.trim();
    if (!wantSource) return true;
    return (event.source ?? "").toLowerCase() === wantSource.toLowerCase();
  }
  return false;
}

// ─── Run: dispatch all matching automations for an event ────────────────

export async function runAutomations(db: DbExec, event: AutomationEvent): Promise<void> {
  const triggerType: TriggerType =
    event.kind === "inbound_message" ? "inbound_message_keyword"
    : event.kind === "new_contact"   ? "new_contact"
    : "lead_created";

  // Load enabled rules for this trigger type only.
  const r = await db.execute(sql`
    SELECT id, name, trigger, actions
    FROM wa_automation
    WHERE enabled = true AND trigger->>'type' = ${triggerType}
    ORDER BY created_at
  `);
  const rules = r.rows as Array<{
    id: string; name: string;
    trigger: AutomationTrigger;
    actions: AutomationAction[];
  }>;
  if (rules.length === 0) return;

  // Load creds + tag/user lookup tables once per event (cheap; cached only
  // for this run).
  const cfgR = await db.execute(sql`
    SELECT phone_number_id, waba_id, app_id, app_secret,
           system_user_token, webhook_verify_token, status
    FROM wa_config LIMIT 1
  `);
  const cfg = cfgR.rows[0] as Record<string, unknown> | undefined;
  const creds = readMetaCreds(cfg) ?? null;

  for (const rule of rules) {
    if (!matches(rule.trigger, event)) continue;

    const partyId = "partyId" in event ? event.partyId : null;
    const conversationId = "conversationId" in event ? event.conversationId : null;

    // Insert run row in 'running' state; we'll flip to completed/failed at the end.
    const runR = await db.execute(sql`
      INSERT INTO wa_automation_run (
        tenant_id, automation_id, party_id, conversation_id, status, context
      )
      VALUES (
        current_tenant(), ${rule.id}, ${partyId}, ${conversationId}, 'running',
        ${sql`${JSON.stringify(redactContext(event))}::jsonb`}
      )
      RETURNING id
    `);
    const runId = (runR.rows[0] as { id: string }).id;

    const actionsLog: Array<{ type: ActionType; ok: boolean; error?: string }> = [];
    let anyFailed = false;

    for (const action of rule.actions ?? []) {
      try {
        await applyAction(db, action, event, creds);
        actionsLog.push({ type: action.type, ok: true });
      } catch (err) {
        anyFailed = true;
        actionsLog.push({ type: action.type, ok: false, error: (err as Error).message });
        console.error(`[wa-automation] ${rule.name} action ${action.type} error:`, (err as Error).message);
      }
    }

    await db.execute(sql`
      UPDATE wa_automation_run
        SET status = ${anyFailed ? "failed" : "completed"},
            actions_log = ${sql`${JSON.stringify(actionsLog)}::jsonb`},
            completed_at = NOW()
        WHERE id = ${runId}
    `);
  }
}

// Strip noisy / large fields from the event before storing in context.
function redactContext(event: AutomationEvent): Record<string, unknown> {
  if (event.kind === "inbound_message") {
    return { kind: event.kind, partyId: event.partyId, conversationId: event.conversationId, body: event.body.slice(0, 240) };
  }
  return { ...event };
}

// ─── Actions ─────────────────────────────────────────────────────────────

async function applyAction(
  db: DbExec,
  action: AutomationAction,
  event: AutomationEvent,
  creds: MetaCreds | null,
): Promise<void> {
  const cfg = action.config ?? {};
  const partyId = "partyId" in event ? event.partyId : null;
  const conversationId = "conversationId" in event ? event.conversationId : null;

  switch (action.type) {
    case "add_tag": {
      const tagId = String(cfg.tagId ?? "").trim();
      if (!tagId || !partyId) throw new Error("add_tag needs tagId + partyId");
      await db.execute(sql`
        INSERT INTO wa_party_tag (tenant_id, party_id, tag_id)
        VALUES (current_tenant(), ${partyId}, ${tagId})
        ON CONFLICT (party_id, tag_id) DO NOTHING
      `);
      return;
    }

    case "assign_user": {
      const userId = cfg.userId ? String(cfg.userId) : null;
      if (!conversationId) throw new Error("assign_user needs a conversation");
      await db.execute(sql`
        UPDATE wa_conversation
          SET assigned_user_id = ${userId}, updated_at = NOW()
          WHERE id = ${conversationId}
      `);
      return;
    }

    case "set_status": {
      const status = String(cfg.status ?? "").trim();
      if (!conversationId) throw new Error("set_status needs a conversation");
      if (!["open", "pending", "closed"].includes(status)) throw new Error(`bad status: ${status}`);
      await db.execute(sql`
        UPDATE wa_conversation
          SET status = ${status}, updated_at = NOW()
          WHERE id = ${conversationId}
      `);
      return;
    }

    case "send_text": {
      if (!creds) throw new Error("WhatsApp not configured");
      if (!conversationId) throw new Error("send_text needs a conversation");
      const body = String(cfg.body ?? "").trim();
      if (!body) throw new Error("send_text needs body");

      // Confirm conversation is in 24h window before calling Meta — text
      // messages outside the window get rejected.
      const windowR = await db.execute(sql`
        SELECT last_inbound_at AS "lastInboundAt", party_id AS "partyId"
        FROM wa_conversation WHERE id = ${conversationId}
      `);
      const conv = windowR.rows[0] as { lastInboundAt: string | null; partyId: string } | undefined;
      if (!conv?.lastInboundAt) throw new Error("conversation outside 24h window (no inbound)");
      const ms = Date.now() - new Date(conv.lastInboundAt).getTime();
      if (ms >= 24 * 60 * 60 * 1000) throw new Error("conversation outside 24h window");

      const phoneR = await db.execute(sql`
        SELECT
          NULLIF(regexp_replace(COALESCE(phone_country_code, ''), '[^0-9]', '', 'g')
                 || regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), '') AS digits
        FROM party WHERE id = ${conv.partyId}
      `);
      const digits = (phoneR.rows[0] as { digits: string | null } | undefined)?.digits;
      if (!digits) throw new Error("party has no phone");
      const result = await sendText({ creds, to: `+${digits}`, body });
      await recordOutbound(db, {
        conversationId,
        senderUserId: null,
        contentType: "text",
        body,
        templateName: null,
        templateVariables: null,
        providerMessageId: result.ok ? (result.messageId ?? null) : null,
        status: result.ok ? "sent" : "failed",
        httpStatus: result.httpStatus,
        errorCode: result.ok ? null : (result.errorCode ?? null),
        errorMessage: result.ok ? null : (result.error ?? null),
      });
      if (!result.ok) throw new Error(result.error ?? "send_text failed");
      return;
    }

    case "send_template": {
      if (!creds) throw new Error("WhatsApp not configured");
      if (!conversationId) throw new Error("send_template needs a conversation");
      const templateId = String(cfg.templateId ?? "").trim();
      if (!templateId) throw new Error("send_template needs templateId");
      const variables = (cfg.variables ?? {}) as Record<string, string>;

      const tplR = await db.execute(sql`
        SELECT template_name AS "templateName", language, body_text AS "bodyText",
               variable_count AS "variableCount", status
        FROM wa_template WHERE id = ${templateId}
      `);
      const tpl = tplR.rows[0] as
        | { templateName: string; language: string; bodyText: string; variableCount: number; status: string }
        | undefined;
      if (!tpl) throw new Error("template not found");
      if (tpl.status !== "approved") throw new Error(`template not approved (${tpl.status})`);

      const partyR = await db.execute(sql`
        SELECT party_id AS "partyId" FROM wa_conversation WHERE id = ${conversationId}
      `);
      const partyIdRow = (partyR.rows[0] as { partyId: string } | undefined);
      if (!partyIdRow) throw new Error("conversation missing");
      const phoneR = await db.execute(sql`
        SELECT
          NULLIF(regexp_replace(COALESCE(phone_country_code, ''), '[^0-9]', '', 'g')
                 || regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), '') AS digits
        FROM party WHERE id = ${partyIdRow.partyId}
      `);
      const digits = (phoneR.rows[0] as { digits: string | null } | undefined)?.digits;
      if (!digits) throw new Error("party has no phone");

      const variableArr: string[] = [];
      for (let i = 1; i <= tpl.variableCount; i++) {
        const v = variables[String(i)];
        variableArr.push(typeof v === "string" ? v : "");
      }
      const rendered = renderTemplateBody(tpl.bodyText, variableArr);

      const result = await sendTemplate({
        creds,
        to: `+${digits}`,
        templateName: tpl.templateName,
        language: tpl.language,
        variables: variableArr,
      });
      await recordOutbound(db, {
        conversationId,
        senderUserId: null,
        contentType: "template",
        body: rendered,
        templateName: tpl.templateName,
        templateVariables: variableArr.length > 0
          ? Object.fromEntries(variableArr.map((v, i) => [String(i + 1), v]))
          : null,
        providerMessageId: result.ok ? (result.messageId ?? null) : null,
        status: result.ok ? "sent" : "failed",
        httpStatus: result.httpStatus,
        errorCode: result.ok ? null : (result.errorCode ?? null),
        errorMessage: result.ok ? null : (result.error ?? null),
      });
      if (!result.ok) throw new Error(result.error ?? "send_template failed");
      return;
    }

    default: {
      const _exhaustive: never = action.type;
      throw new Error(`unknown action: ${String(_exhaustive)}`);
    }
  }
}
