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
  const r = await db.execute(sql`
    INSERT INTO tw_message (
      tenant_id, conversation_id, direction, channel,
      from_number, to_number, body,
      provider_message_id, status, error_code, error_message,
      sender_user_id, sent_at, raw_payload
    )
    VALUES (
      current_tenant(), ${conversationId}, 'outbound', ${input.channel},
      ${input.fromE164}, ${input.toE164}, ${input.body},
      ${input.send.providerMessageId}, ${status},
      ${input.send.errorCode}, ${input.send.errorMessage},
      ${input.senderUserPartyId}, now(),
      ${JSON.stringify({ raw: input.send.response.slice(0, 4000) })}::jsonb
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
    await db.execute(sql`
      UPDATE tw_conversation
      SET last_message_text = ${input.body},
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

/**
 * Drop a row into `activity` for the lead's timeline. Verb = 'SMS' or 'WhatsApp'.
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
    /** Number of files attached to this message, if any. */
    mediaCount?: number;
    /** MIME types of the attached files (in order). */
    mediaMimes?: string[];
  },
): Promise<void> {
  if (!input.workItemId) return;
  const verb   = input.channel === "whatsapp" ? "WhatsApp" : "SMS";
  const tag    = input.direction === "outbound" ? "you" : "auto";
  const verbPrefix = input.direction === "outbound" ? "Sent" : "Received";
  const mediaCount = input.mediaCount ?? 0;
  const mediaTag = mediaCount > 0
    ? ` [Attachment${mediaCount > 1 ? ` × ${mediaCount}` : ""}]`
    : "";
  const detail = `${verbPrefix}:${mediaTag}${input.body ? ` ${input.body}` : ""}`;
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
        kind: "twilio_message",
        channel: input.channel,
        direction: input.direction,
        mediaCount,
        mediaMimes: input.mediaMimes ?? [],
      })}::jsonb,
      now()
    )
  `);
}
