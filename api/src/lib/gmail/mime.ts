// Build an RFC 2822 message for users.messages.send.
//
// Gmail's send endpoint takes a fully-formed MIME document, so composing mail
// means assembling the headers and multipart structure ourselves. Structure:
//
//   no attachments   →  multipart/alternative { text/plain, text/html }
//   with attachments →  multipart/mixed { multipart/alternative{…}, part… }
//
// Bodies are base64-encoded rather than quoted-printable: it sidesteps the
// 998-octet line limit and the soft-wrap rules entirely, at ~33% size cost on
// text that is already tiny next to any attachment.

import { randomBytes } from "node:crypto";

export interface Attachment {
  filename:  string;
  mimeType:  string;
  content:   Buffer;
}

export interface BuildMimeInput {
  fromEmail:   string;
  fromName?:   string | null;
  to:          string[];
  cc?:         string[];
  subject:     string;
  bodyText:    string;
  bodyHtml?:   string | null;
  attachments?: Attachment[];
  /** The parent's Message-ID header, when this is a reply. */
  inReplyTo?:  string | null;
  /** Accumulated References chain from the parent, oldest first. */
  references?: string[];
}

/**
 * RFC 2047 encode a header value if it isn't plain ASCII.
 *
 * Subjects routinely carry names with accents, emoji, or Devanagari — raw
 * UTF-8 in a header is illegal and gets mangled to '?' by strict receivers.
 */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** `Name <a@b.com>` with the display name encoded and quoted when needed. */
function formatAddress(email: string, name?: string | null): string {
  if (!name) return email;
  const encoded = encodeHeader(name);
  // A quoted-string can't hold a bare '"'; an encoded-word must NOT be quoted.
  const display = encoded === name ? `"${name.replace(/"/g, "'")}"` : encoded;
  return `${display} <${email}>`;
}

/** Base64 in 76-char lines, per RFC 2045. */
function b64Lines(buf: Buffer): string {
  return buf.toString("base64").replace(/(.{76})/g, "$1\r\n").trimEnd();
}

/** Sanitize a filename for the Content-Disposition header. */
function safeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, "_").slice(0, 200) || "attachment";
}

export function buildMime(input: BuildMimeInput): string {
  const attachments = input.attachments ?? [];
  const hasHtml     = !!input.bodyHtml && input.bodyHtml.trim().length > 0;
  const altBoundary = `alt_${randomBytes(12).toString("hex")}`;
  const mixBoundary = `mix_${randomBytes(12).toString("hex")}`;

  const headers: string[] = [
    `From: ${formatAddress(input.fromEmail, input.fromName)}`,
    `To: ${input.to.join(", ")}`,
  ];
  if (input.cc?.length) headers.push(`Cc: ${input.cc.join(", ")}`);
  headers.push(`Subject: ${encodeHeader(input.subject)}`);
  headers.push("MIME-Version: 1.0");

  // These two are what make the RECIPIENT's mail client thread our reply under
  // the message they sent. Gmail's threadId only threads it in our own mailbox
  // — it means nothing to Outlook on the other end.
  if (input.inReplyTo) {
    headers.push(`In-Reply-To: ${input.inReplyTo}`);
    const refs = [...(input.references ?? [])];
    if (!refs.includes(input.inReplyTo)) refs.push(input.inReplyTo);
    headers.push(`References: ${refs.join(" ")}`);
  }

  // The alternative block: same content as text and (optionally) HTML, letting
  // the receiving client pick. Always send a text/plain part — HTML-only mail
  // is a well-known spam signal.
  const altParts: string[] = [
    [
      `--${altBoundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64Lines(Buffer.from(input.bodyText || "", "utf8")),
      "",
    ].join("\r\n"),
  ];
  if (hasHtml) {
    altParts.push([
      `--${altBoundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64Lines(Buffer.from(input.bodyHtml!, "utf8")),
      "",
    ].join("\r\n"));
  }
  altParts.push(`--${altBoundary}--`);
  const alternative = altParts.join("\r\n");

  if (!attachments.length) {
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      "",
      alternative,
      "",
    ].join("\r\n");
  }

  const attachParts = attachments.map((a) => [
    `--${mixBoundary}`,
    `Content-Type: ${a.mimeType || "application/octet-stream"}; name="${safeFilename(a.filename)}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${safeFilename(a.filename)}"`,
    "",
    b64Lines(a.content),
    "",
  ].join("\r\n"));

  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixBoundary}"`,
    "",
    `--${mixBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    "",
    alternative,
    "",
    ...attachParts,
    `--${mixBoundary}--`,
    "",
  ].join("\r\n");
}
