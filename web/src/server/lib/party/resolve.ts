// Phase 2 Party Model — thin resolvers between app_user.id and party.id.
//
// After post-0045, every FK that names a person (assignee_id, advisor_id,
// trainer_id, organizer_id, owner_id, sender_user_id, created_by, …) stores
// a party.id — not an app_user.id.
//
// But the auth middleware still resolves the request to req.userId (an
// app_user.id) — clients send app_user.id from the /users list — so every
// mutation entry point must convert that id to a party.id before writing to
// a FK column. Read paths that used to `JOIN app_user u ON u.id = X` now
// switch to `JOIN app_user u ON u.party_id = X` (fast, UNIQUE index).
//
// Prefer these helpers over ad-hoc SELECTs so the app has one canonical
// resolver to audit.

import { sql, type SQL } from "drizzle-orm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Exec = { execute: (q: SQL) => Promise<any> };

/**
 * Resolve an app_user.id to its party.id. Uses the UNIQUE(party_id) index
 * added in post-0044. Returns null if no such user exists (caller should
 * treat as 404 / bad request depending on context).
 */
export async function partyIdFromAppUserId(
  db: Exec, appUserId: string | null | undefined,
): Promise<string | null> {
  if (!appUserId) return null;
  const r = await db.execute(sql`
    SELECT party_id FROM app_user WHERE id = ${appUserId} LIMIT 1
  `);
  return (r.rows[0] as { party_id: string } | undefined)?.party_id ?? null;
}

/**
 * Inverse — resolve a party.id back to its app_user.id (if the party has
 * one; parties for external contacts / leads / customers won't).
 * Uses the UNIQUE index on app_user.party_id.
 */
export async function appUserIdFromPartyId(
  db: Exec, partyId: string | null | undefined,
): Promise<string | null> {
  if (!partyId) return null;
  const r = await db.execute(sql`
    SELECT id FROM app_user WHERE party_id = ${partyId} LIMIT 1
  `);
  return (r.rows[0] as { id: string } | undefined)?.id ?? null;
}

/**
 * Phase 3 — return the tenant's sentinel party.id, cached per-process. Used
 * as `actor_party_id` for agent / system / automation-initiated activity
 * and audit_log rows. There is exactly one sentinel per tenant (enforced by
 * `party_system_unique` partial unique index in post-0047).
 *
 * The sentinel is created once by post-0047-party-sentinel.sql (idempotent
 * across all tenants); it never moves after that, so caching is safe for
 * the lifetime of the process.
 *
 * Requires that `SELECT set_config('app.tenant_id', $1, false)` has been
 * called on the connection (RLS depends on it) — or that the caller uses
 * a role that bypasses RLS. In practice route code calls this via a db
 * exec that already has `withTenant`; we still pass tenantId explicitly so
 * a cache miss can populate the map key.
 */
/**
 * Phase 3 — resolve the actor's party.id for an activity/audit row.
 *
 * - If `appUserId` is set (a real user is doing this via the API): return
 *   their app_user.party_id.
 * - Otherwise: return the tenant's sentinel party (agents / system code).
 *
 * Never returns null — if the user has no party (shouldn't happen post
 * Phase 2) we fall through to the sentinel so the actor_party_id column is
 * never NULL for a live row.
 */
export async function resolveActorPartyId(
  db: Exec, tenantId: string, appUserId: string | null | undefined,
): Promise<string> {
  if (appUserId) {
    const resolved = await partyIdFromAppUserId(db, appUserId);
    if (resolved) return resolved;
  }
  return resolveSentinelPartyId(db, tenantId);
}

const sentinelCache = new Map<string, string>();
export async function resolveSentinelPartyId(
  db: Exec, tenantId: string,
): Promise<string> {
  const cached = sentinelCache.get(tenantId);
  if (cached) return cached;
  const r = await db.execute(sql`
    SELECT id FROM party WHERE tenant_id = ${tenantId} AND is_system = true LIMIT 1
  `);
  const row = r.rows[0] as { id: string } | undefined;
  if (!row) {
    throw new Error(
      `Party Model: no sentinel party found for tenant ${tenantId}. ` +
      `Did post-0047-party-sentinel.sql run?`,
    );
  }
  sentinelCache.set(tenantId, row.id);
  return row.id;
}
