// Phase 2 Party Model — helpers for creating internal users as parties.
//
// The invariant: every `app_user` has a `party_id NOT NULL UNIQUE`. To
// preserve that, both the seed and the Auth0 JIT path go through this
// helper, which:
//   1. Adopts an existing party with the same (tenant, LOWER(email)) if one
//      already exists (marks it is_internal = true).
//   2. Otherwise creates a fresh party (kind='person', is_internal=true).
//   3. Inserts a primary email contact_point (Phase 1 dual-write) if the
//      party doesn't already have one for that email.
//
// Callers must have set `SELECT set_config('app.tenant_id', $1, false)` on
// the connection (RLS depends on it). All three writes happen through
// whatever `pg.Client`-shaped exec is passed in — no implicit new connection.
//
// See docs/Party_Model_Migration.md, Phase 2.

import type { PoolClient } from "pg";

export type ProvisionResult = { partyId: string; created: boolean };

/**
 * Create-or-adopt a party for an internal user. Idempotent by
 * (tenant, LOWER(email)) when email is present.
 *
 * @param client - a pg PoolClient with app.tenant_id already set.
 * @param tenantId - the tenant this user belongs to.
 * @param email - required; unique within the tenant.
 * @param name - display name (nullable, but strongly recommended).
 */
export async function provisionPartyForInternalUser(
  client: PoolClient,
  tenantId: string,
  email: string,
  name: string | null,
): Promise<ProvisionResult> {
  // 1. Look for an existing party in this tenant with the same LOWER(email).
  const existing = await client.query<{ id: string; is_internal: boolean }>(
    `SELECT id, is_internal FROM party
     WHERE tenant_id = $1 AND LOWER(email) = LOWER($2)
     LIMIT 1`,
    [tenantId, email],
  );

  if (existing.rows[0]) {
    const partyId = existing.rows[0].id;
    if (!existing.rows[0].is_internal) {
      await client.query(
        `UPDATE party SET is_internal = true WHERE id = $1`,
        [partyId],
      );
    }
    // Ensure primary email contact_point exists (dual-write invariant).
    await client.query(
      `INSERT INTO contact_point (tenant_id, party_id, kind, value, label, is_primary)
       VALUES ($1, $2, 'email', $3, 'primary', true)
       ON CONFLICT (tenant_id, party_id, kind) WHERE is_primary
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [tenantId, partyId, email],
    );
    return { partyId, created: false };
  }

  // 2. Insert a fresh party.
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO party (tenant_id, kind, name, email, is_internal, identifiers, attributes)
     VALUES ($1, 'person', $2, $3, true, '{}'::jsonb, '{}'::jsonb)
     RETURNING id`,
    [tenantId, name, email],
  );
  const partyId = inserted.rows[0]!.id;

  // 3. Primary email contact_point.
  await client.query(
    `INSERT INTO contact_point (tenant_id, party_id, kind, value, label, is_primary)
     VALUES ($1, $2, 'email', $3, 'primary', true)`,
    [tenantId, partyId, email],
  );

  return { partyId, created: true };
}
