// Interakt (WhatsApp) sync — pushes a lead's details to Interakt as a user
// (contact) with custom traits, via the Track Users API. Same endpoint creates
// or updates: Interakt matches on userId (we use the lead number) / phone, and
// new trait values overwrite old ones.
//
// Docs: POST https://api.interakt.ai/v1/public/track/users/
//   Authorization: Basic <base64 Secret Key>   (we store the key already base64,
//   so it is used verbatim — no re-encoding)
//   Body: { userId?, phoneNumber, countryCode, traits{…}, tags[] }

const INTERAKT_TRACK_URL = "https://api.interakt.ai/v1/public/track/users/";

// The lead shape the sync needs — a subset of the leads list SELECT.
export interface LeadForSync {
  number: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  phoneCountryCode: string | null;
  city: string | null;
  program: string | null;
  family: string | null;
  value: string | null;
  stage: string | null;
  stageLabel: string | null;
  rating: string | null;
  source: string | null;
  sourceLabel: string | null;
  advisorName: string | null;
  feePaid: string | null;
  feeDue: string | null;
  dueDate: string | null;
  deliveryMode: string | null;
  leadStatus: string | null;
  nextFollowupAt: string | null;
  score: number | null;
}

export type SyncOutcome =
  | { status: "synced"; number: string | null }
  | { status: "skipped"; number: string | null; reason: string }
  | { status: "failed"; number: string | null; error: string };

// Only include traits that have a value — Interakt overwrites on every sync, so
// sending nulls would blank out fields a user may have set elsewhere.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = v;
  }
  return out;
}

// Build the Interakt Track Users payload from a lead, or return why it can't be
// synced (no phone).
export function buildInteraktPayload(
  lead: LeadForSync,
): { payload: Record<string, unknown> } | { skip: string } {
  const phone = lead.phone?.trim();
  if (!phone) return { skip: "no phone number" };
  const countryCode = (lead.phoneCountryCode?.trim() || "+91");

  const num = (v: string | null) => (v == null || v === "" ? undefined : Number(v));

  const traits = compact({
    name: lead.name ?? undefined,
    email: lead.email ?? undefined,
    city: lead.city ?? undefined,
    program: lead.program ?? undefined,
    family: lead.family ?? undefined,
    source: lead.sourceLabel ?? lead.source ?? undefined,
    stage: lead.stageLabel ?? lead.stage ?? undefined,
    rating: lead.rating ?? undefined,
    lead_status: lead.leadStatus ?? undefined,
    delivery_mode: lead.deliveryMode ?? undefined,
    deal_value: lead.value ?? undefined,
    advisor: lead.advisorName ?? undefined,
    fee_paid: num(lead.feePaid),
    fee_due: num(lead.feeDue),
    due_date: lead.dueDate ?? undefined,
    next_followup: lead.nextFollowupAt ?? undefined,
    lead_score: lead.score ?? undefined,
    crm_lead_no: lead.number ?? undefined,
  });

  const tags = [
    "lead",
    lead.rating ? String(lead.rating).toLowerCase() : null,
    lead.source ? String(lead.source).toLowerCase() : null,
  ].filter((x): x is string => !!x);

  const payload: Record<string, unknown> = {
    phoneNumber: phone,
    countryCode,
    traits,
    tags,
  };
  // Stable identifier so re-syncs update the same Interakt contact.
  if (lead.number) payload.userId = lead.number;
  return { payload };
}

// Sync one lead. `apiKey` is the base64 Secret Key stored for the tenant.
export async function syncLeadToInterakt(apiKey: string, lead: LeadForSync): Promise<SyncOutcome> {
  const built = buildInteraktPayload(lead);
  if ("skip" in built) return { status: "skipped", number: lead.number, reason: built.skip };

  try {
    const res = await fetch(INTERAKT_TRACK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${apiKey}`,
      },
      body: JSON.stringify(built.payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { status: "failed", number: lead.number, error: `Interakt ${res.status}: ${text.slice(0, 200)}` };
    }
    return { status: "synced", number: lead.number };
  } catch (err) {
    return { status: "failed", number: lead.number, error: (err as Error).message };
  }
}

// The SELECT columns a sync needs — reused by the single + bulk endpoints.
export const LEAD_SYNC_COLUMNS = `
  wi.number          AS number,
  p.name             AS name,
  p.email            AS email,
  p.phone            AS phone,
  p.phone_country_code AS "phoneCountryCode",
  p.city             AS city,
  l.program          AS program,
  prg.family         AS family,
  l.value            AS value,
  l.stage            AS stage,
  l.stage_label      AS "stageLabel",
  l.rating           AS rating,
  l.source           AS source,
  l.source_label     AS "sourceLabel",
  au.name            AS "advisorName",
  l.fee_paid         AS "feePaid",
  l.fee_due          AS "feeDue",
  l.due_date         AS "dueDate",
  l.delivery_mode    AS "deliveryMode",
  l.lead_status      AS "leadStatus",
  l.next_followup_at AS "nextFollowupAt",
  l.score            AS score
`;
