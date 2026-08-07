-- Phase F: course is the gate between enrolment (program) and batch_assignment.
--   - new course_assignment table
--   - batch_assignment.course_assignment_id (nullable for now, set on every new row)
--   - wipe existing batch_assignment rows (per user direction)
-- Idempotent.

CREATE TABLE IF NOT EXISTS "course_assignment" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"     uuid NOT NULL,
  "enrolment_id"  uuid NOT NULL,
  "party_id"      uuid NOT NULL,
  "course_id"     uuid NOT NULL,
  "status"        text NOT NULL DEFAULT 'active',
  "created_at"    timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'course_assignment_tenant_id_tenant_id_fk') THEN
    ALTER TABLE "course_assignment" ADD CONSTRAINT "course_assignment_tenant_id_tenant_id_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'course_assignment_enrolment_id_enrolment_id_fk') THEN
    ALTER TABLE "course_assignment" ADD CONSTRAINT "course_assignment_enrolment_id_enrolment_id_fk"
      FOREIGN KEY ("enrolment_id") REFERENCES "enrolment"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'course_assignment_party_id_party_id_fk') THEN
    ALTER TABLE "course_assignment" ADD CONSTRAINT "course_assignment_party_id_party_id_fk"
      FOREIGN KEY ("party_id") REFERENCES "party"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'course_assignment_course_id_course_id_fk') THEN
    ALTER TABLE "course_assignment" ADD CONSTRAINT "course_assignment_course_id_course_id_fk"
      FOREIGN KEY ("course_id") REFERENCES "course"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'course_assignment_status_check') THEN
    ALTER TABLE "course_assignment"
      ADD CONSTRAINT "course_assignment_status_check"
      CHECK (status IN ('active','completed','dropped','deferred'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "course_assignment_enrolment_idx" ON "course_assignment" ("tenant_id", "enrolment_id");
CREATE INDEX IF NOT EXISTS "course_assignment_party_idx"     ON "course_assignment" ("tenant_id", "party_id");
CREATE INDEX IF NOT EXISTS "course_assignment_course_idx"    ON "course_assignment" ("tenant_id", "course_id");
CREATE UNIQUE INDEX IF NOT EXISTS "course_assignment_uniq"   ON "course_assignment" ("party_id", "course_id");

-- RLS
ALTER TABLE "course_assignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "course_assignment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "course_assignment_tenant_isolation" ON "course_assignment";
CREATE POLICY "course_assignment_tenant_isolation" ON "course_assignment"
  USING (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "course_assignment" TO decrm_app;

-- batch_assignment.course_assignment_id (FK to gate)
ALTER TABLE "batch_assignment" ADD COLUMN IF NOT EXISTS "course_assignment_id" uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batch_assignment_course_assignment_id_course_assignment_id_fk') THEN
    ALTER TABLE "batch_assignment"
      ADD CONSTRAINT "batch_assignment_course_assignment_id_course_assignment_id_fk"
      FOREIGN KEY ("course_assignment_id") REFERENCES "course_assignment"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "batch_assignment_course_assignment_idx"
  ON "batch_assignment" ("tenant_id", "course_assignment_id");

-- Per user direction: wipe existing batch_assignment rows so the new flow
-- (assign course → assign batch) starts clean. Only existing seed rows are
-- affected. (Run once; subsequent re-runs no-op because the rows are gone.)
DELETE FROM "batch_assignment" WHERE "course_assignment_id" IS NULL;
