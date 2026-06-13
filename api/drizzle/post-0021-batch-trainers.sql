-- Phase H: structured trainer + cadence on cohort.
-- Adds trainer_id, co_trainer_id, days_of_week, start_time, end_time so we can
-- expand active batches into per-session calendar entries for the trainer pair.
-- Idempotent — safe to re-run.

ALTER TABLE "cohort" ADD COLUMN IF NOT EXISTS "trainer_id"    uuid;
ALTER TABLE "cohort" ADD COLUMN IF NOT EXISTS "co_trainer_id" uuid;
ALTER TABLE "cohort" ADD COLUMN IF NOT EXISTS "days_of_week"  text[];
ALTER TABLE "cohort" ADD COLUMN IF NOT EXISTS "start_time"    time;
ALTER TABLE "cohort" ADD COLUMN IF NOT EXISTS "end_time"      time;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cohort_trainer_fk') THEN
    ALTER TABLE "cohort" ADD CONSTRAINT "cohort_trainer_fk"
      FOREIGN KEY ("trainer_id") REFERENCES "app_user"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cohort_co_trainer_fk') THEN
    ALTER TABLE "cohort" ADD CONSTRAINT "cohort_co_trainer_fk"
      FOREIGN KEY ("co_trainer_id") REFERENCES "app_user"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cohort_distinct_trainers') THEN
    ALTER TABLE "cohort" ADD CONSTRAINT "cohort_distinct_trainers"
      CHECK (co_trainer_id IS NULL OR trainer_id IS NULL OR co_trainer_id <> trainer_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cohort_time_order') THEN
    ALTER TABLE "cohort" ADD CONSTRAINT "cohort_time_order"
      CHECK (start_time IS NULL OR end_time IS NULL OR end_time > start_time);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cohort_days_of_week_chk') THEN
    ALTER TABLE "cohort" ADD CONSTRAINT "cohort_days_of_week_chk"
      CHECK (days_of_week IS NULL
             OR days_of_week <@ ARRAY['mon','tue','wed','thu','fri','sat','sun']::text[]);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "cohort_trainer_idx"
  ON "cohort" ("tenant_id", "trainer_id");
CREATE INDEX IF NOT EXISTS "cohort_co_trainer_idx"
  ON "cohort" ("tenant_id", "co_trainer_id");
