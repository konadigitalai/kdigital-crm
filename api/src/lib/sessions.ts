// Opaque-token sessions. The cookie carries a base64url random token; the DB
// stores only its sha-256 hash. A DB leak therefore can't be used to forge
// sessions.

import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { appPool } from "../db/app.js";

const SESSION_DAYS = 30;

export interface SessionRecord {
  id: string;
  userId: string;
  tenantId: string;
  expiresAt: Date;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// create — INSERT a session for the user. Returns the raw token (only time it
// is ever materialised; caller stuffs it in the cookie).
export async function createSession(
  tenantId: string,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await withTenant(tenantId, async (db) => {
    await db.execute(sql`
      INSERT INTO app_session (tenant_id, user_id, token_hash, expires_at)
      VALUES (${tenantId}, ${userId}, ${tokenHash}, ${expiresAt.toISOString()})
    `);
  });
  return { token, expiresAt };
}

// read — look up the active session for a token. Bypasses RLS via the admin
// pool because the request hasn't been authenticated yet (we don't know which
// tenant to scope to until we resolve this row).
export async function readSession(token: string): Promise<SessionRecord | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const r = await appPool.query<{
    id: string;
    user_id: string;
    tenant_id: string;
    expires_at: Date;
  }>(
    `SELECT id, user_id, tenant_id, expires_at
     FROM app_session
     WHERE token_hash = $1
       AND revoked_at IS NULL
       AND expires_at > now()
     LIMIT 1`,
    [tokenHash],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    expiresAt: row.expires_at,
  };
}

export async function revokeSession(token: string): Promise<void> {
  if (!token) return;
  const tokenHash = hashToken(token);
  await appPool.query(
    `UPDATE app_session SET revoked_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash],
  );
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await appPool.query(
    `UPDATE app_session SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}
