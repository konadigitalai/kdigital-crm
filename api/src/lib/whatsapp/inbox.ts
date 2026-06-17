/**
 * Inbox helpers — reused by the webhook handler AND manual send routes.
 *
 * The five things we need everywhere:
 *
 *   matchOrCreatePartyByPhone — strict E.164 match against
 *     `phone_country_code || phone` on party. If no match, create a
 *     new party (kind='person', name='Unknown · +91XXXXXX'). The
 *     resulting party is the "contact" in inbox terms; if the team
 *     wants to promote them, they hit /promote-to-lead which adds
 *     the party_role row.
 *
 *   upsertConversation — finds or creates wa_conversation for
 *     (tenant_id, party_id). Bumps last_message_at + unread_count
 *     for inbound. Bumps last_message_at + last_message_text for
 *     outbound.
 *
 *   insertInboundMessage — idempotent insert keyed on
 *     provider_message_id (Meta retries the same payload until 200,
 *     which would otherwise duplicate rows).
 *
 *   applyStatusUpdate — flips wa_message status, sets delivered_at
 *     / read_at; promotes delivered_at if Meta skips it (rare but
 *     does happen when the recipient opens a message before our
 *     server gets the delivered event).
 *
 *   recordOutbound — inserts a queued/sent wa_message after a
 *     dispatcher call so the inbox UI can show "sending..." → "sent
 *     ✓✓" → "read ✓✓ blue" without a refresh.
 */

import { sql, type SQL } from "drizzle-orm";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbExec = { execute: (q: SQL) => Promise<any> };

import type { ParsedInboundMessage, ParsedStatusUpdate } from "./meta.js";

// ─── Phone normalisation ──────────────────────────────────────────────────

/** Strip everything but digits. Used to compare phone formats consistently. */
export function digitsOnly(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

/** Render an E.164 number with leading +. Accepts inputs with or without +. */
export function toE164(phone: string): string {
  const d = digitsOnly(phone);
  return d.length ? `+${d}` : "";
}

/** Best-effort split: pick a country code (1-3 digits) off the front and
 *  return the remainder as the local subscriber number. Used only when
 *  creating a new party from a webhook — Meta gives us the full E.164
 *  but our schema splits country code into a separate column.
 *  Heuristics:
 *    - If the digit string starts with '1' (NANP) → cc='+1'
 *    - If it starts with one of a small set of known 2-digit codes → cc='+NN'
 *    - Otherwise default to first 2 digits (covers most real-world cases
 *      we'll see — IN, US/CA, GB, AU, DE, FR, BR, JP, etc.)
 *  Worth noting: this is intentionally rough. The number stays correct in
 *  whole-string form (E.164 with leading +), and the matching helper below
 *  uses the WHOLE string anyway — the split only matters for display. */
export function splitE164(e164: string): { cc: string; local: string } {
  const d = digitsOnly(e164);
  if (!d) return { cc: "", local: "" };
  // 1 = NANP, 7 = Russia/Kazakhstan
  if (d[0] === "1" || d[0] === "7") return { cc: `+${d[0]}`, local: d.slice(1) };
  // Common 3-digit codes: 222-289 (Africa), 350-399 (Europe), 420-429 (Europe),
  // 670-679 (Asia/Pac), 850-895 (Asia), 960-998 (Mid-East/Asia). Catch-all is
  // 2 digits — covers 91 (IN), 44 (UK), 33 (FR), 49 (DE), 86 (CN), 81 (JP) etc.
  const three = Number(d.slice(0, 3));
  if (
    (three >= 220 && three <= 299) ||
    (three >= 350 && three <= 399) ||
    (three >= 420 && three <= 429) ||
    (three >= 500 && three <= 599) ||
    (three >= 670 && three <= 699) ||
    (three >= 850 && three <= 899) ||
    (three >= 960 && three <= 998)
  ) {
    return { cc: `+${d.slice(0, 3)}`, local: d.slice(3) };
  }
  return { cc: `+${d.slice(0, 2)}`, local: d.slice(2) };
}

// ─── Party matching ───────────────────────────────────────────────────────

/** Match a webhook's `from` phone to an existing party. Strict E.164:
 *  we compare the digits-only version of `phone_country_code || phone`
 *  to the digits-only version of the inbound number. RLS scopes by tenant. */
export async function findPartyByE164(db: DbExec, e164OrDigits: string): Promise<{ partyId: string; name: string } | null> {
  const digits = digitsOnly(e164OrDigits);
  if (!digits) return null;
  const r = await db.execute(sql`
    SELECT p.id AS "partyId", p.name
    FROM party p
    WHERE
      regexp_replace(COALESCE(p.phone_country_code, ''), '[^0-9]', '', 'g')
      ||
      regexp_replace(COALESCE(p.phone, ''), '[^0-9]', '', 'g')
      = ${digits}
    LIMIT 1
  `);
  return (r.rows[0] as { partyId: string; name: string } | undefined) ?? null;
}

/** As above; if no match, create a new party with kind='person',
 *  name='WhatsApp · +91XXXXXX'. The new party has no party_role yet —
 *  it's just a contact. The user can promote to lead later. */
export async function matchOrCreatePartyByPhone(db: DbExec, e164: string): Promise<{ partyId: string; created: boolean }> {
  const matched = await findPartyByE164(db, e164);
  if (matched) return { partyId: matched.partyId, created: false };

  const { cc, local } = splitE164(e164);
  const display = `WhatsApp · ${e164.startsWith("+") ? e164 : `+${digitsOnly(e164)}`}`;
  const r = await db.execute(sql`
    INSERT INTO party (tenant_id, kind, name, phone, phone_country_code, identifiers, attributes)
    VALUES (
      current_tenant(), 'person', ${display}, ${local}, ${cc},
      ${JSON.stringify({ source: "whatsapp_inbound" })}::jsonb,
      ${JSON.stringify({ initials: "WA" })}::jsonb
    )
    RETURNING id
  `);
  const partyId = (r.rows[0] as { id: string }).id;
  return { partyId, created: true };
}

// ─── Conversation upsert ──────────────────────────────────────────────────

/** Find-or-create a wa_conversation row keyed on (tenant_id, party_id).
 *  Returns the conversation id. */
export async function upsertConversation(db: DbExec, partyId: string): Promise<{ conversationId: string; created: boolean }> {
  // INSERT … ON CONFLICT … DO UPDATE returning xmax=0 lets us distinguish
  // insert vs update without a separate SELECT.
  const r = await db.execute(sql`
    INSERT INTO wa_conversation (tenant_id, party_id)
    VALUES (current_tenant(), ${partyId})
    ON CONFLICT (tenant_id, party_id) DO UPDATE
      SET updated_at = NOW()
    RETURNING id, (xmax = 0) AS created
  `);
  const row = r.rows[0] as { id: string; created: boolean };
  return { conversationId: row.id, created: row.created };
}

// ─── Inbound message persistence ──────────────────────────────────────────

export async function insertInboundMessage(
  db: DbExec,
  conversationId: string,
  inbound: ParsedInboundMessage,
  rawPayload: unknown,
): Promise<{ messageId: string | null; deduped: boolean }> {
  // ON CONFLICT on the partial unique index. provider_message_id is
  // never null on inbound (Meta always sets it) but we keep the WHERE
  // clause partial in the index, so the conflict target is just the
  // column. We rely on Meta retrying the SAME wamid; if it's a new
  // wamid, we treat it as a new message (correct).
  const r = await db.execute(sql`
    INSERT INTO wa_message (
      tenant_id, conversation_id, direction, sender_type,
      content_type, body, media_url, media_mime,
      provider_message_id, in_reply_to_provider_id,
      sent_at, status, raw_payload
    )
    VALUES (
      current_tenant(), ${conversationId}, 'inbound', 'customer',
      ${inbound.contentType}, ${inbound.body}, ${inbound.mediaUrl ?? null}, ${inbound.mediaMime ?? null},
      ${inbound.providerMessageId}, ${inbound.inReplyToProviderId ?? null},
      to_timestamp(${inbound.timestamp}), 'delivered',
      ${JSON.stringify(rawPayload)}::jsonb
    )
    ON CONFLICT (provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
    RETURNING id
  `);
  const inserted = r.rows[0] as { id: string } | undefined;
  return inserted ? { messageId: inserted.id, deduped: false } : { messageId: null, deduped: true };
}

/** After insertInboundMessage succeeded, bump the conversation's
 *  last-touched / unread state. Skipped on dedup. */
export async function bumpConversationOnInbound(
  db: DbExec,
  conversationId: string,
  inbound: ParsedInboundMessage,
): Promise<void> {
  // Truncate body for the preview column to keep it cheap.
  const preview = (inbound.body ?? `[${inbound.contentType}]`).slice(0, 240);
  await db.execute(sql`
    UPDATE wa_conversation
       SET last_message_text = ${preview},
           last_message_at   = to_timestamp(${inbound.timestamp}),
           last_inbound_at   = to_timestamp(${inbound.timestamp}),
           unread_count      = unread_count + 1,
           updated_at        = NOW()
     WHERE id = ${conversationId}
  `);
}

// ─── Status callbacks ─────────────────────────────────────────────────────

export async function applyStatusUpdate(db: DbExec, s: ParsedStatusUpdate): Promise<void> {
  // Build a dynamic UPDATE that only touches the fields the status implies.
  // delivered_at is COALESCE'd so an out-of-order 'sent' webhook doesn't
  // overwrite a later 'read'. Symmetrically for read_at / failed.
  const sets: SQL[] = [sql`status = ${s.status}`];
  if (s.status === "delivered") {
    sets.push(sql`delivered_at = COALESCE(delivered_at, to_timestamp(${s.timestamp}))`);
  } else if (s.status === "read") {
    // Promote delivered_at if not set — Meta sometimes skips delivered.
    sets.push(sql`delivered_at = COALESCE(delivered_at, to_timestamp(${s.timestamp}))`);
    sets.push(sql`read_at      = COALESCE(read_at,      to_timestamp(${s.timestamp}))`);
  } else if (s.status === "failed") {
    if (s.errorCode)    sets.push(sql`error_code    = ${s.errorCode}`);
    if (s.errorMessage) sets.push(sql`error_message = ${s.errorMessage}`);
  }
  const setClause = sql.join(sets, sql`, `);
  await db.execute(sql`
    UPDATE wa_message
       SET ${setClause}
     WHERE provider_message_id = ${s.providerMessageId}
  `);

  // Mirror onto wa_broadcast_recipient for any row sent by a broadcast.
  // The wa_broadcast_recipient_status_changed_trg on the table keeps the
  // wa_broadcast.{delivered,read,failed}_count rollups in sync — we just
  // flip the recipient row's status. NULL provider_message_id rows are
  // ruled out by the WHERE clause; the partial UNIQUE index on
  // provider_message_id makes this a single-row update at most.
  const brSets: SQL[] = [sql`status = ${s.status}`];
  if (s.status === "delivered") {
    brSets.push(sql`delivered_at = COALESCE(delivered_at, to_timestamp(${s.timestamp}))`);
  } else if (s.status === "read") {
    brSets.push(sql`delivered_at = COALESCE(delivered_at, to_timestamp(${s.timestamp}))`);
    brSets.push(sql`read_at      = COALESCE(read_at,      to_timestamp(${s.timestamp}))`);
  } else if (s.status === "failed") {
    if (s.errorCode)    brSets.push(sql`error_code    = ${s.errorCode}`);
    if (s.errorMessage) brSets.push(sql`error_message = ${s.errorMessage}`);
  }
  const brSetClause = sql.join(brSets, sql`, `);
  await db.execute(sql`
    UPDATE wa_broadcast_recipient
       SET ${brSetClause}
     WHERE provider_message_id = ${s.providerMessageId}
       AND status NOT IN ('cancelled')
  `);
}

// ─── Outbound message recording ───────────────────────────────────────────

export interface RecordOutboundArgs {
  conversationId: string;
  senderUserId: string | null;       // null = system / bot / automation
  contentType: "text" | "template" | "image" | "audio" | "video" | "document";
  body: string | null;               // user-visible body OR rendered template
  templateName?: string | null;
  templateVariables?: Record<string, string> | null;
  mediaUrl?: string | null;
  mediaMime?: string | null;
  providerMessageId: string | null;
  status: "queued" | "sent" | "failed";
  httpStatus: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/** Insert the wa_message row + bump conversation last_message_*.
 *  Returns the new message id. */
export async function recordOutbound(db: DbExec, a: RecordOutboundArgs): Promise<string> {
  const r = await db.execute(sql`
    INSERT INTO wa_message (
      tenant_id, conversation_id, direction, sender_type,
      sender_user_id, content_type, body,
      template_name, template_variables,
      media_url, media_mime,
      provider_message_id, status,
      http_status, error_code, error_message
    )
    VALUES (
      current_tenant(), ${a.conversationId}, 'outbound',
      ${a.senderUserId ? "agent" : "system"}, ${a.senderUserId},
      ${a.contentType}, ${a.body},
      ${a.templateName ?? null},
      ${a.templateVariables ? sql`${JSON.stringify(a.templateVariables)}::jsonb` : sql`NULL`},
      ${a.mediaUrl ?? null}, ${a.mediaMime ?? null},
      ${a.providerMessageId},
      ${a.status},
      ${a.httpStatus},
      ${a.errorCode ?? null}, ${a.errorMessage ?? null}
    )
    RETURNING id
  `);
  const id = (r.rows[0] as { id: string }).id;

  // Update conversation preview / last_message_at. Don't touch
  // unread_count (that's inbound-only) or last_inbound_at.
  const preview = (a.body ?? `[${a.contentType}]`).slice(0, 240);
  await db.execute(sql`
    UPDATE wa_conversation
       SET last_message_text = ${preview},
           last_message_at   = NOW(),
           updated_at        = NOW()
     WHERE id = ${a.conversationId}
  `);
  return id;
}
