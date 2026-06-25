-- post-0039 — Auth0 migration, part 2 (DESTRUCTIVE).
--
-- Removes everything the legacy cookie/password auth flow needed. Runs at
-- the Phase C cutover window, AFTER all environments (dev/qa/prod on
-- Render + Vercel) have their Auth0 env vars set and the new code
-- deployed. Once this lands, anyone still on the old code is locked out
-- until they pull the new commits.
--
-- Drops in dependency order:
--   1. app_session            — server-side opaque-token sessions.
--   2. user_group_member,     — group membership join table.
--      user_group_permission, — group's permission rows.
--      user_group             — the groups themselves.
--   3. app_user.password_hash — bcrypt hash column.
--
-- This is intentionally idempotent (IF EXISTS guards) so re-running on a
-- partially-migrated DB is safe.

-- 1. Sessions table — no callers in the codebase after Phase B.
DROP TABLE IF EXISTS "app_session" CASCADE;

-- 2. Groups tables — replaced by Auth0 Roles + Permissions. Drop the join
-- tables first to avoid FK explosions.
DROP TABLE IF EXISTS "user_group_member"     CASCADE;
DROP TABLE IF EXISTS "user_group_permission" CASCADE;
DROP TABLE IF EXISTS "user_group"            CASCADE;

-- 3. Bcrypt password hash on app_user. The column is nullable so dropping
-- it can't fail because of NOT NULL constraints; just CASCADE in case
-- something hidden depends on it (nothing should).
ALTER TABLE "app_user" DROP COLUMN IF EXISTS "password_hash";
