# Party Model Migration — Rollback Playbook

**Audience:** Engineer doing surgery-in-anger.
**Scope:** Roll back Phase 1 (contact points, external IDs, affiliations), Phase 2 (app_user ↔ party unification, 17 FK flips), Phase 3 (sentinel party + actor_party_id + drop lead.city), and/or Phase 4 (consent + dedup engine) safely on a live database.

> The migrations are **additive** at the SQL layer (Phase 1 tables are new; Phase 2 columns are new-alongside-old until the flip; Phase 3 adds new columns and drops one denormalized column; Phase 4 is 4 new tables + 3 new columns on party). This document assumes you need to revert AFTER `npm run db:migrate` has succeeded on the target environment.

---

## Rollback triggers — when to use this

- Login is broken for one or more roles after Phase 2 (post-0044/0045 cutover).
- A cross-tenant data leak is discovered on `contact_point`, `party_external_id`, `party_affiliation`, or the flipped FKs.
- The Auth0 JIT provisioning path corrupts a party or app_user row and needs to be turned off while we investigate.
- Any migration-triggered corruption reported by the `.verify` scripts (see `api/src/db/verify*.ts`).

## Rollback triggers — when NOT to use this

- Route code is broken but the DB is fine → deploy a route-only revert.
- One customer's data is inconsistent → hand-fix that customer, don't undo the migration for everyone.
- Performance regression → add indexes, don't roll back.

---

## Phase 1 rollback (post-0040/0041/0042/0043)

**Blast radius:** the four Phase 1 tables + one column on `party`. No existing routes read from these tables (dual-write only writes to them), so dropping them is a pure database revert.

```sql
-- Run in a single transaction. Idempotent.
BEGIN;

  -- Drop tables in dependency order (contact_point has no dependents; the
  -- other three cascade cleanly since only Phase 1 code references them).
  DROP TABLE IF EXISTS contact_point       CASCADE;
  DROP TABLE IF EXISTS party_external_id   CASCADE;
  DROP TABLE IF EXISTS party_affiliation   CASCADE;

  -- Remove the org-hierarchy self-FK column.
  ALTER TABLE party DROP CONSTRAINT IF EXISTS party_parent_fk;
  ALTER TABLE party DROP CONSTRAINT IF EXISTS party_parent_not_self;
  DROP INDEX IF EXISTS party_parent_idx;
  ALTER TABLE party DROP COLUMN IF EXISTS parent_party_id;

COMMIT;
```

**After running:**
1. Delete `api/drizzle/post-0040-contact-point.sql` through `post-0043-party-parent-fk.sql`.
2. Remove `contactPoint`, `partyExternalId`, `partyAffiliation`, `parentPartyId`, `isInternal` from `api/src/db/schema.ts`.
3. Remove dual-write blocks in `api/src/db/seed.ts`, `api/src/routes/leads.ts`, `api/src/lib/whatsapp/inbox.ts`.
4. Redeploy.

**Cost:** all data written to `contact_point` / `party_external_id` / `party_affiliation` is lost. Since Phase 1 is dual-write only, `party.email` and `party.phone` retain the canonical values — no lead data is lost.

---

## Phase 2 rollback (post-0044/0045/0046)

**Blast radius:** significant. `app_user.party_id` is a NOT NULL column, and 17 FKs across 14 tables now store `party.id` instead of `app_user.id`.

The migration is designed so **rollback is reversible** as long as `app_user.email` and `app_user.name` still exist (they do — we kept them as read-only redundancy).

### Step 1 — Unflip the 17 FK columns

Run the reverse-of-post-0045 script below inside a single transaction. For each column, the script:

1. Adds a new `<col>_old uuid` column referencing `app_user(id)`.
2. Backfills `<col>_old` by looking up the app_user whose `party_id` matches the current column.
3. Drops the current column (which stores party.id).
4. Renames `<col>_old` back to `<col>`.
5. Renames the FK constraint back to its original name (already the original name after our recent fix, so this is a no-op).

**⚠ Before running:** confirm every `app_user.party_id` still points at a live party. If any party has been deleted while its app_user survived, the reverse-backfill will leave `NULL` in that column.

```sql
BEGIN;

  -- Helper: for each of the 17 columns, resolve party.id → app_user.id via app_user.party_id.
  -- The migration below repeats the same 6-step pattern per column; only the (table, column,
  -- FK name, nullability, ON DELETE, indexes) tuples change.
  --
  -- Pattern per column (example: work_item.assignee_id):
  --   ALTER TABLE work_item ADD COLUMN assignee_id_old uuid;
  --   UPDATE work_item t SET assignee_id_old = u.id
  --     FROM app_user u WHERE t.assignee_id = u.party_id;
  --   ALTER TABLE work_item DROP CONSTRAINT work_item_assignee_id_app_user_id_fk;
  --   DROP INDEX wi_assignee_idx;
  --   ALTER TABLE work_item DROP COLUMN assignee_id;
  --   ALTER TABLE work_item RENAME COLUMN assignee_id_old TO assignee_id;
  --   ALTER TABLE work_item ADD CONSTRAINT work_item_assignee_id_app_user_id_fk
  --     FOREIGN KEY (assignee_id) REFERENCES app_user(id);
  --   CREATE INDEX wi_assignee_idx ON work_item (tenant_id, assignee_id);
  --
  -- ...repeat for the other 16 columns from the Phase 2 scope-map table.

COMMIT;
```

A full unfold of this script for every column lives in `api/drizzle/post-0045-flip-user-fks-to-party.sql` — the reverse is a mechanical transformation (swap `party_id` ↔ `id`, swap `party` ↔ `app_user`, keep the same nullability + ON DELETE).

### Step 2 — Drop `app_user.party_id`

```sql
BEGIN;
  ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_party_fk;
  DROP INDEX IF EXISTS app_user_party_unique;
  ALTER TABLE app_user DROP COLUMN IF EXISTS party_id;
  ALTER TABLE party    DROP COLUMN IF EXISTS is_internal;
COMMIT;
```

### Step 3 — Revert the code

1. Revert `api/src/db/schema.ts` — every `.references(() => party.id)` in the 17 FKs back to `.references(() => appUser.id)`; drop the `partyId` field on `appUser`; drop the `isInternal` field on `party`.
2. Revert `api/src/middleware/auth.ts` — restore the pre-Phase-2 fresh-insert branch (no transaction wrapper, no `provisionPartyForInternalUser` call).
3. Revert every route change (`leads`, `cases`, `cohorts`, `batches`, `events`, `pipeline`, `records`, `whatsapp`, `share`, `catalog`) — revert the `JOIN app_user u ON u.party_id = X` back to `ON u.id = X`, remove all `partyIdFromAppUserId` calls, remove Rule-B `u.id AS "…Id"` mappings.
4. Delete `api/src/lib/party/provision.ts` and `api/src/lib/party/resolve.ts`.
5. Revert seed.ts — `seedInternalUser` → direct `db.insert(appUser)`, drop `provisionPartyForInternalUser` import.
6. Delete `api/drizzle/post-0044-app-user-party-fk.sql`, `post-0045-flip-user-fks-to-party.sql`, `post-0046-rls-refresh.sql`.
7. `git commit` and redeploy.

**Cost:** All internal-party rows (9 in seed data) become orphaned parties with `is_internal` = true — you may want to `DELETE FROM party WHERE is_internal = true` post-rollback to clean them up (they'll re-create themselves the next time an app_user is inserted, if Phase 2 code was left in place).

---

## Partial rollback — keep Phase 1, undo Phase 2

Phase 1 does not depend on Phase 2. If Phase 2 breaks something, you can revert Phase 2 alone (Steps 1–3 of the Phase 2 rollback) and keep Phase 1 tables in place. Contact points, external IDs, and affiliations continue to work.

---

## Phase 3 rollback (post-0047/0048/0049)

**Blast radius:** additive columns on activity/audit_log + the sentinel party + drop of `lead.city`. All additive changes revert cleanly. The dropped `lead.city` column can be re-added and backfilled from `party.city`.

### Step 1 — Restore `lead.city` (post-0049)

```sql
BEGIN;
  ALTER TABLE lead ADD COLUMN city text;
  UPDATE lead l
  SET city = p.city
  FROM work_item wi
  JOIN party p ON p.id = wi.party_id
  WHERE wi.id = l.work_item_id;
COMMIT;
```

Then revert the code: change every `p.city AS city` back to `l.city AS city` in `routes/pipeline.ts`, `routes/leads.ts`, `routes/records.ts`, `agents/edify.ts`, `agents/lead-context.ts`, `agents/outreach.ts`. Restore the `UPDATE lead SET city = ...` dual-write in `routes/leads.ts:PATCH` handler.

### Step 2 — Drop `actor_party_id` (post-0048)

```sql
BEGIN;
  ALTER TABLE activity   DROP CONSTRAINT IF EXISTS activity_actor_party_fk;
  DROP INDEX IF EXISTS activity_actor_party_idx;
  ALTER TABLE activity   DROP COLUMN IF EXISTS actor_party_id;

  ALTER TABLE audit_log  DROP CONSTRAINT IF EXISTS audit_log_actor_party_fk;
  DROP INDEX IF EXISTS audit_log_actor_party_idx;
  ALTER TABLE audit_log  DROP COLUMN IF EXISTS actor_party_id;
COMMIT;
```

Route/agent code that inserts activity/audit rows with `actor_party_id` will start failing on this DB — you MUST also revert the code changes: every activity/audit INSERT loses its `actor_party_id` column + value. About 30 sites; grep for `actor_party_id`.

### Step 3 — Drop the sentinel + `is_system` column (post-0047)

```sql
BEGIN;
  DROP INDEX IF EXISTS party_system_unique;
  DELETE FROM party WHERE is_system = true;
  ALTER TABLE party DROP COLUMN IF EXISTS is_system;
COMMIT;
```

Remove `isSystem` from the party pgTable in `api/src/db/schema.ts`. Delete `api/src/lib/party/provision.ts`? No — leave it (Phase 2 needs it). Just remove the `resolveSentinelPartyId` and `resolveActorPartyId` exports from `api/src/lib/party/resolve.ts`.

Delete `api/drizzle/post-0047-party-sentinel.sql`, `post-0048-activity-audit-actor-party.sql`, `post-0049-drop-lead-city.sql`.

**Cost:** all Phase 3 attribution data is lost (actor_party_id references disappear). Since actor_type + actor_name text are preserved (never dropped), the activity feed still renders correctly — you just lose the ability to `GROUP BY actor_party_id`.

## Phase 4 rollback (post-0050/0051/0052)

**Blast radius:** 4 new tables + 3 new columns on party. All additive; drop and go. If any merges have already run on production, the loser parties are `is_merged=true` and their data is on the winner — rolling back does NOT unwind the merge. Merge history is preserved in `party_merge_log` (if you don't drop that too), but the reparenting itself is permanent.

**⚠ Do NOT roll back Phase 4 if you need to reverse a specific merge.** Instead, use the `party_merge_log.snapshot` for that merge and manually reparent data back to the loser party. Phase 4 rollback is for the *feature itself* going away, not for undoing one bad merge.

### Step 1 — Drop the tables

```sql
BEGIN;
  DROP TABLE IF EXISTS party_duplicate_candidate CASCADE;
  DROP TABLE IF EXISTS party_match_rule          CASCADE;
  DROP TABLE IF EXISTS party_merge_log           CASCADE;
  DROP TABLE IF EXISTS party_consent             CASCADE;
COMMIT;
```

### Step 2 — Drop the party columns

```sql
BEGIN;
  ALTER TABLE party DROP CONSTRAINT IF EXISTS party_merged_into_fk;
  ALTER TABLE party DROP CONSTRAINT IF EXISTS party_merged_not_self;
  DROP INDEX IF EXISTS party_merged_idx;
  ALTER TABLE party DROP COLUMN IF EXISTS merged_at;
  ALTER TABLE party DROP COLUMN IF EXISTS merged_into_party_id;
  ALTER TABLE party DROP COLUMN IF EXISTS is_merged;
COMMIT;
```

### Step 3 — Revert code

Delete:
- `api/drizzle/post-0050-party-consent.sql`, `post-0051-party-merge-log.sql`, `post-0052-party-match-rule.sql`
- `api/src/lib/party/consent.ts`, `dedup.ts`, `dedup-worker.ts`
- `api/src/routes/party-consent.ts`, `parties.ts`

Revert:
- Drop the `partyConsent`, `partyMergeLog`, `partyMatchRule`, `partyDuplicateCandidate` pgTables from `api/src/db/schema.ts`, plus the `is_merged` / `merged_into_party_id` / `merged_at` columns on `party`.
- Remove `startDedupWorker()`, `partiesRouter`, `partyConsentRouter` from `api/src/index.ts`.
- Remove the consent gate + `skipped` field from `api/src/routes/whatsapp.ts` broadcast recipient handler (grep for `filterConsentedRecipients`).
- Remove the Phase 4 seed block from `api/src/db/seed.ts` (grep for `party_match_rule` insert).

**Cost of rollback:** all consent history is lost (recover from `party_consent` backups if compliance requires it). All pending duplicate candidates are lost — team rebuilds detection from scratch when the feature returns.

## Partial rollback — keep Phase 3, undo lead.city drop only

If only the `lead.city` drop is causing problems (some legacy path we missed), run only Step 1 above and leave Phase 3 sentinel + actor_party_id in place. Reset the six-ish read paths to `l.city` in code.

---

## Post-rollback verification

Run `api/src/db/verify.ts` and `api/src/db/verify-records.ts` after every rollback step to confirm data integrity.

Then run the seed's Phase 2 verification queries manually:

```sql
-- Should return zero rows if Phase 2 is fully reverted.
SELECT count(*) FROM pg_constraint c
JOIN pg_class ft ON ft.oid = c.confrelid
WHERE c.contype = 'f' AND ft.relname = 'party';
-- Should equal 5 (party_role, contact_point, party_external_id, party_affiliation, party.parent_party_id self-FK)
-- if Phase 1 is retained, OR 1 (party_role) if both phases reverted.
```

---

## Emergency stop — pause without rollback

If the DB is fine but the Auth0 JIT is misbehaving, you can pause **just** the Phase 2 auth code without rolling back schema:

```ts
// In api/src/middleware/auth.ts, at the top of provisionUser:
if (process.env.AUTH0_JIT_PARTY_DISABLED === "true") {
  // Fall back to the pre-Phase-2 fresh-insert path.
  // (Copy the old block from git history at HEAD~N.)
}
```

Set `AUTH0_JIT_PARTY_DISABLED=true` in the API env. New logins won't create parties (existing users are unaffected). This buys time to investigate without a schema revert.

---

## Rollback drill (recommended)

Before shipping Phase 2 to production, run one dress rehearsal on staging:

1. Fresh reset + migrate + seed.
2. Confirm login flow works for all 4 roles.
3. Run Steps 1–3 of Phase 2 rollback.
4. Confirm login flow still works using the pre-Phase-2 code path.
5. Run migrate again to re-apply Phase 2.
6. Confirm login flow works again.

If any step fails, do not deploy Phase 2 to production until the failure is fixed.
