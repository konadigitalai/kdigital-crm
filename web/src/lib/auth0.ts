// Auth0 SDK singleton. The Next.js middleware + Server Components +
// API-call helpers all read this. Env vars come from web/.env.local
// locally and from Vercel's project settings in dev/qa/prod.
//
// The SDK manages encrypted session cookies, refresh-token rotation, and
// auto-mounts the /auth/login, /auth/logout, /auth/callback, /auth/profile,
// /auth/access-token routes when middleware runs.

import { Auth0Client } from "@auth0/nextjs-auth0/server";

export const auth0 = new Auth0Client({
  // The SDK auto-derives these from AUTH0_* env vars but we pass them
  // explicitly so a missing env var fails fast with a helpful message
  // rather than producing an opaque "issuer mismatch" at first request.
  domain: requireEnv("AUTH0_DOMAIN"),
  clientId: requireEnv("AUTH0_CLIENT_ID"),
  clientSecret: requireEnv("AUTH0_CLIENT_SECRET"),
  secret: requireEnv("AUTH0_SECRET"),
  appBaseUrl: requireEnv("APP_BASE_URL"),

  // Ask Auth0 for an access token scoped to our API. Without this,
  // tokens come back unsigned for an arbitrary audience and our backend
  // rejects them. The audience string MUST match the API Identifier we
  // configured in Auth0 → Applications → APIs → Edify CRM API.
  authorizationParameters: {
    audience: requireEnv("AUTH0_AUDIENCE"),
    // Request access + profile + email so we can mirror the user into
    // app_user during JIT provisioning on the backend side.
    scope: "openid profile email offline_access",
  },
});

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Env var ${name} is required (set in web/.env.local)`);
  }
  return v.trim();
}
