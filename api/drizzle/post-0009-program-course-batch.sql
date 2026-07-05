-- Phase D: program → course → batch.
--   - program gains price
--   - new course table
--   - cohort gets course_id, slot, time_label; loses program_id and price
--   - status enum: open→upcoming
--   - enrolment becomes program-level (gains program_id, price_paid)
--   - new batch_assignment links learners to specific batches
-- Idempotent.

-- 1. program.price
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "price" numeric(12,2);

-- 2. course table
--
-- Historical shape: (tenant_id, program_id, name, code, enabled, attributes).
-- On a fresh DB where `course` was created from the current schema.ts (post-
-- 0054 shape), or where a prior migration run got as far as post-0054 and
-- dropped program_id/code, this section runs anyway — the ADD COLUMN IF NOT
-- EXISTS statements re-materialise the legacy columns so the FK / index /
-- seed below always have something to point at. post-0054 will drop them
-- again a few files later; the round trip is deliberately cheap.
CREATE TABLE IF NOT EXISTS "course" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "program_id" uuid NOT NULL,
  "name" text NOT NULL,
  "code" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "attributes" jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Belt-and-braces: if `course` was created by a different path (Drizzle push
-- from the current schema, or a partial prior migration), re-add the legacy
-- columns so the rest of this file runs. NULL is fine because we backfill
-- from data below and post-0054 drops these columns eventually.
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "program_id" uuid;
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "code"       text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'course_tenant_id_tenant_id_fk') THEN
    ALTER TABLE "course" ADD CONSTRAINT "course_tenant_id_tenant_id_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  -- Only add the FK if the column still exists (dropped in post-0054).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'course' AND column_name = 'program_id'
  ) AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'course_program_id_program_id_fk') THEN
    ALTER TABLE "course" ADD CONSTRAINT "course_program_id_program_id_fk"
      FOREIGN KEY ("program_id") REFERENCES "program"("id");
  END IF;
END $$;

-- Only create the (tenant_id, program_id) index if program_id still exists.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'course' AND column_name = 'program_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS "course_program_idx" ON "course" ("tenant_id", "program_id");
  END IF;
END $$;

-- RLS for course
ALTER TABLE "course" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "course" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "course_tenant_isolation" ON "course";
CREATE POLICY "course_tenant_isolation" ON "course"
  USING (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "course" TO decrm_app;

-- 3. Seed a "General" course per program so existing batches can attach.
-- Skips on fresh DBs where program_id has already been dropped from course.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'course' AND column_name = 'program_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'course' AND column_name = 'code'
  ) THEN
    INSERT INTO "course" (tenant_id, program_id, name, code)
    SELECT p.tenant_id, p.id, 'General', UPPER(REGEXP_REPLACE(p.name, '\W+', '', 'g'))
    FROM "program" p
    WHERE NOT EXISTS (SELECT 1 FROM "course" c WHERE c.program_id = p.id);
  END IF;
END $$;

-- 4. cohort columns
ALTER TABLE "cohort" ADD COLUMN IF NOT EXISTS "course_id"  uuid;
ALTER TABLE "cohort" ADD COLUMN IF NOT EXISTS "slot"       text;
ALTER TABLE "cohort" ADD COLUMN IF NOT EXISTS "time_label" text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cohort_course_id_course_id_fk') THEN
    ALTER TABLE "cohort" ADD CONSTRAINT "cohort_course_id_course_id_fk"
      FOREIGN KEY ("course_id") REFERENCES "course"("id");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "cohort_course_idx" ON "cohort" ("tenant_id", "course_id");

-- Backfill course_id on existing batches: point each to the General course of the same program.
-- Wrapped in a check — once cohort.program_id has been dropped (later in this script
-- on first run), subsequent re-runs no-op rather than error.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cohort' AND column_name = 'program_id'
  ) THEN
    UPDATE "cohort" c
    SET course_id = co.id
    FROM "course" co
    WHERE c.course_id IS NULL
      AND c.program_id IS NOT NULL
      AND co.program_id = c.program_id
      AND co.name = 'General';
  END IF;
END $$;

-- 5. cohort.status: rename 'open' → 'upcoming'
ALTER TABLE "cohort" DROP CONSTRAINT IF EXISTS "cohort_status_check";
UPDATE "cohort" SET status = 'upcoming' WHERE status = 'open';
ALTER TABLE "cohort"
  ADD CONSTRAINT "cohort_status_check"
  CHECK (status IN ('upcoming','running','completed','cancelled'));

-- 5b. cohort.slot check
ALTER TABLE "cohort" DROP CONSTRAINT IF EXISTS "cohort_slot_check";
ALTER TABLE "cohort"
  ADD CONSTRAINT "cohort_slot_check"
  CHECK (slot IS NULL OR slot IN ('morning','afternoon','evening'));

-- 6. enrolment columns BEFORE dropping cohort.program_id (we read the latter)
ALTER TABLE "enrolment" ADD COLUMN IF NOT EXISTS "program_id" uuid;
ALTER TABLE "enrolment" ADD COLUMN IF NOT EXISTS "price_paid" numeric(12,2);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enrolment_program_id_program_id_fk') THEN
    ALTER TABLE "enrolment" ADD CONSTRAINT "enrolment_program_id_program_id_fk"
      FOREIGN KEY ("program_id") REFERENCES "program"("id");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "enrolment_program_idx" ON "enrolment" ("tenant_id", "program_id");

-- Backfill enrolment.program_id from the cohort the learner was enrolled in.
-- Skip on re-run once cohort.program_id has been dropped.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cohort' AND column_name = 'program_id'
  ) THEN
    UPDATE "enrolment" e
    SET program_id = c.program_id
    FROM "cohort" c
    WHERE e.program_id IS NULL
      AND e.cohort_id = c.id
      AND c.program_id IS NOT NULL;
  END IF;
END $$;

-- 6b. enrolment.cohort_id: drop NOT NULL (it's now legacy/optional)
ALTER TABLE "enrolment" ALTER COLUMN "cohort_id" DROP NOT NULL;

-- 7. batch_assignment table
CREATE TABLE IF NOT EXISTS "batch_assignment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "enrolment_id" uuid NOT NULL,
  "party_id" uuid NOT NULL,
  "cohort_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batch_assignment_tenant_id_tenant_id_fk') THEN
    ALTER TABLE "batch_assignment" ADD CONSTRAINT "batch_assignment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batch_assignment_enrolment_id_enrolment_id_fk') THEN
    ALTER TABLE "batch_assignment" ADD CONSTRAINT "batch_assignment_enrolment_id_enrolment_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "enrolment"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batch_assignment_party_id_party_id_fk') THEN
    ALTER TABLE "batch_assignment" ADD CONSTRAINT "batch_assignment_party_id_party_id_fk" FOREIGN KEY ("party_id") REFERENCES "party"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batch_assignment_cohort_id_cohort_id_fk') THEN
    ALTER TABLE "batch_assignment" ADD CONSTRAINT "batch_assignment_cohort_id_cohort_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "cohort"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batch_assignment_status_check') THEN
    ALTER TABLE "batch_assignment" ADD CONSTRAINT "batch_assignment_status_check"
      CHECK (status IN ('active','completed','dropped','deferred'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "batch_assignment_enrolment_idx" ON "batch_assignment" ("tenant_id", "enrolment_id");
CREATE INDEX IF NOT EXISTS "batch_assignment_party_idx"     ON "batch_assignment" ("tenant_id", "party_id");
CREATE INDEX IF NOT EXISTS "batch_assignment_cohort_idx"    ON "batch_assignment" ("tenant_id", "cohort_id");
CREATE UNIQUE INDEX IF NOT EXISTS "batch_assignment_uniq"    ON "batch_assignment" ("party_id", "cohort_id");

-- RLS
ALTER TABLE "batch_assignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "batch_assignment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "batch_assignment_tenant_isolation" ON "batch_assignment";
CREATE POLICY "batch_assignment_tenant_isolation" ON "batch_assignment"
  USING (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "batch_assignment" TO decrm_app;

-- 8. Migrate existing enrolment rows to batch_assignment so the 3 seeded learners
-- still see their batches on the new model.
INSERT INTO "batch_assignment" (tenant_id, enrolment_id, party_id, cohort_id, status, created_at)
SELECT e.tenant_id, e.id, e.party_id, e.cohort_id, e.status, e.created_at
FROM "enrolment" e
WHERE e.cohort_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "batch_assignment" b
    WHERE b.enrolment_id = e.id AND b.cohort_id = e.cohort_id
  );

-- 9. Now we can drop cohort.price and cohort.program_id (data already migrated).
ALTER TABLE "cohort" DROP COLUMN IF EXISTS "price";

-- Drop cohort.program_id last, and the FK that depends on it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cohort_program_id_program_id_fk') THEN
    ALTER TABLE "cohort" DROP CONSTRAINT "cohort_program_id_program_id_fk";
  END IF;
END $$;
DROP INDEX IF EXISTS "cohort_tenant_program_idx";
ALTER TABLE "cohort" DROP COLUMN IF EXISTS "program_id";
