// Twilio webhook signature verification + inbound payload parsing.
//
// Twilio signs the URL Twilio Console has registered (byte-exact) concatenated
// with the sorted form parameters "key1value1key2value2…", HMAC-SHA1 with the
// auth token, base64. Sent in the `X-Twilio-Signature` header.
//
// Docs: https://www.twilio.com/docs/usage/webhooks/webhooks-security
//
// We do NOT trust `Host` / `X-Forwarded-Proto` — behind ngrok / a reverse
// proxy those can be spoofed. Instead we hash against the operator-configured
// `TWILIO_WEBHOOK_URL` env var. If Twilio Console and env drift, verification
// fails and we return 403 — that's the correct failure mode.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { TwChannel } from "./phone.js";
import { parseTwilioAddr } from "./phone.js";

export function verifyTwilioSignature(
  signature: string | undefined,
  expectedUrl: string,
  formBody: Record<string, string>,
  authToken: string,
): boolean {
  if (!signature || !authToken || !expectedUrl) return false;
  // Sort keys, concat as key+value, prepend the URL.
  const sortedKeys = Object.keys(formBody).sort();
  const canonical =
    expectedUrl +
    sortedKeys.map((k) => k + formBody[k]).join("");
  const expected = createHmac("sha1", authToken).update(canonical, "utf8").digest("base64");
  return safeCompare(signature, expected);
}

function safeCompare(a: string, b: string): boolean {
  const A = Buffer.from(a, "utf8");
  const B = Buffer.from(b, "utf8");
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

/** Shape produced from Twilio's inbound webhook form body. */
export interface ParsedInboundMessage {
  kind:              "inbound";
  providerMessageId: string;
  channel:           TwChannel;
  fromE164:          string;    // customer phone
  toE164:            string;    // our Twilio number
  body:              string;
  profileName:       string | null;  // WhatsApp only
  numMedia:          number;
  /** Media URLs Twilio sent us. Each URL is Basic-auth gated by Twilio's
   *  master credentials — we save them as-is and proxy at render time. */
  media:             Array<{ url: string; contentType: string }>;
  raw:               Record<string, string>;
}

/** Shape produced from a Twilio outbound-status callback. */
export interface ParsedStatusUpdate {
  kind:              "status";
  providerMessageId: string;
  status:            "queued" | "sent" | "delivered" | "read" | "failed" | "received";
  errorCode:         string | null;
  errorMessage:      string | null;
  raw:               Record<string, string>;
}

export type ParsedTwilioWebhook = ParsedInboundMessage | ParsedStatusUpdate | { kind: "ignore" };

/**
 * Detect + parse a Twilio webhook body. Twilio uses the same POST URL for
 * inbound-message and status-callback events; the distinguishing field is
 * `Body` (inbound) vs `MessageStatus` (status update).
 */
export function parseTwilioWebhook(form: Record<string, string>): ParsedTwilioWebhook {
  const sid = form.MessageSid ?? form.SmsSid ?? "";
  if (!sid) return { kind: "ignore" };

  // Inbound message
  if (typeof form.Body === "string" && !form.MessageStatus) {
    const from = parseTwilioAddr(form.From);
    const to   = parseTwilioAddr(form.To);
    if (!from || !to) return { kind: "ignore" };
    const numMedia = Number(form.NumMedia ?? "0") || 0;
    const media: Array<{ url: string; contentType: string }> = [];
    for (let i = 0; i < numMedia && i < 10; i++) {
      const url = form[`MediaUrl${i}`];
      const contentType = form[`MediaContentType${i}`] ?? "application/octet-stream";
      if (url) media.push({ url, contentType });
    }
    return {
      kind: "inbound",
      providerMessageId: sid,
      channel: from.channel,
      fromE164: from.e164,
      toE164:   to.e164,
      body: form.Body,
      profileName: (form.ProfileName ?? "").trim() || null,
      numMedia,
      media,
      raw: form,
    };
  }

  // Status callback
  if (typeof form.MessageStatus === "string") {
    const raw = form.MessageStatus.toLowerCase();
    const known = ["queued","sent","delivered","read","failed","received"] as const;
    const status = (known as readonly string[]).includes(raw)
      ? raw as ParsedStatusUpdate["status"]
      : "failed";
    return {
      kind: "status",
      providerMessageId: sid,
      status,
      errorCode: form.ErrorCode ? String(form.ErrorCode) : null,
      errorMessage: form.ErrorMessage ?? null,
      raw: form,
    };
  }

  return { kind: "ignore" };
}

/** Normalize the inbound body and check for a WhatsApp / SMS opt-out
 *  keyword. Case-insensitive. Trims surrounding whitespace + punctuation. */
export function isOptOutMessage(body: string): boolean {
  const norm = body.trim().toLowerCase().replace(/[.!?,]+$/g, "");
  return OPT_OUT_KEYWORDS.has(norm);
}

/** Mirror-image: START/YES resubscribes on some carriers. Not enabled by
 *  default (Meta requires explicit re-opt-in for WhatsApp), but exposed
 *  so callers can decide their policy. */
export function isOptInMessage(body: string): boolean {
  const norm = body.trim().toLowerCase().replace(/[.!?,]+$/g, "");
  return OPT_IN_KEYWORDS.has(norm);
}

const OPT_OUT_KEYWORDS = new Set([
  "stop", "stop all", "stopall",
  "unsubscribe", "cancel", "end", "quit",
]);
const OPT_IN_KEYWORDS = new Set([
  "start", "yes", "unstop", "resubscribe",
]);

