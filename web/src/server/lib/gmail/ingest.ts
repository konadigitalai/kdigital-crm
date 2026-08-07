// Persist one Gmail message into the inbox tables.
//
// This is the email analogue of what routes/twilio-webhook.ts does inline for
// SMS: resolve the party, upsert the conversation, insert the message (idempotently),
// attach media, mirror to the lead timeline. It lives in lib/ rather than in a
// route because two callers need it — the sync worker and the initial backfill.
//
// Idempotency is load-bearing here in a way it isn't for Twilio. Gmail's
// history feed can replay the same message id across overlapping ticks, a
// re-connect re-seeds the cursor, and — most importantly — a message WE sent
// comes back around through the sync as a SENT-labelled message. All three are
// absorbed by the UNIQUE index on tw_message.provider_message_id.
//
// NOTE on the text[] columns (to_addrs / cc_addrs): they MUST be bound with
// sql.param(). A bare `${someArray}` in a drizzle sql template expands to a
// comma-separated placeholder LIST (that's what makes `IN (${ids})` work), so
// an empty array emits nothing and yields `syntax error at or near ")"`, while
// a non-empty one splices multiple params where one array was expected.

import { sql } from "drizzle-orm";
import {
  findPartyByEmail,
  matchOrCreatePartyByEmail,
  upsertConversation,
  insertActivityForMessage,
  type DbExec,
} from "../twilio/inbox";
import { bootstrapConsent } from "../party/consent";
import { resolveSentinelPartyId } from "../party/resolve";
import { parseGmailMessage, skipReason, stripQuotedReply } from "./parse";
import { accessTokenFor, getMessage, type GmailAccountRow } from "./client";

export interface IngestResult {
  status: "inserted" | "duplicate" | "skipped";
  reason?: string;
  messageId?: string;
  partyId?: string;
}

export interface OutboundEmailInput {
  conversationId:    string;
  gmailAccountId:    string;
  fromAddr:          string;
  toAddrs:           string[];
  ccAddrs:           string[];
  subject:           string;
  bodyText:          string;
  bodyHtml:          string | null;
  senderUserPartyId: string | null;
  inReplyTo:         string | null;
  mediaAssetIds:     string[];
  send: {
    ok:                boolean;
    providerMessageId: string | null;
    threadId:          string | null;
    errorCode:         string | null;
    errorMessage:      string | null;
    response:          string;
  };
}

/**
 * Record an outbound email we just handed to Gmail (success or failure).
 * The email counterpart of recordOutbound() in lib/twilio/inbox.ts.
 *
 * Note the send also lands in the mailbox's SENT folder, so the sync worker
 * will see this same message a minute later. It gets dropped as a duplicate
 * because we write provider_message_id here, and that column is UNIQUE.
 */
export async function recordOutboundEmail(
  db: DbExec,
  input: OutboundEmailInput,
): Promise<string> {
  const r = await db.execute(sql`
    INSERT INTO tw_message (
      tenant_id, conversation_id, direction, channel,
      from_number, to_number, body, body_html, subject,
      to_addrs, cc_addrs,
      provider_message_id, provider_thread_id, in_reply_to,
      gmail_account_id, sender_user_id,
      status, error_code, error_message, sent_at, raw_payload
    )
    VALUES (
      current_tenant(), ${input.conversationId}, 'outbound', 'email',
      ${input.fromAddr}, ${input.toAddrs[0] ?? ""},
      ${input.bodyText}, ${input.bodyHtml}, ${input.subject},
      ${sql.param(input.toAddrs)}::text[], ${sql.param(input.ccAddrs)}::text[],
      ${input.send.providerMessageId}, ${input.send.threadId}, ${input.inReplyTo},
      ${input.gmailAccountId}, ${input.senderUserPartyId},
      ${input.send.ok ? "sent" : "failed"},
      ${input.send.errorCode}, ${input.send.errorMessage},
      now(),
      ${JSON.stringify({ raw: input.send.response.slice(0, 4000) })}::jsonb
    )
    RETURNING id
  `);
  const messageId = (r.rows[0] as { id: string }).id;

  if (input.send.ok && input.mediaAssetIds.length) {
    for (const [ordinal, assetId] of input.mediaAssetIds.slice(0, 25).entries()) {
      await db.execute(sql`
        INSERT INTO tw_message_media (message_id, asset_id, ordinal)
        VALUES (${messageId}, ${assetId}, ${ordinal})
      `);
    }
  }
  if (input.send.ok) {
    await db.execute(sql`
      UPDATE tw_conversation
      SET last_message_text = ${input.subject},
          last_message_at   = now(),
          updated_at        = now()
      WHERE id = ${input.conversationId}
    `);
  }
  return messageId;
}

/**
 * Fetch a Gmail message by id and write it into tw_conversation / tw_message.
 *
 * @param tenantId needed for the sentinel-actor lookup; the db handle is
 *   already inside a withTenant() transaction.
 */
export async function ingestGmailMessage(
  db: DbExec,
  tenantId: string,
  account: GmailAccountRow,
  gmailMessageId: string,
  internalDomain: string,
): Promise<IngestResult> {
  // Cheap pre-check: if we already hold this message id we can skip the API
  // call entirely. Worth it because history replay makes duplicates the
  // COMMON case on a busy mailbox, not the exception.
  const seen = await db.execute(sql`
    SELECT id FROM tw_message WHERE provider_message_id = ${gmailMessageId} LIMIT 1
  `);
  if (seen.rows.length > 0) return { status: "duplicate" };

  const token = await accessTokenFor(db, account);
  const raw = await getMessage(token, gmailMessageId);
  const parsed = parseGmailMessage(raw, account.email, internalDomain);

  // Resolve "do we already know this person?" BEFORE deciding to ingest — in
  // known_contacts mode a stranger's mail is dropped and we must not invent a
  // party for them. findPartyByEmail is the non-creating lookup.
  let counterparty = parsed.counterparty;
  let known = counterparty ? await findPartyByEmail(db, counterparty) : null;

  // Internal-domain rescue. An all-internal thread is normally colleague
  // chatter and gets dropped — but a LEAD can legitimately sit on our own
  // domain (a test lead, or staff who enrol as students). Without this, we'd
  // record the email we SEND such a person (the send path doesn't go through
  // these filters) but silently drop their REPLY, which reads as a broken
  // integration rather than a deliberate filter.
  //
  // The bar is deliberately high: the internal address must already resolve to
  // a party WITH A LEAD. A colleague who's merely an app_user still gets
  // dropped, so ordinary internal mail stays out of the CRM.
  if (!counterparty && parsed.otherParticipant) {
    const internalParty = await findPartyByEmail(db, parsed.otherParticipant);
    if (internalParty?.leadWorkItemId) {
      counterparty = parsed.otherParticipant;
      known = internalParty;
    }
  }

  const skip = skipReason(parsed, counterparty, known !== null);
  if (skip) return { status: "skipped", reason: skip };

  // skipReason guarantees a counterparty exists. In `all` mode an unknown
  // sender gets a stub party (an unlinked thread you can promote to a lead);
  // in known_contacts mode we never reach here unless `known` is non-null.
  const lookup = known ?? await matchOrCreatePartyByEmail(
    db,
    counterparty!,
    parsed.direction === "inbound" ? parsed.fromName : null,
  );
  const conv = await upsertConversation(db, lookup.partyId, "email", lookup.leadWorkItemId == null);

  // The preview text is the reply stripped of its quoted history — otherwise
  // every thread's preview is just the first line of the original message.
  const preview = stripQuotedReply(parsed.bodyText).slice(0, 2000);

  const inserted = await db.execute(sql`
    INSERT INTO tw_message (
      tenant_id, conversation_id, direction, channel,
      from_number, to_number, body, body_html, subject,
      to_addrs, cc_addrs,
      provider_message_id, provider_thread_id, rfc822_message_id, in_reply_to,
      gmail_account_id, status, sent_at, raw_payload
    )
    VALUES (
      current_tenant(), ${conv.id}, ${parsed.direction}, 'email',
      ${parsed.fromAddr}, ${parsed.toAddrs[0] ?? account.email},
      ${parsed.bodyText}, ${parsed.bodyHtml}, ${parsed.subject},
      ${sql.param(parsed.toAddrs)}::text[], ${sql.param(parsed.ccAddrs)}::text[],
      ${parsed.providerMessageId}, ${parsed.providerThreadId},
      ${parsed.rfc822MessageId}, ${parsed.inReplyTo},
      ${account.id},
      ${parsed.direction === "inbound" ? "received" : "sent"},
      ${parsed.sentAt.toISOString()},
      ${JSON.stringify({ labelIds: parsed.labelIds, snippet: raw.snippet ?? null })}::jsonb
    )
    ON CONFLICT (provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
    RETURNING id
  `);
  const row = inserted.rows[0] as { id: string } | undefined;
  // Lost a race with a concurrent tick, or this is the SENT copy of a mail we
  // just sent ourselves. Either way it's already recorded — stop here rather
  // than double-counting unread or re-mirroring to the timeline.
  if (!row) return { status: "duplicate" };
  const messageId = row.id;

  // Attachments. We store Gmail's ids rather than downloading the bytes —
  // same call the Exotel recording integration makes (provider_hosted=true,
  // re-fetched server-side on demand by /media/proxy). The blob_url is a
  // gmail:// locator the proxy knows how to resolve back into an API call.
  for (const [ordinal, att] of parsed.attachments.slice(0, 25).entries()) {
    const assetR = await db.execute(sql`
      INSERT INTO media_asset (
        tenant_id, uploaded_by, filename,
        content_type, size_bytes, blob_url,
        is_library, source, provider_hosted
      )
      VALUES (
        current_tenant(), NULL, ${att.filename},
        ${att.mimeType}, ${att.sizeBytes},
        ${`gmail://${account.id}/${parsed.providerMessageId}/${att.attachmentId}`},
        false, 'gmail_attachment', true
      )
      RETURNING id
    `);
    const assetId = (assetR.rows[0] as { id: string }).id;
    await db.execute(sql`
      INSERT INTO tw_message_media (message_id, asset_id, ordinal)
      VALUES (${messageId}, ${assetId}, ${ordinal})
    `);
  }

  // Bump conversation preview + unread. Only inbound mail is "unread" —
  // an email the advisor sent from their phone shouldn't light up the inbox.
  if (parsed.direction === "inbound") {
    await db.execute(sql`
      UPDATE tw_conversation
      SET last_message_text = ${parsed.subject},
          last_message_at   = ${parsed.sentAt.toISOString()},
          last_inbound_at   = ${parsed.sentAt.toISOString()},
          unread_count      = unread_count + 1,
          updated_at        = now()
      WHERE id = ${conv.id}
    `);
  } else {
    await db.execute(sql`
      UPDATE tw_conversation
      SET last_message_text = ${parsed.subject},
          last_message_at   = ${parsed.sentAt.toISOString()},
          updated_at        = now()
      WHERE id = ${conv.id}
    `);
  }

  // An inbound reply is the strongest email opt-in there is — they emailed us.
  // bootstrapConsent never overwrites an existing opt-out.
  if (parsed.direction === "inbound") {
    await bootstrapConsent(db, lookup.partyId, ["email"], "inbound_email");
  }

  const sentinel = await resolveSentinelPartyId(db, tenantId);
  await insertActivityForMessage(db, {
    workItemId:   lookup.leadWorkItemId,
    partyId:      lookup.partyId,
    actorType:    "system",
    actorPartyId: sentinel,
    actorName:    parsed.direction === "inbound" ? (parsed.fromName ?? parsed.fromAddr) : account.email,
    direction:    parsed.direction,
    channel:      "email",
    body:         preview,
    subject:      parsed.subject,
    mediaCount:   parsed.attachments.length,
    mediaMimes:   parsed.attachments.map((a) => a.mimeType),
  });

  return { status: "inserted", messageId, partyId: lookup.partyId };
}
