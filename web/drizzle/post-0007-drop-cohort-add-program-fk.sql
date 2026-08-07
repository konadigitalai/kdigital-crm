-- Drop lead.cohort column (cohort moves to enrolment, on lead→learner conversion).
-- Add lead.program_id FK so DELETE FROM program can be guarded by SQL.
-- Idempotent.

ALTER TABLE "lead" DROP COLUMN IF EXISTS "cohort";

ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "program_id" uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_program_id_program_id_fk') THEN
    ALTER TABLE "lead"
      ADD CONSTRAINT "lead_program_id_program_id_fk"
      FOREIGN KEY ("program_id") REFERENCES "program"("id");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "lead_program_idx" ON "lead" ("tenant_id", "program_id");

-- Backfill program_id from the program text column where possible.
UPDATE "lead" l
SET program_id = p.id
FROM "program" p
WHERE l.program_id IS NULL
  AND p.tenant_id = l.tenant_id
  AND p.name = l.program;
