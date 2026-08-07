-- Phase 2 of the Party Model migration — additive prep for unifying app_user.
--
-- Purpose: make every internal user (employees, advisors, trainers, service_reps)
-- also a party row. After this migration every app_user has a NOT NULL
-- party_id UNIQUE FK to party. app_user.email / app_user.name are preserved
-- as read-only redundancy for one release; canonical is party.email / party.name.
--
-- Steps:
--   1. Add party.is_internal (boolean, default false).
--   2. Add app_user.party_id (nullable at first).
--   3. Backfill:
--       a. For every app_user, find an existing party in the same tenant with
--          matching email (LOWER-case). If found, set app_user.party_id to it
--          AND mark the party as is_internal = true.
--       b. If not found, create a new party (kind='person', is_internal=true,
--          name/email/city copied from app_user), insert a primary email
--          contact_point, and set app_user.party_id.
--   4. ALTER app_user.party_id → NOT NULL + UNIQUE + FK to party(id).
--
-- Idempotent. Safe to re-run. Reversible via `ALTER TABLE app_user DROP COLUMN party_id`
-- and `ALTER TABLE party DROP COLUMN is_internal`.

-- 1. party.is_internal
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'party' AND column_name = 'is_internal'
  ) THEN
    ALTER TABLE "party" ADD COLUMN "is_internal" boolean NOT NULL DEFAULT false;
  END IF;
END $$;

-- 2. app_user.party_id (nullable during backfill)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'app_user' AND column_name = 'party_id'
  ) THEN
    ALTER TABLE "app_user" ADD COLUMN "party_id" uuid;
  END IF;
END $$;

-- 3a. Adopt existing parties whose (tenant_id, LOWER(email)) matches an app_user.
--     Set app_user.party_id and flip the party's is_internal to true.
DO $$
DECLARE
  matched int;
BEGIN
  WITH matches AS (
    SELECT u.id AS user_id, p.id AS party_id
    FROM app_user u
    JOIN party    p ON p.tenant_id = u.tenant_id
                   AND LOWER(p.email) = LOWER(u.email)
    WHERE u.party_id IS NULL
      AND p.email IS NOT NULL
  ),
  set_user AS (
    UPDATE app_user u
    SET party_id = m.party_id
    FROM matches m
    WHERE u.id = m.user_id
    RETURNING u.id
  )
  UPDATE party p
  SET is_internal = true
  FROM matches m
  WHERE p.id = m.party_id
    AND p.is_internal = false;
  GET DIAGNOSTICS matched = ROW_COUNT;
  RAISE NOTICE 'post-0044: matched % existing parties to app_users by email', matched;
END $$;

-- 3b. Create a party for every remaining app_user (no email match). Insert a
--     primary email contact_point at the same time.
DO $$
DECLARE
  created int;
BEGIN
  WITH new_parties AS (
    INSERT INTO party (tenant_id, kind, name, email, is_internal, identifiers, attributes)
    SELECT u.tenant_id, 'person', u.name, u.email, true,
           '{}'::jsonb,
           jsonb_build_object('role', u.role)
    FROM app_user u
    WHERE u.party_id IS NULL
    RETURNING id, tenant_id, email
  ),
  link AS (
    UPDATE app_user u
    SET party_id = np.id
    FROM new_parties np
    WHERE u.tenant_id = np.tenant_id
      AND LOWER(u.email) = LOWER(np.email)
      AND u.party_id IS NULL
    RETURNING u.id
  )
  INSERT INTO contact_point (tenant_id, party_id, kind, value, label, is_primary)
  SELECT tenant_id, id, 'email', email, 'primary', true
  FROM new_parties
  WHERE email IS NOT NULL
  ON CONFLICT (tenant_id, party_id, kind) WHERE is_primary DO NOTHING;
  GET DIAGNOSTICS created = ROW_COUNT;
  RAISE NOTICE 'post-0044: created % new parties for app_users (with primary email contact_point)', created;
END $$;

-- 4. Sanity check + tighten column to NOT NULL + UNIQUE + FK.
DO $$
DECLARE
  orphans int;
BEGIN
  SELECT count(*) INTO orphans FROM app_user WHERE party_id IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION 'post-0044: % app_user rows still have NULL party_id after backfill — aborting', orphans;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'app_user' AND column_name = 'party_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "app_user" ALTER COLUMN "party_id" SET NOT NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_user_party_fk') THEN
    ALTER TABLE "app_user" ADD CONSTRAINT "app_user_party_fk"
      FOREIGN KEY ("party_id") REFERENCES "party"("id");
  END IF;
END $$;

-- Enforce 1:1 (one app_user per party). Partial unique isn't needed — every
-- app_user now has NOT NULL party_id.
CREATE UNIQUE INDEX IF NOT EXISTS "app_user_party_unique"
  ON "app_user" ("party_id");
