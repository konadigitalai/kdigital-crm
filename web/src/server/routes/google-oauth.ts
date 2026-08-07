// OAuth flow for connecting a Gmail mailbox. Structurally identical to
// routes/slack-oauth.ts — same signed-state trick, same public-callback split:
//
//   GET  /auth/google/authorize-url   (authenticated) → the consent URL
//   GET  /auth/google/callback        (PUBLIC)        → Google redirects here
//   GET  /auth/google/status          (authenticated) → is this user connected?
//   POST /auth/google/disconnect      (authenticated)
//
// The callback is public because Google redirects the user's BROWSER to it,
// and that hop carries no Authorization header. Trust comes entirely from the
// HMAC-signed `state` we handed Google on the way out — same as Slack.
//
// Config: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI /
// GOOGLE_STATE_SECRET / GMAIL_SHARED_ACCOUNT_EMAIL / GMAIL_INTERNAL_DOMAIN.

import { Router } from "@/server/http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";
import {
  readGoogleConfig, GoogleNotConfigured, exchangeCode, getProfile,
  GMAIL_SCOPES, type GoogleConfig,
} from "../lib/gmail/client";

export const googleOAuthCallbackRouter = Router();  // public
export const googleOAuthRouter = Router();          // behind authMiddleware

function optCfg(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function signState(payload: Record<string, string>, cfg: GoogleConfig): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig  = createHmac("sha256", cfg.stateSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyState(state: string, cfg: GoogleConfig): Record<string, string> | null {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", cfg.stateSecret).update(body).digest("base64url");
  try {
    const a = Buffer.from(sig, "base64url");
    const b = Buffer.from(expected, "base64url");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return null;
    return payload as Record<string, string>;
  } catch { return null; }
}

// ── GET /auth/google/authorize-url ────────────────────────────────────────
googleOAuthRouter.get("/authorize-url", (req, res) => {
  if (!req.userId || !req.tenantId) {
    return res.status(401).json({ error: "not authenticated" });
  }
  let cfg: GoogleConfig;
  try { cfg = readGoogleConfig(); }
  catch (err) {
    if (err instanceof GoogleNotConfigured) {
      return res.status(503).json({ error: err.message, code: "gmail_not_configured" });
    }
    throw err;
  }

  const returnTo = String(req.query.returnTo ?? "");
  const safeReturn = /^https?:\/\/[^\s]+$/.test(returnTo)
    ? returnTo
    : optCfg("WEB_APP_URL", "http://localhost:3000");

  // Whether this mailbox's email is shared with the whole workspace. Default
  // shared ("1"); the connect UI lets the user opt out to private ("0"). Baked
  // into the signed state so the callback can trust it.
  const shared = req.query.shared === "0" ? "0" : "1";

  const state = signState({
    userId:   req.userId,
    tenantId: req.tenantId,
    returnTo: safeReturn,
    shared,
    nonce:    randomBytes(12).toString("hex"),
  }, cfg);

  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id",     cfg.clientId);
  u.searchParams.set("redirect_uri",  cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope",         GMAIL_SCOPES.join(" "));
  // offline + consent is what actually yields a refresh_token. Without
  // access_type=offline Google returns an access token that dies in an hour
  // and cannot be renewed; without prompt=consent it withholds the refresh
  // token on every re-authorization after the first, which silently breaks
  // reconnects.
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt",      "consent");
  // Hint (not a guarantee) that we want a Workspace account on our domain.
  // The real enforcement is the domain check in the callback below.
  if (cfg.internalDomain) u.searchParams.set("hd", cfg.internalDomain);
  u.searchParams.set("state", state);

  res.json({ url: u.toString() });
});

// ── GET /auth/google/callback ─────────────────────────────────────────────
googleOAuthCallbackRouter.get("/callback", async (req, res, next) => {
  try {
    const err = req.query.error;
    if (err) return oauthFail(res, `Google denied the request: ${String(err)}`);

    let cfg: GoogleConfig;
    try { cfg = readGoogleConfig(); }
    catch (e) { return oauthFail(res, (e as Error).message); }

    const code  = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    if (!code || !state) return oauthFail(res, "missing code or state");

    const payload = verifyState(state, cfg);
    if (!payload) return oauthFail(res, "state signature invalid");
    const { userId, tenantId, returnTo } = payload;
    if (!userId || !tenantId) return oauthFail(res, "state payload malformed");
    // The user's share choice from the connect screen (default shared).
    const chosenShared = payload.shared !== "0";

    const tok = await exchangeCode(code, cfg);
    if (!tok.refreshToken) {
      // Google withholds the refresh token when the user has an existing grant
      // and we didn't force prompt=consent. We do force it, so landing here
      // means something upstream stripped the param.
      return oauthFail(res, "Google returned no refresh token. Revoke access at myaccount.google.com/permissions and try again.");
    }

    const profile = await getProfile(tok.accessToken);
    const email = profile.emailAddress.toLowerCase();

    // Refuse mailboxes outside our own Workspace. The `hd` param above is only
    // a UI hint — a user can still pick a personal account on the consent
    // screen, and we do NOT want someone's private Gmail syncing into the CRM.
    if (cfg.internalDomain && !email.endsWith(`@${cfg.internalDomain}`)) {
      return oauthFail(res,
        `${email} is not a ${cfg.internalDomain} account. Connect your work Google account instead.`);
    }

    // The connector always OWNS their mailbox row (app_user_id = them) so they
    // can disconnect it — independent of whether it's shared. `is_shared` is the
    // user's choice, but the env shared mailbox is always forced shared.
    const isShared  = chosenShared || (!!cfg.sharedEmail && email === cfg.sharedEmail);
    const expiresAt = new Date(Date.now() + tok.expiresInSec * 1000);

    await withTenant(tenantId, async (db) => {
      // If this user previously connected a DIFFERENT mailbox, retire that row
      // rather than deleting it — tw_message rows point at it for attachment
      // fetches, and ON DELETE SET NULL would orphan them.
      await db.execute(sql`
        UPDATE gmail_account
        SET app_user_id = NULL, revoked_at = now(), updated_at = now()
        WHERE app_user_id = ${userId} AND lower(email) <> ${email}
      `);
      await db.execute(sql`
        INSERT INTO gmail_account (
          tenant_id, app_user_id, email, refresh_token, access_token,
          expires_at, scopes, is_shared, connected_at, revoked_at,
          sync_error_count, sync_error
        )
        VALUES (
          ${tenantId}, ${userId}, ${email},
          ${tok.refreshToken}, ${tok.accessToken},
          ${expiresAt.toISOString()}, ${tok.scope}, ${isShared},
          now(), NULL, 0, NULL
        )
        ON CONFLICT (tenant_id, lower(email)) DO UPDATE
          SET app_user_id      = EXCLUDED.app_user_id,
              refresh_token    = EXCLUDED.refresh_token,
              access_token     = EXCLUDED.access_token,
              expires_at       = EXCLUDED.expires_at,
              scopes           = EXCLUDED.scopes,
              is_shared        = EXCLUDED.is_shared,
              connected_at     = now(),
              revoked_at       = NULL,
              sync_error_count = 0,
              sync_error       = NULL,
              updated_at       = now()
      `);
    });

    const safeReturn = returnTo || optCfg("WEB_APP_URL", "http://localhost:3000");
    const target = new URL(safeReturn);
    target.searchParams.set("gmailConnected", "1");
    res.redirect(target.toString());
  } catch (e) { next(e); }
});

// ── GET /auth/google/status ───────────────────────────────────────────────
// Drives the "Connect Gmail" button. Reports the caller's own mailbox plus
// whether a shared fallback exists, so the UI can say what a send would use.
googleOAuthRouter.get("/status", async (req, res, next) => {
  try {
    if (!req.userId || !req.tenantId) return res.status(401).json({ error: "not authenticated" });
    let configured = true;
    let sharedEmail = "";
    try { sharedEmail = readGoogleConfig().sharedEmail; }
    catch { configured = false; }

    const out = await withTenant(req.tenantId, async (db) => {
      const mine = await db.execute(sql`
        SELECT email, connected_at AS "connectedAt", revoked_at AS "revokedAt",
               last_synced_at AS "lastSyncedAt", sync_error AS "syncError",
               is_shared AS "isShared"
        FROM gmail_account
        WHERE app_user_id = ${req.userId} AND revoked_at IS NULL
        LIMIT 1
      `);
      const shared = await db.execute(sql`
        SELECT email FROM gmail_account
        WHERE is_shared = true AND revoked_at IS NULL
        LIMIT 1
      `);
      return {
        connected: mine.rows.length > 0,
        account:   mine.rows[0] ?? null,
        shared:    (shared.rows[0] as { email: string } | undefined)?.email ?? null,
      };
    });

    res.json({ ...out, configured, sharedEmailConfigured: sharedEmail || null });
  } catch (e) { next(e); }
});

// ── POST /auth/google/disconnect ──────────────────────────────────────────
// Retire the link, don't delete it — tw_message rows reference gmail_account
// for attachment fetches. Revoked accounts stop being polled by the worker.
// We deliberately don't call Google's revoke endpoint: the user may have
// granted the same app elsewhere, and revoking is theirs to do at
// myaccount.google.com/permissions.
googleOAuthRouter.post("/disconnect", async (req, res, next) => {
  try {
    if (!req.userId || !req.tenantId) return res.status(401).json({ error: "not authenticated" });
    await withTenant(req.tenantId, async (db) => {
      await db.execute(sql`
        UPDATE gmail_account
        SET revoked_at = now(), app_user_id = NULL, updated_at = now()
        WHERE app_user_id = ${req.userId}
      `);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

function oauthFail(res: import("@/server/http").ApiResponse, message: string) {
  res.status(400).send(`<!doctype html><html><body style="font:14px system-ui;padding:2em">
    <h2>Gmail connection failed</h2>
    <p>${escapeHtml(message)}</p>
    <p><a href="javascript:history.back()">← Go back</a></p>
  </body></html>`);
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
