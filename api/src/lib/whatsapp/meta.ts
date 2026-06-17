/**
 * Meta WhatsApp Cloud API client.
 *
 * Direct integration — no BSP, no SDK. Built-ins only (fetch + node:crypto).
 *
 * Every public function takes a single options object instead of positional
 * args. Two reasons:
 *   1. Avoids "swapped accessToken / phoneNumberId" bugs that surface only
 *      at runtime as a Meta rejection.
 *   2. Makes call sites self-documenting.
 *
 * Three categories of calls:
 *   - Setup: verifyPhoneNumber, registerPhoneNumber, subscribeWaba
 *     (without /register + /subscribed_apps, inbound webhooks silently
 *     misroute to whichever app last claimed the number)
 *   - Outbound: sendText, sendTemplate
 *   - Templates: listTemplates
 *   - Webhook helpers: verifyWebhookSignature, parseWebhookPayload
 */

import crypto from "node:crypto";

export const META_API_VERSION = "v21.0";
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

// ─── Credentials ──────────────────────────────────────────────────────────

export interface MetaCreds {
  phone_number_id: string;
  waba_id: string;
  app_id: string;
  app_secret: string;
  system_user_token: string;
  webhook_verify_token: string;
}

const CRED_FIELDS = [
  "phone_number_id", "waba_id", "app_id", "app_secret",
  "system_user_token", "webhook_verify_token",
] as const;

/** Read MetaCreds out of a wa_config row's columns. Returns null if any
 *  required field is missing/empty — saves callers a six-line existence
 *  check. */
export function readMetaCreds(row: Record<string, unknown> | null | undefined): MetaCreds | null {
  if (!row) return null;
  for (const k of CRED_FIELDS) {
    const v = row[k];
    if (typeof v !== "string" || !v.length) return null;
  }
  return {
    phone_number_id:      String(row.phone_number_id),
    waba_id:              String(row.waba_id),
    app_id:               String(row.app_id),
    app_secret:           String(row.app_secret),
    system_user_token:    String(row.system_user_token),
    webhook_verify_token: String(row.webhook_verify_token),
  };
}

// ─── Setup: verify phone number ───────────────────────────────────────────

export interface VerifyPhoneNumberArgs {
  phoneNumberId: string;
  accessToken: string;
}

export interface VerifyPhoneNumberResult {
  ok: boolean;
  httpStatus: number;
  data?: {
    id: string;
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
    code_verification_status?: string;
  };
  error?: string;
}

/** GET /{phone_number_id}?fields=…
 *  Confirms the token + phone number ID are valid. Use as the first
 *  health-check after the user pastes credentials. */
export async function verifyPhoneNumber(args: VerifyPhoneNumberArgs): Promise<VerifyPhoneNumberResult> {
  const url = `${META_API_BASE}/${args.phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status`;
  const r = await metaGet(url, args.accessToken);
  return {
    ok: r.ok,
    httpStatus: r.httpStatus,
    data: r.data as VerifyPhoneNumberResult["data"],
    error: r.error,
  };
}

// ─── Setup: register phone for THIS app's webhooks ────────────────────────
//
// POST /{phone_number_id}/register subscribes the number to receive inbound
// events on this app's configured webhook URL. Requires a 6-digit PIN the
// user previously set in Meta WhatsApp Manager → Two-step verification.
// Without /register, inbound events route to whichever app last claimed
// the number (often the one that did Embedded Signup).

export interface RegisterPhoneNumberArgs {
  phoneNumberId: string;
  accessToken: string;
  pin: string;        // 6 digits
}

export interface RegisterPhoneNumberResult {
  ok: boolean;
  httpStatus: number;
  error?: string;
}

export async function registerPhoneNumber(args: RegisterPhoneNumberArgs): Promise<RegisterPhoneNumberResult> {
  const url = `${META_API_BASE}/${args.phoneNumberId}/register`;
  return await metaPost(url, args.accessToken, {
    messaging_product: "whatsapp",
    pin: args.pin,
  });
}

// ─── Setup: subscribe THIS app to the WABA ────────────────────────────────
//
// POST /{waba_id}/subscribed_apps must be called once per WABA. Idempotent
// on Meta's side — calling on every config save is cheap and safe. Without
// this, even a registered number won't deliver inbound events to our
// webhook URL.

export interface SubscribeWabaArgs {
  wabaId: string;
  accessToken: string;
}

export interface SubscribeWabaResult {
  ok: boolean;
  httpStatus: number;
  error?: string;
}

export async function subscribeWaba(args: SubscribeWabaArgs): Promise<SubscribeWabaResult> {
  const url = `${META_API_BASE}/${args.wabaId}/subscribed_apps`;
  // Body is intentionally empty — Meta infers the app from the bearer token.
  return await metaPost(url, args.accessToken, {});
}

// ─── Outbound: text (24h service window only) ────────────────────────────

export interface SendTextArgs {
  creds: MetaCreds;
  to: string;                   // E.164 with or without leading +
  body: string;
  previewUrl?: boolean;
}

export interface SendResult {
  ok: boolean;
  httpStatus: number;
  messageId?: string;           // wamid.HBgL...
  error?: string;
  errorCode?: string;
}

export async function sendText(args: SendTextArgs): Promise<SendResult> {
  const to = stripPlus(args.to);
  const url = `${META_API_BASE}/${args.creds.phone_number_id}/messages`;
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: args.body, preview_url: !!args.previewUrl },
  };
  return await metaPostMessage(url, args.creds.system_user_token, body);
}

// ─── Outbound: template ───────────────────────────────────────────────────

export interface SendTemplateArgs {
  creds: MetaCreds;
  to: string;
  templateName: string;
  language: string;             // 'en_US' | 'en' | 'hi' | ...
  variables?: string[];         // positional, fills {{1}} {{2}} ...
}

export async function sendTemplate(args: SendTemplateArgs): Promise<SendResult> {
  const to = stripPlus(args.to);
  const url = `${META_API_BASE}/${args.creds.phone_number_id}/messages`;
  const components = (args.variables ?? []).length === 0
    ? []
    : [{
        type: "body",
        parameters: (args.variables ?? []).map((v) => ({ type: "text", text: v })),
      }];
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: args.templateName,
      language: { code: args.language },
      components,
    },
  };
  return await metaPostMessage(url, args.creds.system_user_token, body);
}

// ─── Templates: list (sync) ───────────────────────────────────────────────

export interface ListTemplatesArgs {
  creds: MetaCreds;
  limit?: number;
}

export interface MetaTemplateRow {
  name: string;
  language: string;
  category: "UTILITY" | "MARKETING" | "AUTHENTICATION";
  status: "approved" | "pending" | "rejected" | "paused";
  bodyText: string;
  headerType: "text" | "image" | "video" | "document" | null;
  headerContent: string | null;
  footerText: string | null;
  buttons: unknown[] | null;     // raw component, since shape varies
  variableCount: number;
}

export interface ListTemplatesResult {
  ok: boolean;
  httpStatus: number;
  templates: MetaTemplateRow[];
  error?: string;
}

export async function listTemplates(args: ListTemplatesArgs): Promise<ListTemplatesResult> {
  const limit = args.limit ?? 200;
  const url =
    `${META_API_BASE}/${args.creds.waba_id}/message_templates` +
    `?fields=name,language,category,status,components&limit=${limit}`;
  const r = await metaGet(url, args.creds.system_user_token);
  if (!r.ok) {
    return { ok: false, httpStatus: r.httpStatus, templates: [], error: r.error };
  }
  const dataObj = r.data as { data?: unknown[] } | undefined;
  const data: unknown[] = Array.isArray(dataObj?.data) ? dataObj!.data! : [];
  const templates = data
    .map((row) => parseTemplateRow(row))
    .filter((t): t is MetaTemplateRow => t !== null);
  return { ok: true, httpStatus: r.httpStatus, templates };
}

function parseTemplateRow(raw: unknown): MetaTemplateRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name : null;
  const language = typeof r.language === "string" ? r.language : null;
  const categoryRaw = typeof r.category === "string" ? r.category.toUpperCase() : null;
  const statusRaw = typeof r.status === "string" ? r.status.toUpperCase() : null;
  if (!name || !language || !categoryRaw || !statusRaw) return null;
  if (!["UTILITY", "MARKETING", "AUTHENTICATION"].includes(categoryRaw)) return null;

  // Map Meta status (UPPERCASE) to local 4-state.
  const status =
    statusRaw === "APPROVED" ? "approved" :
    statusRaw === "REJECTED" ? "rejected" :
    statusRaw === "PAUSED"   ? "paused"   :
    "pending";

  // Walk components for header / body / footer / buttons.
  const components = Array.isArray(r.components) ? r.components as Array<Record<string, unknown>> : [];
  let bodyText = "";
  let footerText: string | null = null;
  let headerType: MetaTemplateRow["headerType"] = null;
  let headerContent: string | null = null;
  let buttons: unknown[] | null = null;

  for (const c of components) {
    const type = typeof c.type === "string" ? c.type.toUpperCase() : "";
    if (type === "BODY" && typeof c.text === "string") {
      bodyText = c.text;
    } else if (type === "FOOTER" && typeof c.text === "string") {
      footerText = c.text;
    } else if (type === "HEADER") {
      const formatRaw = typeof c.format === "string" ? c.format.toLowerCase() : "";
      if (["text", "image", "video", "document"].includes(formatRaw)) {
        headerType = formatRaw as MetaTemplateRow["headerType"];
        if (formatRaw === "text" && typeof c.text === "string") {
          headerContent = c.text;
        }
      }
    } else if (type === "BUTTONS" && Array.isArray(c.buttons)) {
      buttons = c.buttons;
    }
  }

  return {
    name, language,
    category: categoryRaw as MetaTemplateRow["category"],
    status,
    bodyText, headerType, headerContent, footerText, buttons,
    variableCount: countTemplateVariables(bodyText),
  };
}

/** Count {{N}} placeholders in a template body (max index seen). */
export function countTemplateVariables(body: string): number {
  let max = 0;
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/** Substitute {{1}} {{2}} ... in a template body with positional values. */
export function renderTemplateBody(body: string, variables: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, idx) => {
    const i = Number(idx) - 1;
    return variables[i] ?? "";
  });
}

// ─── Webhook signature verification (HMAC-SHA256) ────────────────────────

/** Verify Meta's X-Hub-Signature-256 header against the raw request body.
 *  Constant-time compare. */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  headerValue: string | null | undefined,
  appSecret: string,
): boolean {
  if (!headerValue || typeof headerValue !== "string") return false;
  if (!headerValue.startsWith("sha256=")) return false;
  const provided = headerValue.slice("sha256=".length).trim();
  if (provided.length === 0) return false;
  const buf = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = crypto.createHmac("sha256", appSecret).update(buf).digest("hex");
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── Webhook payload parser ───────────────────────────────────────────────

export interface ParsedInboundMessage {
  providerMessageId: string;
  fromPhone: string;             // E.164 with leading +
  body: string | null;
  contentType: "text" | "image" | "audio" | "video" | "document" | "interactive" | "reaction" | "location" | "unsupported";
  timestamp: number;             // unix seconds
  inReplyToProviderId?: string;
  mediaUrl?: string;             // Meta media id; downloading is a separate step
  mediaMime?: string;
}

export interface ParsedStatusUpdate {
  providerMessageId: string;
  recipientPhone: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface ParsedWebhookPayload {
  wabaId: string | null;
  phoneNumberId: string | null;
  messages: ParsedInboundMessage[];
  statuses: ParsedStatusUpdate[];
}

export function parseWebhookPayload(raw: unknown): ParsedWebhookPayload {
  const out: ParsedWebhookPayload = { wabaId: null, phoneNumberId: null, messages: [], statuses: [] };
  if (!raw || typeof raw !== "object") return out;
  const top = raw as Record<string, unknown>;
  const entries = Array.isArray(top.entry) ? top.entry as Array<Record<string, unknown>> : [];
  for (const entry of entries) {
    if (typeof entry.id === "string") out.wabaId = entry.id;
    const changes = Array.isArray(entry.changes) ? entry.changes as Array<Record<string, unknown>> : [];
    for (const change of changes) {
      const value = change.value as Record<string, unknown> | undefined;
      if (!value) continue;
      const meta = (value.metadata as Record<string, unknown> | undefined) ?? {};
      if (typeof meta.phone_number_id === "string") out.phoneNumberId = meta.phone_number_id;

      const msgs = Array.isArray(value.messages) ? value.messages : [];
      for (const m of msgs) {
        const parsed = parseMessage(m);
        if (parsed) out.messages.push(parsed);
      }
      const sts = Array.isArray(value.statuses) ? value.statuses : [];
      for (const s of sts) {
        const parsed = parseStatus(s);
        if (parsed) out.statuses.push(parsed);
      }
    }
  }
  return out;
}

function parseMessage(raw: unknown): ParsedInboundMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === "string" ? m.id : null;
  const from = typeof m.from === "string" ? m.from : null;
  const ts = typeof m.timestamp === "string" || typeof m.timestamp === "number" ? Number(m.timestamp) : null;
  const type = typeof m.type === "string" ? m.type : null;
  if (!id || !from || ts === null || !type) return null;

  let body: string | null = null;
  let contentType: ParsedInboundMessage["contentType"] = "unsupported";
  let mediaUrl: string | undefined;
  let mediaMime: string | undefined;

  if (type === "text" && m.text && typeof m.text === "object") {
    body = (m.text as Record<string, unknown>).body as string ?? null;
    contentType = "text";
  } else if (type === "image" || type === "audio" || type === "video" || type === "document") {
    contentType = type;
    const inner = m[type] as Record<string, unknown> | undefined;
    body = (inner?.caption as string | undefined) ?? null;
    if (typeof inner?.id === "string") mediaUrl = inner.id;
    if (typeof inner?.mime_type === "string") mediaMime = inner.mime_type;
  } else if (type === "interactive" && m.interactive && typeof m.interactive === "object") {
    contentType = "interactive";
    const inter = m.interactive as Record<string, unknown>;
    if (inter.type === "button_reply" && inter.button_reply && typeof inter.button_reply === "object") {
      body = ((inter.button_reply as Record<string, unknown>).title as string) ?? null;
    } else if (inter.type === "list_reply" && inter.list_reply && typeof inter.list_reply === "object") {
      body = ((inter.list_reply as Record<string, unknown>).title as string) ?? null;
    }
  } else if (type === "reaction" && m.reaction && typeof m.reaction === "object") {
    contentType = "reaction";
    body = ((m.reaction as Record<string, unknown>).emoji as string) ?? null;
  } else if (type === "location" && m.location && typeof m.location === "object") {
    contentType = "location";
    const loc = m.location as Record<string, unknown>;
    body = `${loc.latitude},${loc.longitude}`;
  }

  // Meta sends phone without leading +; we normalise to E.164.
  const fromPhone = from.startsWith("+") ? from : `+${from}`;

  let inReplyToProviderId: string | undefined;
  if (m.context && typeof m.context === "object") {
    const ctx = m.context as Record<string, unknown>;
    if (typeof ctx.id === "string") inReplyToProviderId = ctx.id;
  }

  return { providerMessageId: id, fromPhone, body, contentType, timestamp: ts, inReplyToProviderId, mediaUrl, mediaMime };
}

function parseStatus(raw: unknown): ParsedStatusUpdate | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const id = typeof s.id === "string" ? s.id : null;
  const recipient = typeof s.recipient_id === "string" ? s.recipient_id : null;
  const status = typeof s.status === "string" ? s.status : null;
  const ts = typeof s.timestamp === "string" || typeof s.timestamp === "number" ? Number(s.timestamp) : null;
  if (!id || !recipient || !status || ts === null) return null;
  if (!["sent","delivered","read","failed"].includes(status)) return null;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  if (Array.isArray(s.errors) && s.errors.length > 0) {
    const e = s.errors[0] as Record<string, unknown>;
    if (e?.code != null) errorCode = String(e.code);
    if (typeof e?.message === "string") errorMessage = e.message;
    else if (typeof e?.title === "string") errorMessage = e.title;
  }
  return {
    providerMessageId: id,
    recipientPhone: recipient.startsWith("+") ? recipient : `+${recipient}`,
    status: status as ParsedStatusUpdate["status"],
    timestamp: ts,
    errorCode, errorMessage,
  };
}

// ─── Internal HTTP helpers ────────────────────────────────────────────────
//
// All Meta calls go through these so we get consistent timeouts + error
// extraction. 10s for sends (long enough for slow international hops),
// 5s for verify (snappy UX), 15s for template list (can be hundreds).

async function metaGet(url: string, accessToken: string): Promise<{ ok: boolean; httpStatus: number; data?: unknown; error?: string }> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(url, {
      headers: { "Authorization": `Bearer ${accessToken}` },
      signal: ctrl.signal,
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      const parsed = safeJson(text);
      const err = parsed?.error;
      return {
        ok: false,
        httpStatus: r.status,
        error: typeof err?.message === "string" ? err.message.slice(0, 1000) : text.slice(0, 1000),
      };
    }
    return { ok: true, httpStatus: r.status, data: safeJson(text) };
  } catch (err) {
    return { ok: false, httpStatus: 0, error: (err as Error).message.slice(0, 1000) };
  } finally {
    clearTimeout(timeout);
  }
}

async function metaPost(url: string, accessToken: string, body: unknown): Promise<{ ok: boolean; httpStatus: number; data?: unknown; error?: string }> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      const parsed = safeJson(text);
      const err = parsed?.error;
      return {
        ok: false,
        httpStatus: r.status,
        error: typeof err?.message === "string" ? err.message.slice(0, 1000) : text.slice(0, 1000),
      };
    }
    return { ok: true, httpStatus: r.status, data: safeJson(text) };
  } catch (err) {
    return { ok: false, httpStatus: 0, error: (err as Error).message.slice(0, 1000) };
  } finally {
    clearTimeout(timeout);
  }
}

/** Like metaPost but extracts the wamid out of the success response. */
async function metaPostMessage(url: string, accessToken: string, body: unknown): Promise<SendResult> {
  const r = await metaPost(url, accessToken, body);
  if (!r.ok) {
    return {
      ok: false,
      httpStatus: r.httpStatus,
      error: r.error,
      // errorCode would need a separate parse pass; omitted for now since
      // metaPost returns the .error.message string only. Add when needed.
    };
  }
  const dataObj = r.data as { messages?: Array<{ id?: string }> } | undefined;
  const messageId = dataObj?.messages?.[0]?.id;
  return {
    ok: true,
    httpStatus: r.httpStatus,
    messageId: typeof messageId === "string" ? messageId : undefined,
  };
}

function stripPlus(phone: string): string {
  return phone.startsWith("+") ? phone.slice(1) : phone;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}
