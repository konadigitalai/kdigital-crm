// Turn Gmail's message resource into the flat shape tw_message wants.
//
// Gmail hands back a recursive MIME tree (payload.parts[].parts[]…) with
// base64url bodies and headers as an unordered {name,value}[] array. Everything
// in here is about flattening that into: who, to whom, subject, text, html,
// attachments, and the two header values that stitch replies to their parents.

import type { GmailMessage, GmailPart } from "./client";

export interface ParsedEmail {
  providerMessageId: string;       // Gmail's message id
  providerThreadId:  string;       // Gmail's thread id
  rfc822MessageId:   string | null; // the Message-ID header
  inReplyTo:         string | null; // the In-Reply-To header
  direction:         "inbound" | "outbound";
  fromAddr:          string;
  fromName:          string | null;
  toAddrs:           string[];
  ccAddrs:           string[];
  subject:           string;
  bodyText:          string;
  bodyHtml:          string | null;
  attachments:       ParsedAttachment[];
  sentAt:            Date;
  labelIds:          string[];
  /** The external participant — i.e. the person this thread is *with*. */
  counterparty:      string | null;
  /**
   * The first participant who isn't this mailbox, EVEN IF they're on our own
   * domain. When `counterparty` is null (an all-internal thread) this is the
   * colleague on the other end — which is usually chatter to ignore, but is
   * occasionally a real lead who happens to sit on our domain. The ingest layer
   * uses it to rescue that case; see ingest.ts.
   */
  otherParticipant:  string | null;
  /** Sender declared this bulk mail via a List-Unsubscribe header. */
  hasListUnsubscribe: boolean;
}

export interface ParsedAttachment {
  attachmentId: string;
  filename:     string;
  mimeType:     string;
  sizeBytes:    number;
}

function headerOf(payload: GmailPart | undefined, name: string): string | null {
  const h = payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

/**
 * Pull bare addresses out of an RFC 5322 address list.
 *
 * Handles `Name <a@b.com>, "Last, First" <c@d.com>, e@f.com`. The comma inside
 * a quoted display name is the whole reason this isn't a `.split(",")` — we
 * track quote and angle-bracket depth instead.
 */
export function parseAddressList(raw: string | null): { email: string; name: string | null }[] {
  if (!raw) return [];
  const out: { email: string; name: string | null }[] = [];
  let buf = "", inQuotes = false, inAngle = false;
  const flush = () => {
    const s = buf.trim();
    buf = "";
    if (!s) return;
    const m = s.match(/^(.*?)<([^>]+)>$/);
    if (m) {
      const name = m[1]!.trim().replace(/^"|"$/g, "").trim();
      out.push({ email: m[2]!.trim().toLowerCase(), name: name || null });
    } else if (s.includes("@")) {
      out.push({ email: s.replace(/^"|"$/g, "").trim().toLowerCase(), name: null });
    }
  };
  for (const ch of raw) {
    if (ch === '"') { inQuotes = !inQuotes; buf += ch; continue; }
    if (ch === "<") inAngle = true;
    if (ch === ">") inAngle = false;
    if (ch === "," && !inQuotes && !inAngle) { flush(); continue; }
    buf += ch;
  }
  flush();
  return out;
}

function decodeBody(part: GmailPart): string {
  const data = part.body?.data;
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf8");
}

/**
 * Depth-first walk of the MIME tree collecting the first text/plain body, the
 * first text/html body, and every attachment.
 *
 * "First" matters: a multipart/alternative holds the same content twice, and a
 * forwarded message can nest a whole second email (with its own text/plain)
 * inside message/rfc822. Taking the first of each keeps us on the outer, real
 * body rather than the quoted one.
 */
function walk(part: GmailPart | undefined, acc: {
  text: string; html: string | null; attachments: ParsedAttachment[];
}): void {
  if (!part) return;
  const mime = (part.mimeType ?? "").toLowerCase();
  const filename = part.filename ?? "";
  const attachmentId = part.body?.attachmentId;

  // A part with a filename AND an attachmentId is a real attachment. Inline
  // images (cid: refs in the HTML) also come through this way; we keep them —
  // dropping them would silently lose signature logos and pasted screenshots.
  if (filename && attachmentId) {
    acc.attachments.push({
      attachmentId,
      filename,
      mimeType:  mime || "application/octet-stream",
      sizeBytes: part.body?.size ?? 0,
    });
    return;
  }

  if (mime === "text/plain" && !acc.text)  acc.text = decodeBody(part);
  else if (mime === "text/html" && !acc.html) acc.html = decodeBody(part);

  for (const child of part.parts ?? []) walk(child, acc);
}

/**
 * Strip the quoted history off a reply so the inbox preview shows what the
 * person actually wrote, not the entire thread they replied on top of.
 *
 * This is heuristic by nature — there is no standard for reply quoting. We cut
 * at the first of: an "On <date>, <someone> wrote:" attribution line, a leading
 * `>` quote block, or one of the common client separators. Only used for the
 * preview/timeline text; the full body is always stored intact.
 */
export function stripQuotedReply(text: string): string {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const cutPatterns = [
    /^On .+ wrote:\s*$/i,
    /^-{2,}\s*Original Message\s*-{2,}/i,
    /^-{2,}\s*Forwarded message\s*-{2,}/i,
    /^_{10,}\s*$/,
    /^From:\s.+/i,
    /^Sent from my /i,
  ];
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith(">")) { cut = i; break; }
    if (cutPatterns.some((re) => re.test(line.trim()))) { cut = i; break; }
  }
  return lines.slice(0, cut).join("\n").trim();
}

/** Strip HTML to rough text — fallback when a message has no text/plain part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @param mailboxEmail the address of the connected account this message was
 *   read from. Used to decide direction and to pick the counterparty.
 * @param internalDomain our own domain (e.g. digitaledify.ai). Any participant
 *   on it is "us", so it can't be the counterparty.
 */
export function parseGmailMessage(
  msg: GmailMessage,
  mailboxEmail: string,
  internalDomain: string,
): ParsedEmail {
  const p = msg.payload;
  const from = parseAddressList(headerOf(p, "From"))[0] ?? { email: "", name: null };
  const to   = parseAddressList(headerOf(p, "To"));
  const cc   = parseAddressList(headerOf(p, "Cc"));

  const acc = { text: "", html: null as string | null, attachments: [] as ParsedAttachment[] };
  walk(p, acc);

  const bodyText = acc.text || (acc.html ? htmlToText(acc.html) : "");

  const labelIds = msg.labelIds ?? [];
  const mailbox  = mailboxEmail.toLowerCase();
  // Direction is decided by who SENT it, not by Gmail's SENT label — a message
  // can carry SENT and INBOX at once when you email yourself, and drafts you
  // never sent don't reach us at all.
  const direction: "inbound" | "outbound" =
    from.email === mailbox ? "outbound" : "inbound";

  // The counterparty is the first participant who is neither this mailbox nor
  // anyone on our own domain. For an inbound mail that's normally the sender;
  // for one we sent, it's the recipient. Falls back to the raw From/To when
  // internalDomain isn't configured.
  const isOurs = (e: string) =>
    e === mailbox || (!!internalDomain && e.endsWith(`@${internalDomain}`));
  const participants = [from.email, ...to.map((x) => x.email), ...cc.map((x) => x.email)]
    .filter(Boolean);
  const counterparty = participants.find((e) => !isOurs(e)) ?? null;
  // Same, but only excluding the mailbox itself — so on an all-internal thread
  // this still names the colleague on the other end.
  const otherParticipant = participants.find((e) => e !== mailbox) ?? null;

  const sentAt = msg.internalDate
    ? new Date(Number(msg.internalDate))
    : new Date();

  return {
    providerMessageId: msg.id,
    providerThreadId:  msg.threadId,
    rfc822MessageId:   headerOf(p, "Message-ID"),
    inReplyTo:         headerOf(p, "In-Reply-To"),
    direction,
    fromAddr:          from.email,
    fromName:          from.name,
    toAddrs:           to.map((x) => x.email),
    ccAddrs:           cc.map((x) => x.email),
    subject:           headerOf(p, "Subject") ?? "(no subject)",
    bodyText,
    bodyHtml:          acc.html,
    attachments:       acc.attachments,
    sentAt,
    labelIds,
    counterparty,
    otherParticipant,
    hasListUnsubscribe: headerOf(p, "List-Unsubscribe") !== null,
  };
}

/**
 * Addresses that no human reads and no human sent. Matching one is a strong
 * signal the message is machine-generated notification mail, not correspondence.
 * Deliberately matches the LOCAL PART only — `noreply@` on any domain — because
 * the domain list is unbounded.
 */
const ROBOT_LOCAL_PARTS = [
  /^no-?reply/i,
  /^do-?not-?reply/i,
  /^notifications?[-.@]/i,
  /^notify$/i,
  /^bounce/i,
  /^mailer-daemon$/i,
  /^postmaster$/i,
  /^support@(slack|google|facebookmail|vimeo)\./i,
];

function looksAutomated(email: string): boolean {
  const local = email.split("@")[0] ?? "";
  return ROBOT_LOCAL_PARTS.some((re) => re.test(local) || re.test(email));
}

/**
 * How much of the mailbox flows into the CRM. `GMAIL_SYNC_MODE`:
 *
 *   known_contacts (DEFAULT) — only mail with someone already in the CRM.
 *     Mail from a stranger is ignored outright; we never invent a party for
 *     them. This is the safe default and the one you almost certainly want:
 *     without it, every newsletter sender becomes a "person" in the same table
 *     your leads live in, and the dedup worker starts reasoning about Vimeo.
 *
 *   all — ingest anything with an external human counterparty, creating stub
 *     parties for unknown senders (they show up as unlinked threads you can
 *     promote to leads). Use when you want the inbox to double as a catch-all
 *     for inbound enquiries from addresses you've never seen.
 *
 * Bulk/automated mail is dropped in BOTH modes unless GMAIL_SYNC_BULK=1.
 */
export type SyncMode = "known_contacts" | "all";

export function readSyncMode(): SyncMode {
  return process.env.GMAIL_SYNC_MODE === "all" ? "all" : "known_contacts";
}

/**
 * Should this message be pulled into the CRM at all?
 * Returns null to keep, or a short reason string to drop.
 *
 * @param counterparty the address the ingest layer RESOLVED this thread to.
 *   Normally parsed.counterparty, but null on an all-internal thread — unless
 *   ingest rescued it because the internal address belongs to an actual lead.
 * @param counterpartyIsKnown whether that address already exists in the CRM as
 *   a party. Resolved by the caller, since it needs a DB hit.
 */
export function skipReason(
  parsed: ParsedEmail,
  counterparty: string | null,
  counterpartyIsKnown: boolean,
  mode: SyncMode = readSyncMode(),
): string | null {
  const labels = parsed.labelIds;
  if (labels.includes("SPAM"))  return "spam";
  if (labels.includes("TRASH")) return "trash";
  if (labels.includes("DRAFT")) return "draft";

  // Nobody external, and no internal lead to rescue it — colleague chatter.
  if (!counterparty) return "internal_only";

  // Bulk mail. CATEGORY_UPDATES is the big one and the reason this guard
  // exists: Gmail files nearly all notification mail (password resets, invoice
  // receipts, "someone joined your workspace") under UPDATES, not PROMOTIONS.
  // On a real mailbox that was 78 of 85 inbound messages.
  if (process.env.GMAIL_SYNC_BULK !== "1") {
    if (labels.includes("CATEGORY_PROMOTIONS")) return "promotions";
    if (labels.includes("CATEGORY_SOCIAL"))     return "social";
    if (labels.includes("CATEGORY_UPDATES"))    return "updates";
    if (labels.includes("CATEGORY_FORUMS"))     return "forums";
    if (looksAutomated(counterparty))           return "automated_sender";
    // A List-Unsubscribe header is the mail world's own declaration of "this
    // is bulk". Cheap, standards-based, and catches senders the categories miss.
    if (parsed.hasListUnsubscribe)              return "bulk_list";
  }

  // In known_contacts mode we refuse to invent a party for a stranger.
  if (mode === "known_contacts" && !counterpartyIsKnown) {
    return "unknown_contact";
  }

  return null;
}
