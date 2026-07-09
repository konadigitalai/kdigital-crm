// Domain events — single source of truth for things the rest of the system
// might care about: a lead being created, a case opened, a case closed.
// Currently fans out only to Slack via dispatchSlack(); future channels
// (email, SMS, internal webhooks) plug in here, not at every call site.
//
// The contract: emitEvent NEVER throws. The originating write path has
// already committed; a notification failure must not 500 the request.

import { dispatchSlack } from "./slack.js";

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
}
