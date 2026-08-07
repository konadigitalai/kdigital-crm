// Twilio Content API client — thin fetch wrapper for WhatsApp templates.
//
// Twilio's Content Builder is the source of truth for template SID, body,
// type block, and Meta approval status. This module talks to
// https://content.twilio.com/v1/Content and *only* that; it does not touch
// our DB. The route layer (routes/templates.ts) owns caching those results
// into wa_template.
//
// Auth: Twilio Basic auth (account SID + auth token) — same creds used
// everywhere else. We read them via readTwilioAuthToken/readTwilioConfig
// so a missing TWILIO_AUTH_TOKEN produces the same error path as sends.

import { readTwilioConfig, TwilioNotConfigured } from "./client";

const CONTENT_BASE = "https://content.twilio.com/v1";
const REQ_TIMEOUT_MS = 10_000;

// ─── Types ────────────────────────────────────────────────────────────────

/** A Twilio Content Builder template as we care about it. */
export interface TwilioTemplate {
  sid:            string;   // "HX…"
  friendlyName:   string;
  language:       string | null;
  /** Twilio's type block. First key is the actual type (e.g.
   *  "twilio/text", "twilio/quick-reply", "twilio/media"). Values inside
   *  contain the body string with `{{variable_name}}` placeholders. */
  types:          Record<string, unknown>;
  /** Sample variable values Twilio stores for preview — key = placeholder,
   *  value = sample. Used to derive the variable schema for our UI. */
  variables:      Record<string, string>;
  dateCreated:    string;
  dateUpdated:    string;
}

/** Meta approval status snapshot for a single template. */
export interface TwilioApproval {
  /** Twilio's enum: "unsubmitted" | "submitted" | "approved" | "rejected" | "paused". */
  status:            string;
  category:          string;
  rejectionReason:   string | null;
  contentType:       string | null;
  name:              string | null;
}

/** Input for POST /Content. Matches Twilio's create-content schema. */
export interface CreateTemplateInput {
  friendly_name:  string;
  language:       string;                  // "en", "en_US", "hi", …
  variables?:     Record<string, string>;  // sample values by placeholder
  types:          Record<string, unknown>; // one of Twilio's type blocks
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function basicAuthHeader(): string {
  const cfg = readTwilioConfig(); // throws TwilioNotConfigured
  const basic = Buffer.from(`${cfg.sid}:${cfg.token}`, "utf8").toString("base64");
  return `Basic ${basic}`;
}

async function twilioFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    return await fetch(`${CONTENT_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: basicAuthHeader(),
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function toTwilioTemplate(raw: Record<string, unknown>): TwilioTemplate {
  return {
    sid:          String(raw.sid ?? ""),
    friendlyName: String(raw.friendly_name ?? ""),
    language:     typeof raw.language === "string" ? raw.language : null,
    types:        (raw.types as Record<string, unknown>) ?? {},
    variables:    (raw.variables as Record<string, string>) ?? {},
    dateCreated:  String(raw.date_created ?? ""),
    dateUpdated:  String(raw.date_updated ?? ""),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * List every template on the Twilio account. Handles pagination transparently
 * (Twilio caps PageSize at 100). Returns [] on transient failure so the caller
 * can decide whether to reuse the DB cache.
 */
export async function listTemplates(): Promise<TwilioTemplate[]> {
  const out: TwilioTemplate[] = [];
  let pageUrl: string | null = `/Content?PageSize=100`;
  while (pageUrl) {
    const r: Response = await twilioFetch(pageUrl);
    if (!r.ok) {
      throw new Error(`content.twilio.com list failed: HTTP ${r.status} ${await r.text().catch(() => "")}`);
    }
    const j = (await r.json()) as {
      contents?: Array<Record<string, unknown>>;
      meta?: { next_page_url?: string | null };
    };
    for (const raw of j.contents ?? []) out.push(toTwilioTemplate(raw));
    const next = j.meta?.next_page_url ?? null;
    // Twilio returns absolute URLs; strip the base so twilioFetch handles it.
    pageUrl = next ? next.replace(CONTENT_BASE, "") : null;
  }
  return out;
}

/** Fetch a single template by SID. Returns null on 404. */
export async function fetchTemplate(contentSid: string): Promise<TwilioTemplate | null> {
  const r = await twilioFetch(`/Content/${encodeURIComponent(contentSid)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`content.twilio.com fetch failed: HTTP ${r.status}`);
  return toTwilioTemplate(await r.json() as Record<string, unknown>);
}

/**
 * Fetch the WhatsApp approval status for a template. Returns "unknown"
 * shape if Twilio omits the whatsapp block (e.g. brand-new template).
 */
export async function fetchApproval(contentSid: string): Promise<TwilioApproval> {
  const r = await twilioFetch(
    `/Content/${encodeURIComponent(contentSid)}/ApprovalRequests`,
  );
  if (!r.ok) {
    return {
      status: "unknown", category: "", rejectionReason: null,
      contentType: null, name: null,
    };
  }
  const j = (await r.json()) as { whatsapp?: Record<string, unknown> };
  const w = j.whatsapp ?? {};
  return {
    status:          typeof w.status === "string" ? w.status : "unknown",
    category:        typeof w.category === "string" ? w.category : "",
    rejectionReason: typeof w.rejection_reason === "string" && w.rejection_reason
                       ? w.rejection_reason : null,
    contentType:     typeof w.content_type === "string" ? w.content_type : null,
    name:            typeof w.name === "string" ? w.name : null,
  };
}

/**
 * Create a new template on Twilio. The template starts life on Twilio
 * only; submitting for Meta approval is a separate call.
 */
export async function createTemplate(input: CreateTemplateInput): Promise<TwilioTemplate> {
  const r = await twilioFetch(`/Content`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    throw new Error(`content.twilio.com create failed: HTTP ${r.status} ${await r.text().catch(() => "")}`);
  }
  return toTwilioTemplate(await r.json() as Record<string, unknown>);
}

/**
 * Submit an existing template for Meta WhatsApp approval. `category` must
 * be one of Meta's business categories: MARKETING / UTILITY / AUTHENTICATION.
 * `name` is the sender-visible name Meta will display in the WhatsApp Manager.
 */
export async function submitForApproval(
  contentSid: string,
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION",
  name: string,
): Promise<TwilioApproval> {
  const r = await twilioFetch(
    `/Content/${encodeURIComponent(contentSid)}/ApprovalRequests/whatsapp`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, category }),
    },
  );
  if (!r.ok) {
    throw new Error(`content.twilio.com submit failed: HTTP ${r.status} ${await r.text().catch(() => "")}`);
  }
  // Twilio returns the approval object shape; parse via fetchApproval's
  // normalisation for consistency.
  const j = (await r.json()) as { whatsapp?: Record<string, unknown> };
  const w = j.whatsapp ?? {};
  return {
    status:          typeof w.status === "string" ? w.status : "unknown",
    category:        typeof w.category === "string" ? w.category : category,
    rejectionReason: typeof w.rejection_reason === "string" && w.rejection_reason
                       ? w.rejection_reason : null,
    contentType:     typeof w.content_type === "string" ? w.content_type : null,
    name:            typeof w.name === "string" ? w.name : name,
  };
}

/**
 * Extract placeholder names from a template's type block. Twilio uses
 * `{{name}}` (Meta 1.x) *or* `{{1}}` (Meta 2.x). Both are supported and
 * merged; deduped. Order preserved by first-seen.
 *
 * We also fall back to Object.keys(variables) which contains Twilio's
 * sample values keyed by placeholder — that's authoritative for pre-existing
 * templates even if we can't parse every custom type block.
 */
export function extractVariableNames(tpl: TwilioTemplate): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  // Walk the type block and grab every `{{...}}` from any string leaf.
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      const re = /\{\{\s*([^}]+?)\s*\}\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(node)) !== null) {
        if (m[1]) push(m[1]);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const el of node) walk(el);
      return;
    }
    if (node && typeof node === "object") {
      for (const v of Object.values(node)) walk(v);
    }
  };
  walk(tpl.types);

  // Add anything from Twilio's sample-values map we didn't already catch.
  for (const k of Object.keys(tpl.variables ?? {})) push(k);

  return out;
}
