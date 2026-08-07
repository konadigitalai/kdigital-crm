// Thin Gmail REST client.
//
// Mirrors the shape of ../exotel/client.ts and ../twilio/client.ts:
//   - fetch + AbortController timeout, no googleapis SDK (same policy as the
//     Twilio/Exotel side — the SDK is ~40 MB to save us six fetch calls)
//   - config read on-demand from env, never cached at import
//   - GoogleNotConfigured error class so routes can 503 clearly
//
// Auth differs from the other two providers: Gmail is per-mailbox OAuth, not
// one account-wide API key. Every call needs an access token belonging to a
// specific gmail_account row, so the token plumbing (refresh-on-expiry) lives
// here in `accessTokenFor()` rather than in a config object.

import { sql } from "drizzle-orm";
import type { DbExec } from "../twilio/inbox";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// gmail.modify = read messages + mark read/labelled. Deliberately NOT
// https://mail.google.com/ (full account access incl. permanent delete) —
// we don't need it and it's the scope most likely to fail a security review.
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "email",
];

export interface GoogleConfig {
  clientId:      string;
  clientSecret:  string;
  redirectUri:   string;
  stateSecret:   string;
  /** Fallback mailbox for advisors who haven't connected their own. */
  sharedEmail:   string;
  /** Our own domain. Threads where every participant is internal are skipped. */
  internalDomain: string;
}

export class GoogleNotConfigured extends Error {
  constructor(missing: string[]) {
    super(`Gmail not configured — missing env vars: ${missing.join(", ")}`);
    this.name = "GoogleNotConfigured";
  }
}

export function readGoogleConfig(): GoogleConfig {
  const clientId       = (process.env.GOOGLE_CLIENT_ID     ?? "").trim();
  const clientSecret   = (process.env.GOOGLE_CLIENT_SECRET ?? "").trim();
  const redirectUri    = (process.env.GOOGLE_REDIRECT_URI  ?? "").trim();
  const stateSecret    = (process.env.GOOGLE_STATE_SECRET  ?? "").trim();
  const sharedEmail    = (process.env.GMAIL_SHARED_ACCOUNT_EMAIL ?? "").trim().toLowerCase();
  const internalDomain = (process.env.GMAIL_INTERNAL_DOMAIN ?? "").trim().toLowerCase();

  const missing: string[] = [];
  if (!clientId)     missing.push("GOOGLE_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  if (!redirectUri)  missing.push("GOOGLE_REDIRECT_URI");
  if (!stateSecret)  missing.push("GOOGLE_STATE_SECRET");
  if (missing.length) throw new GoogleNotConfigured(missing);
  return { clientId, clientSecret, redirectUri, stateSecret, sharedEmail, internalDomain };
}

/** True when Gmail env is present. Lets routes/workers no-op instead of throwing. */
export function isGmailConfigured(): boolean {
  try { readGoogleConfig(); return true; } catch { return false; }
}

// ─── OAuth token exchange ────────────────────────────────────────────────

export interface TokenResponse {
  accessToken:   string;
  refreshToken:  string | null;
  expiresInSec:  number;
  scope:         string | null;
  idToken:       string | null;
}

async function postToken(form: URLSearchParams): Promise<TokenResponse> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(TOKEN_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    form.toString(),
      signal:  ctrl.signal,
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      // Google returns {error, error_description}. `invalid_grant` here means
      // the refresh token is dead (user revoked access, or changed password)
      // — callers treat that as "disconnect this account", not "retry later".
      let code = "token_error";
      try { code = (JSON.parse(text) as { error?: string }).error ?? code; } catch { /* raw */ }
      const err = new Error(`Google token exchange failed (${r.status}): ${text.slice(0, 300)}`);
      (err as Error & { googleError?: string }).googleError = code;
      throw err;
    }
    const j = JSON.parse(text) as {
      access_token: string; refresh_token?: string;
      expires_in: number; scope?: string; id_token?: string;
    };
    return {
      accessToken:  j.access_token,
      refreshToken: j.refresh_token ?? null,
      expiresInSec: j.expires_in ?? 3600,
      scope:        j.scope ?? null,
      idToken:      j.id_token ?? null,
    };
  } finally { clearTimeout(timer); }
}

/** Swap the ?code= from the consent redirect for an access + refresh token. */
export async function exchangeCode(code: string, cfg: GoogleConfig = readGoogleConfig()): Promise<TokenResponse> {
  return postToken(new URLSearchParams({
    code,
    client_id:     cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri:  cfg.redirectUri,
    grant_type:    "authorization_code",
  }));
}

/** Mint a fresh access token from a stored refresh token. */
export async function refreshAccessToken(refreshToken: string, cfg: GoogleConfig = readGoogleConfig()): Promise<TokenResponse> {
  return postToken(new URLSearchParams({
    refresh_token: refreshToken,
    client_id:     cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type:    "refresh_token",
  }));
}

/** True when the error came back from Google as a dead/revoked grant. */
export function isInvalidGrant(err: unknown): boolean {
  return (err as Error & { googleError?: string })?.googleError === "invalid_grant";
}

// ─── Access-token cache (per gmail_account row) ──────────────────────────

export interface GmailAccountRow {
  id:           string;
  email:        string;
  refreshToken: string;
  accessToken:  string | null;
  /**
   * Raw `expires_at`. Typed loosely on purpose: drizzle's node-postgres driver
   * installs its own type parsers, so a `timestamptz` read back through a raw
   * `db.execute(sql...)` arrives as a STRING, not a Date — unlike plain `pg`,
   * which would hand you a Date. Everything else in this codebase forwards
   * those values straight to JSON and never notices. Run it through
   * `expiryMs()` rather than assuming either shape.
   */
  expiresAt:    Date | string | null;
  historyId:    string | null;
  appUserId:    string | null;
  isShared:     boolean;
}

/** Epoch ms for an expires_at that may be a Date, an ISO string, or null. */
function expiryMs(v: Date | string | null): number | null {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Return a usable access token for this account, refreshing it if it expires
 * within the next 60s and persisting the new one.
 *
 * Google access tokens last an hour and the refresh token is long-lived, so
 * in steady state a 60s-tick sync worker refreshes once per hour per mailbox.
 * We store the refreshed token rather than keeping it in process memory so a
 * Render restart doesn't stampede Google's token endpoint on boot.
 */
export async function accessTokenFor(db: DbExec, account: GmailAccountRow): Promise<string> {
  const expiry = expiryMs(account.expiresAt);
  const stillValid =
    account.accessToken &&
    expiry !== null &&
    expiry - Date.now() > 60_000;
  if (stillValid) return account.accessToken!;

  const tok = await refreshAccessToken(account.refreshToken);
  const expiresAt = new Date(Date.now() + tok.expiresInSec * 1000);
  await db.execute(sql`
    UPDATE gmail_account
    SET access_token = ${tok.accessToken},
        expires_at   = ${expiresAt.toISOString()},
        updated_at   = now()
    WHERE id = ${account.id}
  `);
  // Keep the in-memory row coherent for the rest of this tick.
  account.accessToken = tok.accessToken;
  account.expiresAt   = expiresAt;
  return tok.accessToken;
}

// ─── Gmail API calls ─────────────────────────────────────────────────────

async function gmailFetch<T>(
  accessToken: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<T> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${GMAIL_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
      signal: ctrl.signal,
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      const err = new Error(`Gmail API ${path} failed (${r.status}): ${text.slice(0, 300)}`);
      (err as Error & { httpStatus?: number }).httpStatus = r.status;
      throw err;
    }
    return JSON.parse(text) as T;
  } finally { clearTimeout(timer); }
}

/** HTTP status off a thrown gmailFetch error, or 0. */
export function httpStatusOf(err: unknown): number {
  return (err as Error & { httpStatus?: number })?.httpStatus ?? 0;
}

export interface GmailProfile {
  emailAddress: string;
  historyId:    string;
}

export async function getProfile(accessToken: string): Promise<GmailProfile> {
  return gmailFetch<GmailProfile>(accessToken, "/users/me/profile");
}

// The subset of Gmail's message resource we actually read.
export interface GmailMessage {
  id:           string;
  threadId:     string;
  labelIds?:    string[];
  internalDate?: string;   // ms since epoch, as a string
  snippet?:     string;
  payload?:     GmailPart;
}

export interface GmailPart {
  partId?:   string;
  mimeType?: string;
  filename?: string;
  headers?:  { name: string; value: string }[];
  body?:     { size?: number; data?: string; attachmentId?: string };
  parts?:    GmailPart[];
}

export async function getMessage(accessToken: string, id: string): Promise<GmailMessage> {
  return gmailFetch<GmailMessage>(accessToken, `/users/me/messages/${encodeURIComponent(id)}?format=full`);
}

export interface HistoryPage {
  history?: {
    id: string;
    messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[];
  }[];
  nextPageToken?: string;
  historyId?: string;
}

/**
 * Everything that changed since `startHistoryId`.
 *
 * Throws with httpStatus 404 when startHistoryId is too old — Gmail only
 * keeps ~a week of history. Callers must handle that by re-seeding the cursor
 * from getProfile() rather than crashing.
 */
export async function listHistory(
  accessToken: string,
  startHistoryId: string,
  pageToken?: string,
): Promise<HistoryPage> {
  const q = new URLSearchParams({
    startHistoryId,
    historyTypes: "messageAdded",
  });
  if (pageToken) q.set("pageToken", pageToken);
  return gmailFetch<HistoryPage>(accessToken, `/users/me/history?${q.toString()}`);
}

export interface MessageListPage {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
}

/** Gmail search, used for the initial backfill when an account first connects. */
export async function listMessages(
  accessToken: string,
  query: string,
  maxResults = 50,
  pageToken?: string,
): Promise<MessageListPage> {
  const q = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  if (pageToken) q.set("pageToken", pageToken);
  return gmailFetch<MessageListPage>(accessToken, `/users/me/messages?${q.toString()}`);
}

/** Download one attachment's bytes. Gmail returns base64url-encoded data. */
export async function getAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const r = await gmailFetch<{ data?: string; size?: number }>(
    accessToken,
    `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    {},
    30_000,
  );
  return Buffer.from(r.data ?? "", "base64url");
}

export interface SendResult {
  ok:                boolean;
  providerMessageId: string | null;
  threadId:          string | null;
  errorCode:         string | null;
  errorMessage:      string | null;
  response:          string;
}

/**
 * Send a pre-built RFC 2822 message.
 *
 * `threadId` makes Gmail file the send into an existing thread. On its own
 * that is NOT enough for the recipient's mail client to thread it — for that
 * the raw MIME must carry In-Reply-To/References, which buildMime() does.
 * threadId only fixes threading inside OUR mailbox.
 */
export async function sendRaw(
  accessToken: string,
  rawMime: string,
  threadId?: string | null,
): Promise<SendResult> {
  try {
    const body: Record<string, string> = { raw: Buffer.from(rawMime, "utf8").toString("base64url") };
    if (threadId) body.threadId = threadId;
    const r = await gmailFetch<{ id: string; threadId: string }>(
      accessToken,
      "/users/me/messages/send",
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      },
      30_000,
    );
    return {
      ok: true,
      providerMessageId: r.id,
      threadId: r.threadId,
      errorCode: null,
      errorMessage: null,
      response: JSON.stringify(r).slice(0, 1000),
    };
  } catch (err) {
    const msg = (err as Error).message;
    return {
      ok: false,
      providerMessageId: null,
      threadId: null,
      errorCode: String(httpStatusOf(err) || "network_error"),
      errorMessage: msg.slice(0, 400),
      response: msg.slice(0, 1000),
    };
  }
}
