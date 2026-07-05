-- Catalog v2 — Stack → Program → Course (many-to-many)
--
-- Structural change: introduce `stack` as the top-level bucket (every program
-- belongs to exactly one stack), replace program.track with stack membership,
-- add duration + description on program, and make program↔course a real
-- many-to-many via `program_course`. Course loses program_id and code; picks
-- up description.
--
-- Data reset was approved by the user — we truncate program/course/cohort and
-- everything that FKs into them so we can add NOT NULL columns without
-- backfill. Only downstream row we preserve is `lead`, and we NULL its
-- program_id since those programs are gone.
--
-- Idempotent. Every step guarded so re-running is a no-op.

-- ─── 1. Wipe catalog + enrolment/assignment data (approved) ─────────────
-- CASCADE covers batch_assignment / course_assignment / enrolment via FK, but
-- we list them explicitly for clarity + so the seed's TRUNCATE order stays
-- consistent with this file.
TRUNCATE
  batch_assignment,
  course_assignment,
  enrolment,
  cohort,
  course,
  program
CASCADE;

-- Leads keep their denormalised program name but the FK now points at
-- nothing — clear it so new programs can be re-linked without collision.
UPDATE lead SET program_id = NULL WHERE program_id IS NOT NULL;

-- ─── 2. New table: stack ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "stack" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"   uuid NOT NULL,
  "name"        text NOT NULL,
  "description" text,
  "enabled"     boolean NOT NULL DEFAULT true,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stack_tenant_id_tenant_id_fk') THEN
    ALTER TABLE "stack" ADD CONSTRAINT "stack_tenant_id_tenant_id_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "stack_tenant_name_key"
  ON "stack" ("tenant_id", (lower("name")));

ALTER TABLE "stack" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stack" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stack_tenant_isolation" ON "stack";
CREATE POLICY "stack_tenant_isolation" ON "stack"
  USING (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "stack" TO decrm_app;

-- updated_at trigger — reuses set_updated_at() from post-0005.
DROP TRIGGER IF EXISTS "stack_updated_at" ON "stack";
CREATE TRIGGER "stack_updated_at" BEFORE UPDATE ON "stack"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 3. program: drop track; add stack_id, description, duration ────────
ALTER TABLE "program" DROP COLUMN IF EXISTS "track";
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "description"     text;
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "duration_value"  integer;
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "duration_unit"   text;
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "stack_id"        uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_stack_id_stack_id_fk') THEN
    ALTER TABLE "program" ADD CONSTRAINT "program_stack_id_stack_id_fk"
      FOREIGN KEY ("stack_id") REFERENCES "stack"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_duration_value_check') THEN
    ALTER TABLE "program" ADD CONSTRAINT "program_duration_value_check"
      CHECK (duration_value IS NULL OR duration_value > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_duration_unit_check') THEN
    ALTER TABLE "program" ADD CONSTRAINT "program_duration_unit_check"
      CHECK (duration_unit IS NULL OR duration_unit IN ('weeks','months'));
  END IF;
END $$;

-- stack_id is NOT NULL going forward — safe because we truncated program above.
-- Guard with a table-is-empty check so the migration remains re-runnable even
-- if new rows exist on a subsequent run (in which case the constraint is
-- already present).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'program' AND column_name = 'stack_id' AND is_nullable = 'NO'
  ) THEN
    IF NOT EXISTS (SELECT 1 FROM program LIMIT 1) THEN
      ALTER TABLE "program" ALTER COLUMN "stack_id" SET NOT NULL;
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "program_stack_idx" ON "program" ("tenant_id", "stack_id");

-- ─── 4. course: drop program_id + code; add description ─────────────────
DROP INDEX IF EXISTS "course_program_idx";
ALTER TABLE "course" DROP COLUMN IF EXISTS "program_id";
ALTER TABLE "course" DROP COLUMN IF EXISTS "code";
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "description" text;

-- ─── 5. New junction: program_course ────────────────────────────────────
CREATE TABLE IF NOT EXISTS "program_course" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"   uuid NOT NULL,
  "program_id"  uuid NOT NULL,
  "course_id"   uuid NOT NULL,
  "rank"        integer NOT NULL DEFAULT 0,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_course_tenant_id_tenant_id_fk') THEN
    ALTER TABLE "program_course" ADD CONSTRAINT "program_course_tenant_id_tenant_id_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_course_program_id_program_id_fk') THEN
    ALTER TABLE "program_course" ADD CONSTRAINT "program_course_program_id_program_id_fk"
      FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_course_course_id_course_id_fk') THEN
    ALTER TABLE "program_course" ADD CONSTRAINT "program_course_course_id_course_id_fk"
      FOREIGN KEY ("course_id") REFERENCES "course"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "program_course_uniq"        ON "program_course" ("program_id", "course_id");
CREATE INDEX        IF NOT EXISTS "program_course_program_idx" ON "program_course" ("tenant_id", "program_id");
CREATE INDEX        IF NOT EXISTS "program_course_course_idx"  ON "program_course" ("tenant_id", "course_id");

ALTER TABLE "program_course" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "program_course" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "program_course_tenant_isolation" ON "program_course";
CREATE POLICY "program_course_tenant_isolation" ON "program_course"
  USING (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "program_course" TO decrm_app;
