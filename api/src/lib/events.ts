// Domain events — single source of truth for things the rest of the system
// might care about: a lead being created, a case opened, a case closed.
// Currently fans out only to Slack via dispatchSlack(); future channels
// (email, SMS, internal webhooks) plug in here, not at every call site.
//
// The contract: emitEvent NEVER throws. The originating write path has
// already committed; a notification failure must not 500 the request.

import { sql } from "drizzle-orm";
import { dispatchSlack } from "./slack.js";
import { withTenant } from "../db/app.js";
import { runAutomations } from "./whatsapp/automations.js";

export type DomainEventType = "lead.created" | "case.opened" | "case.closed";

export interface LeadCreatedContext {
  leadId: string;
  number: string;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  program: string | null;
  source: string;
  sourceLabel: string;
  advisorName: string | null;
  stage: string;
  score: number;
  heat: string;
  rating: string;
}

export interface CaseOpenedContext {
  caseId: string;
  number: string;
  subject: string;
  category: string;
  priority: number;
  requesterName: string;
  requesterEmail: string;
  requesterKind: string;
  assigneeName: string | null;
}

export interface CaseClosedContext {
  caseId: string;
  number: string;
  subject: string;
  resolution: string;
  resolutionCode: string;
  closedByName: string | null;
}

export type DomainEventContext =
  | { type: "lead.created"; payload: LeadCreatedContext }
  | { type: "case.opened";  payload: CaseOpenedContext }
  | { type: "case.closed";  payload: CaseClosedContext };

export interface DomainEvent {
  type: DomainEventType;
  tenantId: string;
  occurredAt: string;
  context: LeadCreatedContext | CaseOpenedContext | CaseClosedContext;
}

export async function emitEvent(e: DomainEvent): Promise<void> {
  try {
    await dispatchSlack(e);
  } catch (err) {
    // dispatchSlack should never throw — if it did, swallow it here so
    // the originating request returns its happy-path response.
    console.error("[events] dispatch failure (swallowed):", (err as Error).message);
  }

  // Fan out to WhatsApp automations. Same swallow-errors contract.
  try {
    await dispatchWhatsAppAutomations(e);
  } catch (err) {
    console.error("[events] wa-automation dispatch failure (swallowed):", (err as Error).message);
  }
}

async function dispatchWhatsAppAutomations(e: DomainEvent): Promise<void> {
  if (e.type !== "lead.created") return;  // v1 only handles lead.created
  const ctx = e.context as LeadCreatedContext;

  await withTenant(e.tenantId, async (db) => {
    // Look up the party + WhatsApp conversation for this lead. `lead` has no
    // party_id column — the party lives on `work_item`, and `lead.work_item_id`
    // is the FK. `ctx.leadId` is the work_item.id (see routes/leads.ts).
    const r = await db.execute(sql`
      SELECT wi.party_id AS "partyId", c.id AS "conversationId"
      FROM lead l
      JOIN work_item wi ON wi.id = l.work_item_id
      LEFT JOIN wa_conversation c ON c.party_id = wi.party_id
      WHERE l.work_item_id = ${ctx.leadId}
    `);
    const row = r.rows[0] as { partyId: string | null; conversationId: string | null } | undefined;
    if (!row?.partyId) return;

    await runAutomations(db, {
      kind: "lead_created",
      partyId: row.partyId,
      conversationId: row.conversationId,
      source: ctx.source,
      number: ctx.number,
    });
  });
}
