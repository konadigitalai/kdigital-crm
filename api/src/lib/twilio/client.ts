// Thin Twilio REST client.
//
// Mirrors the shape of `postToSlack` in ../slack.ts: fetch + 5s AbortController,
// captures {httpStatus, ok, response} so callers can log deliveries and surface
// errors in the UI. Uses global `fetch` (Node 20+); no Twilio SDK dep.
//
// Config is env-driven and read on demand (not cached at module import) so
// tests / local dev can override without a full restart in every case. Env is
// read only when actually sending — the inbox reads don't need Twilio config.

import { formatTwilioAddr, toE164, type TwChannel } from "./phone.js";

export interface TwilioConfig {
  sid:       string;
  token:     string;
  smsFrom:   string;   // E.164, no channel prefix
  waFrom:    string;   // E.164, no channel prefix
  webhookUrl:string;   // exact URL Twilio Console has registered (for HMAC verify)
}

export class TwilioNotConfigured extends Error {
  constructor(missing: string[]) {
    super(`Twilio not configured — missing env vars: ${missing.join(", ")}`);
    this.name = "TwilioNotConfigured";
  }
}

export function readTwilioConfig(): TwilioConfig {
  const sid        = (process.env.TWILIO_ACCOUNT_SID   ?? "").trim();
  const token      = (process.env.TWILIO_AUTH_TOKEN    ?? "").trim();
  const smsFrom    = toE164(process.env.TWILIO_SMS_FROM ?? "");
  const waFrom     = toE164(process.env.TWILIO_WHATSAPP_FROM ?? "");
  const webhookUrl = (process.env.TWILIO_WEBHOOK_URL   ?? "").trim();
  const missing: string[] = [];
  if (!sid)        missing.push("TWILIO_ACCOUNT_SID");
  if (!token)      missing.push("TWILIO_AUTH_TOKEN");
  if (!smsFrom)    missing.push("TWILIO_SMS_FROM");
  if (!waFrom)     missing.push("TWILIO_WHATSAPP_FROM");
  if (!webhookUrl) missing.push("TWILIO_WEBHOOK_URL");
  if (missing.length) throw new TwilioNotConfigured(missing);
  return { sid, token, smsFrom, waFrom, webhookUrl };
}

/** Return only the fields relevant for signature verification. Cheaper than
 *  full readTwilioConfig() and lets webhook errors report "missing token"
 *  even if the send-side env vars aren't set. */
export function readTwilioAuthToken(): string | null {
  const token = (process.env.TWILIO_AUTH_TOKEN ?? "").trim();
  return token || null;
}

export interface SendResult {
  ok:                 boolean;
  httpStatus:         number;
  providerMessageId:  string | null;
  errorCode:          string | null;
  errorMessage:       string | null;
  /** Raw JSON response body from Twilio (first 1000 chars). Kept for logging. */
  response:           string;
}

/** Options for the extended send call — the two paths we support today are
 *  freeform (Body + optional media) and template (ContentSid + variables).
 *  Providing both is an error at the caller layer; here we prefer template. */
export interface SendMessageOptions {
  /** WhatsApp templates only. Meta-approved ContentSid (starts "HX"). */
  contentSid?:        string;
  /** Values for the template placeholders. Keys match the template's
   *  `{{placeholder}}` names OR positional numbers (Twilio accepts both). */
  contentVariables?:  Record<string, string>;
  /** Public HTTPS URLs Twilio should download and attach. Ignored when
   *  contentSid is present — template media is baked into the template. */
  mediaUrls?:         string[];
}

/**
 * POST /2010-04-01/Accounts/{SID}/Messages.json with Basic auth.
 * Body is form-encoded per the Twilio API convention.
 *
 * Two send modes:
 *   1. Freeform: pass `body` (and optionally `mediaUrls`). Only works inside
 *      the WhatsApp 24-hour session window; SMS has no session limit.
 *   2. Template: pass `opts.contentSid` + `opts.contentVariables`. The
 *      template must be Meta-approved. `body` is ignored in this path.
 *
 * `mediaUrls` — up to 10 public HTTPS URLs. Twilio downloads each and
 * attaches it to the message. WhatsApp accepts richer types; SMS/MMS
 * limits to images (per-channel validation should happen in the caller).
 */
export async function sendMessage(
  channel: TwChannel,
  toE164Addr: string,
  body: string,
  cfg: TwilioConfig = readTwilioConfig(),
  mediaUrlsOrOpts: string[] | SendMessageOptions = [],
): Promise<SendResult> {
  // Back-compat: legacy callers passed `mediaUrls: string[]` as the 5th arg.
  // Newer callers pass a SendMessageOptions object. Normalize.
  const opts: SendMessageOptions = Array.isArray(mediaUrlsOrOpts)
    ? { mediaUrls: mediaUrlsOrOpts }
    : mediaUrlsOrOpts;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}/Messages.json`;
  const from = channel === "whatsapp" ? formatTwilioAddr("whatsapp", cfg.waFrom) : cfg.smsFrom;
  const to   = formatTwilioAddr(channel, toE164Addr);
  if (!to) {
    return {
      ok: false, httpStatus: 0, providerMessageId: null,
      errorCode: "invalid_to", errorMessage: `Invalid destination phone: ${toE164Addr}`,
      response: "",
    };
  }
  const form = new URLSearchParams();
  form.set("From", from);
  form.set("To",   to);
  if (opts.contentSid) {
    // Template send. Twilio ignores Body when ContentSid is present.
    form.set("ContentSid", opts.contentSid);
    if (opts.contentVariables && Object.keys(opts.contentVariables).length > 0) {
      form.set("ContentVariables", JSON.stringify(opts.contentVariables));
    }
  } else {
    if (body) form.set("Body", body);
    // Twilio accepts repeated MediaUrl fields; cap at 10 to match their limit.
    for (const mUrl of (opts.mediaUrls ?? []).slice(0, 10)) form.append("MediaUrl", mUrl);
  }

  // Ask Twilio to POST delivery updates back to us. Without this, statuses
  // only arrive if a Messaging Service or WhatsApp-sender-level callback is
  // configured in the Console — SMS has no such setting at all, so messages
  // would sit at "sent" forever. Same URL as inbound: the webhook handler
  // branches on MessageStatus vs Body (see lib/twilio/webhook.ts).
  //
  // Guarded: Twilio rejects the whole send with error 21609 if StatusCallback
  // isn't a reachable https URL, so a placeholder or http://localhost env
  // value must not take working sends down with it.
  if (/^https:\/\//i.test(cfg.webhookUrl)) form.set("StatusCallback", cfg.webhookUrl);

  const basic = Buffer.from(`${cfg.sid}:${cfg.token}`, "utf8").toString("base64");
  const ctrl  = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: ctrl.signal,
    });
    const text = await r.text().catch(() => "");
    // Twilio replies with JSON: {sid, status, error_code, message, …}
    // Parse defensively — on 4xx/5xx the body is still JSON but with error_*.
    let sid: string | null = null;
    let errCode: string | null = null;
    let errMsg:  string | null = null;
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      if (typeof j.sid === "string") sid = j.sid;
      if (j.error_code != null) errCode = String(j.error_code);
      if (typeof j.message === "string") errMsg = j.message;
    } catch { /* keep raw text */ }
    return {
      ok: r.ok && sid !== null,
      httpStatus: r.status,
      providerMessageId: sid,
      errorCode: errCode,
      errorMessage: errMsg ?? (r.ok ? null : text.slice(0, 400)),
      response: text.slice(0, 1000),
    };
  } catch (err) {
    return {
      ok: false, httpStatus: 0, providerMessageId: null,
      errorCode: "network_error",
      errorMessage: (err as Error).message.slice(0, 400),
      response: "",
    };
  } finally {
    clearTimeout(timeout);
  }
}
