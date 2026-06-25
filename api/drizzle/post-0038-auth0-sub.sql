-- post-0038 — Auth0 migration, part 1 (additive).
--
-- Adds a nullable `auth0_sub` column to app_user. This is the only column
-- the JWT-verifying middleware needs to JIT-provision users from Auth0
-- subject claims (e.g. "auth0|abc123" or "google-oauth2|123…").
--
-- Safe to run alongside the existing cookie-auth code. The old login path
-- never reads this column. New JIT inserts populate it; old rows leave it
-- NULL until those users log in via Auth0 (which they can't, until the
-- web side is also flipped).
--
-- Phase 2 of the migration (post-0039 — see TODO) drops password_hash and
-- the app_session table. That runs at cutover.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'app_user' AND column_name = 'auth0_sub'
  ) THEN
    ALTER TABLE "app_user" ADD COLUMN "auth0_sub" text;
  END IF;
END $$;

-- Auth0 `sub` values are globally unique; enforce that at the DB layer.
CREATE UNIQUE INDEX IF NOT EXISTS "app_user_auth0_sub_key"
  ON "app_user" ("auth0_sub")
  WHERE "auth0_sub" IS NOT NULL;
