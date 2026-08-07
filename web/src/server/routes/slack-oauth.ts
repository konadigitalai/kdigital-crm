// OAuth v2 user flow for Slack. Two endpoints:
//
//   GET  /auth/slack/authorize
//     Redirects the browser to Slack's consent screen. The current CRM
//     user is captured via a signed `state` param so we know who to
//     link when Slack calls us back. Also carries a `returnTo` URL so
//     the frontend can pop the user back to the page they came from
//     (e.g. the record page they were sharing from).
//
//   GET  /auth/slack/callback
//     Slack redirects here with ?code=… on success or ?error=… on
//     denial. We validate `state`, exchange the code for an xoxp-…
//     user token, upsert a row into slack_user_link, then 302 back
//     to the returnTo URL.
//
// Config via env:
//   SLACK_CLIENT_ID       — from api.slack.com/apps → Basic Information
//   SLACK_CLIENT_SECRET   — same page (App Credentials)
//   SLACK_REDIRECT_URI    — must EXACTLY match a URL registered in the
//                           Slack app config → OAuth & Permissions →
//                           Redirect URLs
//   SLACK_STATE_SECRET    — any long random string. Signs the state
//                           param so an attacker can't spoof callbacks.
//   WEB_APP_URL           — where to redirect the user back to when
//                           `returnTo` is missing/malformed. Fallback.

import { Router } from "@/server/http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";

// Two routers:
//   - slackOAuthCallbackRouter is PUBLIC (Slack browser redirect,
//     no auth cookies attached, security via signed state).
//   - slackOAuthRouter is AUTHENTICATED (frontend calls it from a
//     logged-in session; req.userId must exist).
export const slackOAuthCallbackRouter = Router();
export const slackOAuthRouter = Router();

// User token scopes:
//   channels:read / groups:read — list channels the user is in
//   chat:write                   — post messages as the user
//   im:write                     — open a DM to another workspace user
const USER_SCOPES = ["channels:read", "groups:read", "chat:write", "im:write"];

function cfg(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}
function optCfg(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

// Sign the state payload with HMAC so we can trust it on callback.
// Payload shape: base64({userId, tenantId, returnTo, nonce}).sig
function signState(payload: Record<string, string>): string {
  const secret = cfg("SLACK_STATE_SECRET");
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyState(state: string): Record<string, string> | null {
  const secret = cfg("SLACK_STATE_SECRET");
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  try {
    const a = Buffer.from(sig, "base64url");
    const b = Buffer.from(expected, "base64url");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return null;
    return payload as Record<string, string>;
  } catch { return null; }
}

// ── GET /auth/slack/authorize-url ──────────────────────────────────────
//
// Frontend calls this from an authenticated session to get the Slack
// consent URL, then does `window.location = url`. We can't have the
// frontend hit Slack directly because we need to sign the `state`
// payload with a secret only the API has.
//
// Requires auth — mounted BEHIND authMiddleware in index.ts.
slackOAuthRouter.get("/authorize-url", (req, res) => {
  if (!req.userId || !req.tenantId) {
    return res.status(401).json({ error: "not authenticated" });
  }
  const returnTo = String(req.query.returnTo ?? "");
  const safeReturn = /^https?:\/\/[^\s]+$/.test(returnTo) ? returnTo : optCfg("WEB_APP_URL", "http://localhost:3000");

  const state = signState({
    userId: req.userId,
    tenantId: req.tenantId,
    returnTo: safeReturn,
    nonce: randomBytes(12).toString("hex"),
  });

  const u = new URL("https://slack.com/oauth/v2/authorize");
  u.searchParams.set("client_id", cfg("SLACK_CLIENT_ID"));
  u.searchParams.set("user_scope", USER_SCOPES.join(","));
  u.searchParams.set("redirect_uri", cfg("SLACK_REDIRECT_URI"));
  u.searchParams.set("state", state);

  res.json({ url: u.toString() });
});

// ── GET /auth/slack/callback ───────────────────────────────────────────
//
// Slack redirects the browser here. NOTE: this is the Slack browser
// redirect, so the request lands WITHOUT our normal auth cookies for
// state validation — everything we need is baked into the signed
// `state` param.
slackOAuthCallbackRouter.get("/callback", async (req, res, next) => {
  try {
    const err = req.query.error;
    if (err) return oauthFail(res, `Slack denied: ${String(err)}`);

    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    if (!code || !state) return oauthFail(res, "missing code or state");

    const payload = verifyState(state);
    if (!payload) return oauthFail(res, "state signature invalid");
    const { userId, tenantId, returnTo } = payload;
    if (!userId || !tenantId) return oauthFail(res, "state payload malformed");

    // Exchange the code for a user token. Slack takes the exchange over
    // POST with form-encoded body.
    const form = new URLSearchParams({
      client_id: cfg("SLACK_CLIENT_ID"),
      client_secret: cfg("SLACK_CLIENT_SECRET"),
      code,
      redirect_uri: cfg("SLACK_REDIRECT_URI"),
    });
    const r = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const body = await r.json() as {
      ok: boolean;
      error?: string;
      authed_user?: {
        id: string;
        scope: string;
        access_token: string;  // xoxp-…
      };
      team?: { id: string };
    };
    if (!body.ok) return oauthFail(res, `Slack token exchange failed: ${body.error ?? "unknown"}`);
    if (!body.authed_user?.access_token) return oauthFail(res, "Slack returned no user token");

    // Upsert. One link per app_user (unique index handles it).
    await withTenant(tenantId, async (db) => {
      await db.execute(sql`
        INSERT INTO slack_user_link
          (tenant_id, app_user_id, slack_user_id, slack_team_id, user_token, scopes, connected_at, revoked_at)
        VALUES (
          ${tenantId}, ${userId},
          ${body.authed_user!.id},
          ${body.team?.id ?? null},
          ${body.authed_user!.access_token},
          ${body.authed_user!.scope ?? null},
          NOW(), NULL
        )
        ON CONFLICT (app_user_id) DO UPDATE
          SET tenant_id     = EXCLUDED.tenant_id,
              slack_user_id = EXCLUDED.slack_user_id,
              slack_team_id = EXCLUDED.slack_team_id,
              user_token    = EXCLUDED.user_token,
              scopes        = EXCLUDED.scopes,
              connected_at  = NOW(),
              revoked_at    = NULL,
              updated_at    = NOW()
      `);
    });

    // Success — hop back to whatever page kicked off the flow. Append a
    // ?slackConnected=1 marker so the frontend can show a toast. The
    // fallback to WEB_APP_URL should never fire in practice (authorize-url
    // always fills returnTo), but keeps TypeScript happy about optional
    // Record<string,string> properties.
    const safeReturn = returnTo || optCfg("WEB_APP_URL", "http://localhost:3000");
    const target = new URL(safeReturn);
    target.searchParams.set("slackConnected", "1");
    res.redirect(target.toString());
  } catch (e) { next(e); }
});

// ── POST /auth/slack/disconnect ────────────────────────────────────────
//
// Blow away the user's link. We DON'T call Slack's auth.revoke here —
// removing the row is enough for our purposes, and calling Slack risks
// revoking a token the user is also using in some other tool. The user
// can revoke on Slack's side manually if they want.
slackOAuthRouter.post("/disconnect", async (req, res, next) => {
  try {
    if (!req.userId || !req.tenantId) return res.status(401).json({ error: "not authenticated" });
    await withTenant(req.tenantId, async (db) => {
      await db.execute(sql`
        DELETE FROM slack_user_link WHERE app_user_id = ${req.userId}
      `);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Small helper: render an HTML "error" page rather than dumping JSON,
// because this is a browser redirect target — the user is looking at
// the response in a browser tab.
function oauthFail(res: import("@/server/http").ApiResponse, message: string) {
  res.status(400).send(`<!doctype html><html><body style="font:14px system-ui;padding:2em">
    <h2>Slack connection failed</h2>
    <p>${escapeHtml(message)}</p>
    <p><a href="javascript:history.back()">← Go back</a></p>
  </body></html>`);
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
