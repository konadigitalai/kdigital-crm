// Resolve the current request's user from an Auth0 access token.
//
// Flow per request:
//   1. Read the `Authorization: Bearer <jwt>` header.
//   2. Verify the JWT against Auth0's JWKS (issuer + audience + signature
//      + expiry). Returns 401 on any failure.
//   3. JIT-provision: if no `app_user` row exists for this Auth0 `sub`,
//      create one in the default tenant using `email`/`name` from the token.
//   4. Attach { userId, tenantId, user, permissions } to req for downstream
//      handlers. Permissions come straight from the JWT claim — no DB join.
//
// This replaces the previous cookie-session middleware. The `decrm_session`
// cookie, the `session` table, and bcrypt hashes are no longer involved.

import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { appPool } from "../db/app.js";
import { provisionPartyForInternalUser } from "../lib/party/provision.js";

declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      userId?: string;
      user?: {
        id: string;
        tenantId: string;
        email: string;
        name: string | null;
        role: string;
        active: boolean;
      };
      permissions?: Set<string>;
    }
  }
}

// ─── Env-driven config ──────────────────────────────────────────────────────

const AUTH0_DOMAIN   = required("AUTH0_DOMAIN");
const AUTH0_AUDIENCE = required("AUTH0_AUDIENCE");
const PERMISSIONS_CLAIM =
  process.env.AUTH0_PERMISSIONS_CLAIM?.trim() ||
  "https://digitaledify.com/permissions";

const ISSUER = `https://${AUTH0_DOMAIN}/`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}.well-known/jwks.json`));

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Env var ${name} is required (set in api/.env)`);
  }
  return v.trim();
}

// ─── JIT user provisioning ──────────────────────────────────────────────────

/**
 * Find or create the `app_user` row mirroring this Auth0 subject. Uses the
 * single default tenant: env override `DEFAULT_TENANT_ID` takes priority,
 * otherwise the most-recently-created tenant in the DB is used. (We don't
 * support multi-tenant yet; when we do, this resolves from an org claim.)
 *
 * Returns null if no tenant exists at all — that's a config error worth
 * surfacing as 503 rather than silently creating one mid-request.
 */
async function provisionUser(claims: JWTPayload): Promise<NonNullable<Request["user"]> | null> {
  const sub = String(claims.sub ?? "").trim();
  if (!sub) return null;

  // Pull display fields from the token. Auth0 may surface them as standard
  // OIDC claims (email, name) or namespaced (set by the post-login Action)
  // — try both. If neither is set we'll fall back to a placeholder email
  // keyed off the Auth0 sub, so a misconfigured Action doesn't lock
  // everyone out. (The operator can fix the email later; the placeholder
  // still satisfies the app_user_tenant_email_key constraint.)
  const rawEmail = String(
    claims.email ?? claims["https://digitaledify.com/email"] ?? "",
  ).trim();
  const placeholderEmail = `${sub.replace(/[^a-zA-Z0-9._-]/g, "_")}@auth0.local`;
  const email = rawEmail || placeholderEmail;
  const name = String(
    claims.name ?? claims["https://digitaledify.com/name"] ?? "",
  ).trim() || null;
  if (!rawEmail) {
    console.warn(
      `[auth] Provisioning Auth0 user ${sub} with placeholder email ${email}. ` +
      `Update the Auth0 post-login Action to copy event.user.email into a ` +
      `'https://digitaledify.com/email' claim on the access token.`,
    );
  }

  // 1. Existing row keyed by Auth0 sub? Self-heal: if the token now has a
  // real email/name and the row is still on the placeholder (or has a
  // stale name), refresh the columns. This rescues rows created during
  // earlier logins before the post-login Action was deployed.
  const existing = await appPool.query<{
    id: string; tenant_id: string; email: string; name: string | null;
    role: string; active: boolean;
  }>(
    `SELECT id, tenant_id, email, name, role, active
     FROM app_user
     WHERE auth0_sub = $1
     LIMIT 1`,
    [sub],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (!row.active) return null;
    // Self-heal: prefer the real email over a placeholder; prefer the
    // token's name if the DB doesn't have one.
    const isPlaceholder = row.email.endsWith("@auth0.local");
    const wantEmail = rawEmail && (isPlaceholder || row.email.toLowerCase() !== rawEmail.toLowerCase())
      ? rawEmail
      : row.email;
    const wantName = name ?? row.name;
    if (wantEmail !== row.email || wantName !== row.name) {
      const upd = await appPool.query<{
        id: string; tenant_id: string; email: string; name: string | null;
        role: string; active: boolean;
      }>(
        `UPDATE app_user
         SET email = $1, name = $2
         WHERE id = $3
         RETURNING id, tenant_id, email, name, role, active`,
        [wantEmail, wantName, row.id],
      );
      const updRow = upd.rows[0] ?? row;
      return {
        id: updRow.id, tenantId: updRow.tenant_id, email: updRow.email,
        name: updRow.name, role: updRow.role, active: updRow.active,
      };
    }
    return {
      id: row.id, tenantId: row.tenant_id, email: row.email,
      name: row.name, role: row.role, active: row.active,
    };
  }

  // 2. Resolve the tenant we're provisioning into.
  const tenantId = await resolveDefaultTenantId();
  if (!tenantId) return null;

  // 4. Adopt-or-insert. If a row already exists for this email (e.g.
  // seeded by demo data, or created earlier when the same human logged
  // in via a different Auth0 identity provider — auth0|xxx vs
  // google-oauth2|xxx both return the same email), rebind the row to
  // the CURRENT auth0_sub instead of creating a duplicate.
  //
  // Previously this UPDATE guarded with
  //     (auth0_sub IS NULL OR auth0_sub = $1)
  // which meant a row whose auth0_sub had drifted (different IdP) would
  // NOT be adopted, and the fresh INSERT below tripped the
  // (tenant_id, email) unique constraint → 500 on every login.
  //
  // Now: email + tenant is the identity key. Whatever sub the current
  // token has wins. That's OK because Auth0 verified the email before
  // it minted the token; if the caller has a valid token for that
  // email, they ARE that user, regardless of which IdP got them here.
  const adopted = await appPool.query<{
    id: string; tenant_id: string; email: string; name: string | null;
    role: string; active: boolean;
  }>(
    `UPDATE app_user
     SET auth0_sub = $1,
         name = COALESCE(name, $2)
     WHERE tenant_id = $3
       AND LOWER(email) = LOWER($4)
     RETURNING id, tenant_id, email, name, role, active`,
    [sub, name, tenantId, email],
  );
  if (adopted.rows[0]) {
    const row = adopted.rows[0];
    if (!row.active) return null;
    return {
      id: row.id, tenantId: row.tenant_id, email: row.email,
      name: row.name, role: row.role, active: row.active,
    };
  }

  // 5. LEARNER PATH. The token's email matches a party that already has a
  // learner_profile, so this is a student we converted in the CRM and then
  // created an Auth0 user for by hand. Bind the login to the EXISTING party
  // — no new party, and crucially no is_internal flip: they are not staff.
  //
  // Deliberately before the bootstrap branch below, so a learner can never
  // be mistaken for the tenant's first admin.
  const learner = await appPool.query<{ party_id: string; name: string | null }>(
    `SELECT p.id AS party_id, p.name
     FROM party p
     JOIN learner_profile lp ON lp.party_id = p.id
     WHERE p.tenant_id = $1 AND LOWER(p.email) = LOWER($2)
     LIMIT 1`,
    [tenantId, email],
  );
  if (learner.rows[0]) {
    const partyId = learner.rows[0].party_id;
    const ins = await appPool.query<{
      id: string; tenant_id: string; email: string; name: string | null;
      role: string; active: boolean;
    }>(
      `INSERT INTO app_user (tenant_id, party_id, email, name, role, active, auth0_sub)
       VALUES ($1, $2, $3, $4, 'learner', true, $5)
       RETURNING id, tenant_id, email, name, role, active`,
      [tenantId, partyId, email, name ?? learner.rows[0].name, sub],
    );
    const row = ins.rows[0]!;
    return {
      id: row.id, tenantId: row.tenant_id, email: row.email,
      name: row.name, role: row.role, active: row.active,
    };
  }

  // 6. Nobody we recognise. Provision as admin ONLY to bootstrap an empty
  // tenant — the very first human to sign in to a fresh deployment. Once any
  // app_user exists, an unrecognised email is refused rather than handed an
  // account: with sign-ups disabled in Auth0 this should be unreachable, and
  // if it isn't, silently minting admins is the wrong failure mode.
  const populated = await appPool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM app_user WHERE tenant_id = $1`,
    [tenantId],
  );
  if (Number(populated.rows[0]?.n ?? "0") > 0) {
    console.warn(
      `[auth] Refusing to provision ${sub} <${email}> — no app_user, and no ` +
      `party with a learner_profile for that address. Create the CRM record ` +
      `first (staff: Admin → Advisors; learner: convert an enrolment), then ` +
      `retry the login.`,
    );
    return null;
  }

  // Phase 2 Party Model: create party + primary email contact_point, then
  // insert app_user pointing at it. Wrap in a transaction so a crash mid-
  // way doesn't leave a dangling party.
  const client = await appPool.connect();
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    await client.query("BEGIN");
    const { partyId } = await provisionPartyForInternalUser(client, tenantId, email, name);
    const ins = await client.query<{
      id: string; tenant_id: string; email: string; name: string | null;
      role: string; active: boolean;
    }>(
      `INSERT INTO app_user (tenant_id, party_id, email, name, role, active, auth0_sub)
       VALUES ($1, $2, $3, $4, 'admin', true, $5)
       RETURNING id, tenant_id, email, name, role, active`,
      [tenantId, partyId, email, name, sub],
    );
    await client.query("COMMIT");
    const row = ins.rows[0]!;
    return {
      id: row.id, tenantId: row.tenant_id, email: row.email,
      name: row.name, role: row.role, active: row.active,
    };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    // Race / sub collision: another request just inserted the same sub. Re-read.
    const recovered = await appPool.query<{
      id: string; tenant_id: string; email: string; name: string | null;
      role: string; active: boolean;
    }>(
      `SELECT id, tenant_id, email, name, role, active
       FROM app_user
       WHERE auth0_sub = $1
       LIMIT 1`,
      [sub],
    );
    if (recovered.rows[0]) {
      const row = recovered.rows[0];
      return {
        id: row.id, tenantId: row.tenant_id, email: row.email,
        name: row.name, role: row.role, active: row.active,
      };
    }
    throw err;
  } finally {
    client.release();
  }
}

let cachedTenantId: string | null = null;
async function resolveDefaultTenantId(): Promise<string | null> {
  if (cachedTenantId) return cachedTenantId;
  const fromEnv = process.env.DEFAULT_TENANT_ID?.trim();
  if (fromEnv && /^[0-9a-fA-F-]{36}$/.test(fromEnv)) {
    cachedTenantId = fromEnv;
    return cachedTenantId;
  }
  const r = await appPool.query<{ id: string }>(
    `SELECT id FROM tenant ORDER BY created_at DESC LIMIT 1`,
  );
  cachedTenantId = r.rows[0]?.id ?? null;
  return cachedTenantId;
}

// ─── Middleware ─────────────────────────────────────────────────────────────

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: "Missing bearer token" });
    }
    const token = match[1]!.trim();

    let claims: JWTPayload;
    try {
      const verified = await jwtVerify(token, JWKS, {
        issuer: ISSUER,
        audience: AUTH0_AUDIENCE,
      });
      claims = verified.payload;
    } catch (err) {
      return res.status(401).json({
        error: "Invalid token",
        detail: (err as Error).message,
      });
    }

    const user = await provisionUser(claims);
    if (!user) {
      // Either there's no tenant / no email claim, or the address is unknown
      // to this CRM — see the [auth] warning logged by provisionUser for
      // which. Deliberately vague to the caller: an authenticated stranger
      // shouldn't learn whether a given address exists in the system.
      return res.status(403).json({ error: "This account is not set up in the CRM. Contact your administrator." });
    }

    // Permissions can arrive in either claim:
    //   - The standard `permissions` array Auth0 attaches when RBAC +
    //     "Add Permissions in the Access Token" are enabled on the API.
    //   - A namespaced custom claim set by a post-login Action (mirror of
    //     event.authorization.permissions, intended as a stable contract
    //     in case dashboard toggles change in future).
    //
    // Order: prefer whichever is non-empty. If both are empty arrays, treat
    // as no permissions. (An empty namespaced array used to win and starve
    // out the standard claim — fixed.)
    const customClaim = claims[PERMISSIONS_CLAIM];
    const standardClaim = (claims as { permissions?: unknown }).permissions;
    const fromCustom  = Array.isArray(customClaim)   ? customClaim   : [];
    const fromStandard = Array.isArray(standardClaim) ? standardClaim : [];
    const list = fromStandard.length > 0 ? fromStandard : fromCustom;
    const permissions = new Set(list.map((p) => String(p)));

    req.userId = user.id;
    req.tenantId = user.tenantId;
    req.user = user;
    req.permissions = permissions;
    next();
  } catch (err) {
    next(err);
  }
}

// Re-export for callers that imported the cookie name. We still export it so
// the old import sites compile; once /auth/login is removed it'll be dead.
export const SESSION_COOKIE_NAME = "decrm_session";
