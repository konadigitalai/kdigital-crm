// Thin Exotel REST client.
//
// Mirrors the shape of ../twilio/client.ts:
//   - fetch + AbortController timeout
//   - config read on-demand from env (not cached at import) so ops can
//     rotate credentials without a restart in every case
//   - ExotelNotConfigured error class so route handlers can 503 clearly
//   - never imports the Twilio SDK — same policy as the Twilio side
//
// Auth: Basic auth with (API_KEY, API_TOKEN). Note that Exotel's "API_KEY"
// is NOT the same as the account SID; both live in Exotel Console under
// Settings → API. SID is a separate value used only in the URL path.

import { toE164 } from "../twilio/phone";

export interface ExotelConfig {
  sid:                   string;   // Account SID, e.g. "digitaledify1"
  apiKey:                string;   // Basic-auth username
  apiToken:              string;   // Basic-auth password
  subdomain:             string;   // "api.in.exotel.com" | "api.exotel.com"
  virtualNumber:         string;   // ExoPhone in E.164, e.g. "+918047185XXX"
  webhookBaseUrl:        string;   // https://…/webhooks/exotel — used to build per-call StatusCallback URLs
  /** Optional: shared "call desk" number Exotel dials when the advisor
   *  making the click-to-call request has no phone on file. Empty = flow
   *  is disabled, request will 400 with "advisor has no phone". */
  fallbackAgentNumber:   string;
  /** Optional: comma-separated CIDR list Exotel is allowed to POST from.
   *  Empty in dev to skip the check; the webhook route enforces this if
   *  present. */
  allowedIps:            string;
}

export class ExotelNotConfigured extends Error {
  constructor(missing: string[]) {
    super(`Exotel not configured — missing env vars: ${missing.join(", ")}`);
    this.name = "ExotelNotConfigured";
  }
}

export function readExotelConfig(): ExotelConfig {
  const sid                 = (process.env.EXOTEL_SID              ?? "").trim();
  const apiKey              = (process.env.EXOTEL_API_KEY          ?? "").trim();
  const apiToken            = (process.env.EXOTEL_API_TOKEN        ?? "").trim();
  const subdomain           = (process.env.EXOTEL_SUBDOMAIN        ?? "api.in.exotel.com").trim();
  const virtualNumber       = toE164(process.env.EXOTEL_VIRTUAL_NUMBER ?? "");
  const webhookBaseUrl      = (process.env.EXOTEL_WEBHOOK_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const fallbackAgentNumber = toE164(process.env.EXOTEL_FALLBACK_AGENT_NUMBER ?? "");
  const allowedIps          = (process.env.EXOTEL_ALLOWED_IPS      ?? "").trim();

  const missing: string[] = [];
  if (!sid)            missing.push("EXOTEL_SID");
  if (!apiKey)         missing.push("EXOTEL_API_KEY");
  if (!apiToken)       missing.push("EXOTEL_API_TOKEN");
  if (!virtualNumber)  missing.push("EXOTEL_VIRTUAL_NUMBER");
  if (!webhookBaseUrl) missing.push("EXOTEL_WEBHOOK_BASE_URL");
  if (missing.length) throw new ExotelNotConfigured(missing);
  return { sid, apiKey, apiToken, subdomain, virtualNumber, webhookBaseUrl, fallbackAgentNumber, allowedIps };
}

/** Return the API-key / token pair without failing if send-side vars are
 *  unset. Used by the media proxy for Basic-auth recording playback. */
export function readExotelBasicAuth(): { user: string; pass: string } | null {
  const user = (process.env.EXOTEL_API_KEY   ?? "").trim();
  const pass = (process.env.EXOTEL_API_TOKEN ?? "").trim();
  return user && pass ? { user, pass } : null;
}

// ─── fetchCallDetails ────────────────────────────────────────────────────

/** Result shape of GET /v1/Accounts/<sid>/Calls/<CallSid>.json. Only the
 *  fields we actually consume are typed. */
export interface CallDetails {
  callSid:          string;
  status:           string | null;
  duration:         number | null;   // seconds
  recordingUrl:     string | null;
  from:             string | null;
  to:               string | null;
  startTime:        string | null;
  endTime:          string | null;
}

/**
 * Fetch a single call's details from Exotel. Used by the Passthru terminal
 * event handler to attach the recording URL, since Passthru itself fires
 * before Exotel finishes processing the recording — the URL only appears
 * on the Call Details endpoint (typically 3-10 minutes after call end).
 */
export async function fetchCallDetails(
  callSid: string,
  cfg: ExotelConfig = readExotelConfig(),
): Promise<CallDetails | null> {
  const url = `https://${cfg.subdomain}/v1/Accounts/${encodeURIComponent(cfg.sid)}/Calls/${encodeURIComponent(callSid)}.json`;
  const basic = Buffer.from(`${cfg.apiKey}:${cfg.apiToken}`, "utf8").toString("base64");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (r.status === 404) return null;
    if (!r.ok) return null;
    const text = await r.text().catch(() => "");
    const j = JSON.parse(text) as { Call?: Record<string, unknown> };
    const c = j.Call ?? {};
    const rec = String(c.RecordingUrl ?? "").trim();
    return {
      callSid,
      status:       c.Status       ? String(c.Status)       : null,
      duration:     c.Duration     ? Number(c.Duration)     : null,
      recordingUrl: rec && rec.toLowerCase() !== "null" ? rec : null,
      from:         c.From         ? String(c.From)         : null,
      to:           c.To           ? String(c.To)           : null,
      startTime:    c.StartTime    ? String(c.StartTime)    : null,
      endTime:      c.EndTime      ? String(c.EndTime)      : null,
    };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// ─── initiateCall ────────────────────────────────────────────────────────

export interface InitiateCallInput {
  /** E.164 — Exotel calls this first (the advisor's phone). */
  agentPhone:         string;
  /** E.164 — connected to `agentPhone` once the agent picks up. */
  customerPhone:      string;
  /** Optional metadata (up to 128 chars). We stuff the lead work_item_id
   *  here so terminal callbacks can attach to the right activity trail. */
  customField?:       string;
  /** Record the leg audio to Exotel's CDN. */
  record?:            boolean;
}

export interface InitiateCallResult {
  ok:          boolean;
  httpStatus:  number;
  callSid:     string | null;
  errorCode:   string | null;
  errorMessage:string | null;
  /** First 1000 chars of the response body — kept for debug logging. */
  response:    string;
}

/**
 * POST /v1/Accounts/<sid>/Calls/connect with Basic auth.
 *
 * Exotel's docs specify: "The platform calls the `From` number first, and
 * once they answer, the `To` number is dialed and connected." So agent goes
 * in `From`, customer in `To`. `CallerId` is our ExoPhone.
 */
export async function initiateCall(
  input: InitiateCallInput,
  cfg: ExotelConfig = readExotelConfig(),
): Promise<InitiateCallResult> {
  const url = `https://${cfg.subdomain}/v1/Accounts/${encodeURIComponent(cfg.sid)}/Calls/connect`;
  const statusCallback = `${cfg.webhookBaseUrl}/status`;

  const form = new URLSearchParams();
  form.set("From",       input.agentPhone);
  form.set("To",         input.customerPhone);
  form.set("CallerId",   cfg.virtualNumber);
  form.set("CallType",   "trans");
  form.set("TimeLimit",  "1800");         // 30 min max — safety cap
  form.set("TimeOut",    "30");
  form.set("StatusCallback",             statusCallback);
  form.set("StatusCallbackContentType",  "application/json");
  form.append("StatusCallbackEvents",    "terminal");
  form.append("StatusCallbackEvents",    "answered");
  if (input.record !== false) form.set("Record", "true");
  if (input.customField) form.set("CustomField", input.customField.slice(0, 128));

  const basic = Buffer.from(`${cfg.apiKey}:${cfg.apiToken}`, "utf8").toString("base64");
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
      signal: ctrl.signal,
    });
    const text = await r.text().catch(() => "");
    let callSid: string | null = null;
    let errCode: string | null = null;
    let errMsg:  string | null = null;
    try {
      const j = JSON.parse(text) as {
        Call?: { Sid?: string };
        Response?: unknown;
        RestException?: { Message?: string; Code?: string };
      };
      if (j.Call?.Sid) callSid = j.Call.Sid;
      if (j.RestException) {
        errCode = j.RestException.Code ?? null;
        errMsg  = j.RestException.Message ?? null;
      }
    } catch { /* keep raw text */ }
    return {
      ok:            r.ok && callSid !== null,
      httpStatus:    r.status,
      callSid,
      errorCode:     errCode,
      errorMessage:  errMsg ?? (r.ok ? null : text.slice(0, 400)),
      response:      text.slice(0, 1000),
    };
  } catch (err) {
    return {
      ok: false, httpStatus: 0, callSid: null,
      errorCode: "network_error",
      errorMessage: (err as Error).message.slice(0, 400),
      response: "",
    };
  } finally {
    clearTimeout(timer);
  }
}
