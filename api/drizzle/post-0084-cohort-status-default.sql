-- cohort.status had DEFAULT 'open' while cohort_status_check only permits
-- ('upcoming','running','completed','cancelled'). Any INSERT omitting status
-- therefore failed:
--
--   new row for relation "cohort" violates check constraint "cohort_status_check"
--
-- It never surfaced because the batch-creation route always sets status
-- explicitly, so the default was dead code — until something else inserts a
-- cohort. Found while probing the LMS schema.
--
-- 'upcoming' is the correct default: it's what schema.ts declares
-- (.default("upcoming")) and the first state in the lifecycle.
--
-- Pre-existing in Digital Edify as well — port this back upstream.
-- Idempotent, and touches no existing rows.

ALTER TABLE cohort ALTER COLUMN status SET DEFAULT 'upcoming';
