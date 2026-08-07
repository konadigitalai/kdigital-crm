-- Two more lead cadence dates, both optional:
--   visited_date  — when the lead already visited the centre.
--   visiting_date — when the lead is scheduled to visit next.
--
-- Advisors set them manually on the lead record page (right sidebar) and
-- from the pipeline list column. No triggers, no derived logic.
--
-- Idempotent.

ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "visited_date"  date;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "visiting_date" date;
