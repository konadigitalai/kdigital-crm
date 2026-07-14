// Twilio inbox helpers — party matching, conversation upsert, message insert.
//
// Same responsibilities as the deleted lib/whatsapp/inbox.ts, but leaner:
//   - matchOrCreatePartyByPhone → look up by contact_point.value (E.164),
//     fall back to party.phone, else create a minimal "Unknown +E164" party
//     with a mirrored contact_point row.
//   - upsertConversation → one row per (tenant, party, channel).
//   - insertInboundMessage → idempotent on provider_message_id.
//   - recordOutbound → insert + update conversation preview + last_message_at.
//   - insertActivityForMessage → mirror into the lead's timeline.
//   - applyStatusUpdate → flip tw_message.status from status callbacks.
//
// All helpers accept a `db` handle that comes from `withTenant()` — the caller
// is responsible for setting the tenant context, we just execute queries.

import { sql, type SQL } from "drizzle-orm";
import type { TwChannel } from "./phone.js";
import type { ParsedInboundMessage, ParsedStatusUpdate } from "./webhook.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbExec = { execute: (q: SQL) => Promise<any> };

// ─── Party lookup ────────────────────────────────────────────────────────

export interface PartyLookup {
  partyId: string;
  isNew: boolean;             // true if we just created the row
  leadWorkItemId: string | null;
  leadNumber: string | null;
}

/**
 * Find the party for an incoming phone number, or create a stub party if
 * this is the first time we've seen it. Never creates a lead — that's a
 * deliberate promotion step in the inbox UI.
 *
 * Match order:
 *   1. contact_point where value = $e164 AND kind IN ('phone','whatsapp')
 *   2. party.phone = $e164 (legacy pre-contact_point storage)
 *   3. Create new party + contact_point row.
 */
export async function matchOrCreatePartyByPhone(
  db: DbExec,
  e164: string,
): Promise<PartyLookup> {
  const trimmed = e164.trim();
  if (!trimmed.startsWith("+")) {
    throw new Error(`matchOrCreatePartyByPhone requires an E.164 number, got: ${trimmed}`);
  }

  // 1) contact_point match
  const cpR = await db.execute(sql`
    SELECT cp.party_id AS "partyId"
    FROM contact_point cp
    WHERE cp.value = ${trimmed}
      AND cp.kind IN ('phone','whatsapp')
      AND cp.valid_to IS NULL
    LIMIT 1
  `);
  const cpRow = cpR.rows[0] as { partyId: string } | undefined;
  if (cpRow) return await annotateWithLead(db, cpRow.partyId, false);

  // 2) party.phone fallback — many rows store the local subscriber number
  //    with a separate `phone_country_code` column, so try both shapes:
  //    (a) full E.164 in `phone`
  //    (b) `phone_country_code || phone` concatenated (the CRM's canonical
  //        split representation) — normalized by stripping non-digits both
  //        sides before comparing.
  const wantDigits = trimmed.replace(/\D/g, "");
  const pR = await db.execute(sql`
    SELECT id AS "partyId"
    FROM party
    WHERE
      -- Shape (a): full phone stored as E.164 with '+' and digits.
      regexp_replace(coalesce(phone, ''), '\\D', '', 'g') = ${wantDigits}
      OR
      -- Shape (b): country code split from local number.
      regexp_replace(coalesce(phone_country_code, ''), '\\D', '', 'g')
        || regexp_replace(coalesce(phone, ''), '\\D', '', 'g')
      = ${wantDigits}
    LIMIT 1
  `);
  const pRow = pR.rows[0] as { partyId: string } | undefined;
  if (pRow) return await annotateWithLead(db, pRow.partyId, false);

  // 3) Create a new party + contact_point
  const created = await db.execute(sql`
    INSERT INTO party (tenant_id, kind, name, phone)
    VALUES (current_tenant(), 'person', ${`Unknown ${trimmed}`}, ${trimmed})
    RETURNING id
  `);
  const partyId = (created.rows[0] as { id: string }).id;
  await db.execute(sql`
    INSERT INTO contact_point (tenant_id, party_id, kind, value, label, is_primary)
    VALUES (current_tenant(), ${partyId}, 'phone', ${trimmed}, 'primary', true)
    ON CONFLICT (tenant_id, party_id, kind) WHERE is_primary
    DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `);
  return { partyId, isNew: true, leadWorkItemId: null, leadNumber: null };
}

/**
 * Look up an existing party by email WITHOUT creating one. Returns null when
 * we've never seen the address.
 *
 * Split out from matchOrCreatePartyByEmail because the Gmail sync has to answer
 * "do we already know this person?" *before* deciding whether to ingest the
 * message at all — in known_contacts mode, a stranger's mail is dropped and no
 * party may be invented for them. Calling the create-variant to find that out
 * would defeat the entire purpose.
 *
 * Match order:
 *   1. contact_point where kind='email' and value = $email (case-insensitive)
 *   2. party.email (legacy, pre-contact_point storage)
 */
export async function findPartyByEmail(
  db: DbExec,
  email: string,
): Promise<PartyLookup | null> {
  const addr = email.trim().toLowerCase();
  if (!addr.includes("@")) {
    throw new Error(`findPartyByEmail requires an email address, got: ${addr}`);
  }

  // The ORDER BY is load-bearing, not cosmetic. One address can map to several
  // party rows — an app_user party auto-provisioned at login, plus the lead row
  // for the same human, plus duplicates from imports. A bare LIMIT 1 picks one
  // arbitrarily, which means an inbound email can attach to a party that ISN'T
  // the lead, showing up as an unlinked thread with a "Promote to lead" button
  // for someone who is already a lead. Prefer, in order: a party with a lead,
  // then the primary contact point, then the oldest.
  const cpR = await db.execute(sql`
    SELECT cp.party_id AS "partyId"
    FROM contact_point cp
    WHERE lower(cp.value) = ${addr}
      AND cp.kind = 'email'
      AND cp.valid_to IS NULL
    ORDER BY
      EXISTS (
        SELECT 1 FROM work_item w
        WHERE w.party_id = cp.party_id AND w.type = 'lead'
      ) DESC,
      cp.is_primary DESC,
      cp.created_at ASC
    LIMIT 1
  `);
  const cpRow = cpR.rows[0] as { partyId: string } | undefined;
  if (cpRow) return await annotateWithLead(db, cpRow.partyId, false);

  const pR = await db.execute(sql`
    SELECT id AS "partyId"
    FROM party
    WHERE lower(coalesce(email, '')) = ${addr}
    ORDER BY
      EXISTS (
        SELECT 1 FROM work_item w
        WHERE w.party_id = party.id AND w.type = 'lead'
      ) DESC,
      created_at ASC
    LIMIT 1
  `);
  const pRow = pR.rows[0] as { partyId: string } | undefined;
  if (pRow) return await annotateWithLead(db, pRow.partyId, false);

  return null;
}

/**
 * Same contract as matchOrCreatePartyByPhone, keyed on an email address:
 * find the party, or create a stub one if this address is new.
 *
 * Like the phone path, this never promotes anyone to a lead — an unknown
 * sender lands as an unlinked conversation the inbox can offer to promote.
 */
export async function matchOrCreatePartyByEmail(
  db: DbExec,
  email: string,
  /** Display name from the From header, if we have one. Only used on create. */
  displayName?: string | null,
): Promise<PartyLookup> {
  const existing = await findPartyByEmail(db, email);
  if (existing) return existing;

  const addr = email.trim().toLowerCase();
  const name = (displayName ?? "").trim() || addr;
  const created = await db.execute(sql`
    INSERT INTO party (tenant_id, kind, name, email)
    VALUES (current_tenant(), 'person', ${name}, ${addr})
    RETURNING id
  `);
  const partyId = (created.rows[0] as { id: string }).id;
  await db.execute(sql`
    INSERT INTO contact_point (tenant_id, party_id, kind, value, label, is_primary)
    VALUES (current_tenant(), ${partyId}, 'email', ${addr}, 'primary', true)
    ON CONFLICT (tenant_id, party_id, kind) WHERE is_primary
    DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `);
  return { partyId, isNew: true, leadWorkItemId: null, leadNumber: null };
}

async function annotateWithLead(
  db: DbExec,
  partyId: string,
  isNew: boolean,
): Promise<PartyLookup> {
  const wR = await db.execute(sql`
    SELECT id AS "workItemId", number
    FROM work_item
    WHERE party_id = ${partyId} AND type = 'lead'
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const wRow = wR.rows[0] as { workItemId: string; number: string } | undefined;
  return {
    partyId,
    isNew,
    leadWorkItemId: wRow?.workItemId ?? null,
    leadNumber:     wRow?.number ?? null,
  };
}

// ─── Conversation upsert ─────────────────────────────────────────────────

export interface Conversation {
  id: string;
  partyId: string;
  channel: TwChannel;
  isUnlinked: boolean;
}

/** Create (or fetch) the (tenant, party, channel) conversation. */
export async function upsertConversation(
  db: DbExec,
  partyId: string,
  channel: TwChannel,
  isUnlinked: boolean,
): Promise<Conversation> {
  const r = await db.execute(sql`
    INSERT INTO tw_conversation (tenant_id, party_id, channel, is_unlinked)
    VALUES (current_tenant(), ${partyId}, ${channel}, ${isUnlinked})
    ON CONFLICT (tenant_id, party_id, channel)
    DO UPDATE SET updated_at = now()
    RETURNING id, party_id AS "partyId", channel, is_unlinked AS "isUnlinked"
  `);
  const row = r.rows[0] as { id: string; partyId: string; channel: TwChannel; isUnlinked: boolean };
  return row;
}

// ─── Inbound message insert (idempotent) ─────────────────────────────────

/**
 * Insert an inbound message. Returns the new row's id, or null if the
 * provider_message_id already exists (idempotent — Twilio retries on any
 * non-2xx and we do NOT want duplicate rows).
 *
 * Also bumps tw_conversation.last_* + unread_count.
 */
export async function insertInboundMessage(
  db: DbExec,
  conversationId: string,
  parsed: ParsedInboundMessage,
): Promise<string | null> {
  const r = await db.execute(sql`
    INSERT INTO tw_message (
      tenant_id, conversation_id, direction, channel,
      from_number, to_number, body, provider_message_id, status,
      sent_at, raw_payload
    )
    VALUES (
      current_tenant(), ${conversationId}, 'inbound', ${parsed.channel},
      ${parsed.fromE164}, ${parsed.toE164}, ${parsed.body},
      ${parsed.providerMessageId}, 'received',
      now(), ${JSON.stringify(parsed.raw)}::jsonb
    )
    ON CONFLICT (provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
    RETURNING id
  `);
  const row = r.rows[0] as { id: string } | undefined;
  if (!row) return null;   // duplicate → already-processed, don't bump conv
  await db.execute(sql`
    UPDATE tw_conversation
    SET last_message_text = ${parsed.body},
        last_message_at   = now(),
        last_inbound_at   = now(),
        unread_count      = unread_count + 1,
        updated_at        = now()
    WHERE id = ${conversationId}
  `);
  return row.id;
}

// ─── Outbound message recording ──────────────────────────────────────────

export interface OutboundInput {
  channel:            TwChannel;
  fromE164:           string;
  toE164:             string;
  body:               string;
  senderUserPartyId:  string | null;
  /** Media assets attached in send order (0..9). Rows persisted to tw_message_media on success. */
  mediaAssetIds?:     string[];
  /** Twilio Content Builder SID used, when this was a template send. */
  contentSid?:        string | null;
  /** Resolved variables sent alongside contentSid. */
  contentVariables?:  Record<string, string> | null;
  /** Campaign this send belongs to (Phase 2). Nullable for one-off sends. */
  campaignId?:        string | null;
  send: {
    ok:                boolean;
    providerMessageId: string | null;
    errorCode:         string | null;
    errorMessage:      string | null;
    response:          string;
  };
}

/**
 * Insert an outbound message row for a send attempt (success or failure).
 * Bumps conversation preview on success. Persists tw_message_media join
 * rows in the given order (ignored on failure — we don't want orphan joins
 * to a message row that Twilio never accepted).
 * Returns the new tw_message.id.
 */
export async function recordOutbound(
  db: DbExec,
  conversationId: string,
  input: OutboundInput,
): Promise<string> {
  const status = input.send.ok ? "sent" : "failed";
  const contentVarsJson = input.contentVariables
    ? JSON.stringify(input.contentVariables)
    : null;
  const r = await db.execute(sql`
    INSERT INTO tw_message (
      tenant_id, conversation_id, direction, channel,
      from_number, to_number, body,
      provider_message_id, status, error_code, error_message,
      sender_user_id, sent_at, raw_payload,
      content_sid, content_variables, campaign_id
    )
    VALUES (
      current_tenant(), ${conversationId}, 'outbound', ${input.channel},
      ${input.fromE164}, ${input.toE164}, ${input.body},
      ${input.send.providerMessageId}, ${status},
      ${input.send.errorCode}, ${input.send.errorMessage},
      ${input.senderUserPartyId}, now(),
      ${JSON.stringify({ raw: input.send.response.slice(0, 4000) })}::jsonb,
      ${input.contentSid ?? null},
      ${contentVarsJson}::jsonb,
      ${input.campaignId ?? null}
    )
    RETURNING id
  `);
  const messageId = (r.rows[0] as { id: string }).id;
  if (input.send.ok && input.mediaAssetIds?.length) {
    for (const [ordinal, assetId] of input.mediaAssetIds.slice(0, 10).entries()) {
      await db.execute(sql`
        INSERT INTO tw_message_media (message_id, asset_id, ordinal)
        VALUES (${messageId}, ${assetId}, ${ordinal})
      `);
    }
  }
  if (input.send.ok) {
    // Template sends have no runtime body — surface a compact placeholder
    // in the conversation preview so the inbox still lists something usable.
    const previewText = input.body && input.body.trim()
      ? input.body
      : (input.contentSid ? "[template]" : "");
    await db.execute(sql`
      UPDATE tw_conversation
      SET last_message_text = ${previewText},
          last_message_at   = now(),
          updated_at        = now()
      WHERE id = ${conversationId}
    `);
  }
  return messageId;
}

// ─── Status callback (delivered / failed) ────────────────────────────────

export async function applyStatusUpdate(
  db: DbExec,
  parsed: ParsedStatusUpdate,
): Promise<boolean> {
  const willSetDelivered =
    parsed.status === "delivered" || parsed.status === "read";
  const r = await db.execute(sql`
    UPDATE tw_message
    SET status         = ${parsed.status},
        error_code     = COALESCE(${parsed.errorCode},   error_code),
        error_message  = COALESCE(${parsed.errorMessage}, error_message),
        delivered_at   = CASE WHEN ${willSetDelivered} AND delivered_at IS NULL THEN now() ELSE delivered_at END
    WHERE provider_message_id = ${parsed.providerMessageId}
    RETURNING id
  `);
  return (r.rows[0] as { id: string } | undefined) !== undefined;
}

// ─── Timeline activity mirror ─────────────────────────────────────────────

const CHANNEL_VERB: Record<TwChannel, string> = {
  sms:      "SMS",
  whatsapp: "WhatsApp",
  voice:    "Call",
  email:    "Email",
};

/**
 * Drop a row into `activity` for the lead's timeline.
 * No-op when there's no lead work_item attached (unlinked contacts skip the
 * mirror — the message is still visible in the /inbox surface).
 */
export async function insertActivityForMessage(
  db: DbExec,
  input: {
    workItemId: string | null;
    partyId: string;
    actorType: "user" | "agent" | "system";
    actorPartyId: string | null;
    actorName: string;
    direction: "inbound" | "outbound";
    channel: TwChannel;
    body: string;
    /** Email only — shown instead of the body in the timeline detail line. */
    subject?: string | null;
    /** Number of files attached to this message, if any. */
    mediaCount?: number;
    /** MIME types of the attached files (in order). */
    mediaMimes?: string[];
  },
): Promise<void> {
  if (!input.workItemId) return;
  const verb   = CHANNEL_VERB[input.channel] ?? "SMS";
  const tag    = input.direction === "outbound" ? "you" : "auto";
  const verbPrefix = input.direction === "outbound" ? "Sent" : "Received";
  const mediaCount = input.mediaCount ?? 0;
  const mediaTag = mediaCount > 0
    ? ` [Attachment${mediaCount > 1 ? ` × ${mediaCount}` : ""}]`
    : "";
  // For email the subject is the useful summary; the body is usually far too
  // long for a timeline row and often carries a quoted thread underneath.
  const summary = input.channel === "email" && input.subject
    ? input.subject
    : input.body;
  const detail = `${verbPrefix}:${mediaTag}${summary ? ` ${summary}` : ""}`;
  await db.execute(sql`
    INSERT INTO activity (
      tenant_id, work_item_id, party_id,
      actor_type, actor_party_id, actor_name,
      verb, detail, tag, payload, ts
    )
    VALUES (
      current_tenant(), ${input.workItemId}, ${input.partyId},
      ${input.actorType}, ${input.actorPartyId}, ${input.actorName},
      ${verb}, ${detail}, ${tag},
      ${JSON.stringify({
        kind: input.channel === "email" ? "email" : "twilio_message",
        channel: input.channel,
        direction: input.direction,
        subject: input.subject ?? null,
        mediaCount,
        mediaMimes: input.mediaMimes ?? [],
      })}::jsonb,
      now()
    )
  `);
}
