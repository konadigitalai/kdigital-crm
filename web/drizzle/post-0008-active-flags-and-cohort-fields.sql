-- Phase C foundations:
--  - program.enabled  (soft "active" flag — replaces hard delete)
--  - cohort.enabled   (same idea for batches)
--  - cohort.code, schedule, end_date  (richer batch data)
--  - cohort.status check constraint
-- Idempotent.

ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "enabled" boolean NOT NULL DEFAULT true;

ALTER TABLE "cohort" ADD COLUMN IF NOT EXISTS "enabled"  boolean NOT NULL DEFAULT true;
ALTER TABLE "cohort" ADD COLUMN IF NOT EXISTS "code"     text;
ALTER TABLE "cohort" ADD COLUMN IF NOT EXISTS "schedule" text;
ALTER TABLE "cohort" ADD COLUMN IF NOT EXISTS "end_date" date;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cohort_status_check') THEN
    ALTER TABLE "cohort"
      ADD CONSTRAINT "cohort_status_check"
      CHECK (status IN ('open','running','completed','cancelled'));
  END IF;
END $$;
