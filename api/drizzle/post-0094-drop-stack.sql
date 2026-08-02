-- Remove the stack level. The catalogue is Programme → Course → Batch.
--
-- post-0054 introduced `stack` as a top-level bucket above programme, on the
-- assumption that programmes would need grouping. For KDigital they do not:
-- the approved registry (post-0087) already carries `programme_family`, which
-- is the grouping the business actually uses — Business Analysis, Data
-- Engineering, ServiceNow — and it comes from the registry rather than being
-- maintained by hand in a second place.
--
-- Keeping both meant every programme needed a stack chosen for it at create
-- time, and all nine registry pathways ended up in one bucket called
-- "KDigital Catalogue", which told nobody anything. A required field that
-- always holds the same value is a required field that should not exist.
--
-- DESTRUCTIVE and approved as such. Stack membership is not recoverable from
-- this migration. Nothing else is touched: programmes, courses, batches,
-- enrolments and assignments all keep their rows and their ids — only the
-- pointer up to stack goes.
--
-- What replaces it for grouping:
--   program.family            registry-owned (post-0087), the real grouping
--   program.programme_type    Career Pathway / Composite Career Pathway
--
-- Idempotent.

-- ─── 1. program loses its parent ─────────────────────────────────────────
--
-- Dropping the column takes the FK constraint and the composite index with
-- it, so neither needs naming here.

ALTER TABLE "program" DROP COLUMN IF EXISTS "stack_id";

-- The index was on (tenant_id, stack_id) and went with the column, but drop
-- it by name too in case an older database has a variant that did not.
DROP INDEX IF EXISTS "program_stack_idx";

-- ─── 2. the table itself ─────────────────────────────────────────────────
--
-- CASCADE covers the RLS policy, the grants and the unique index on
-- lower(name). No other table references stack: post-0054 gave the FK to
-- program alone, and that column is gone as of step 1.

DROP TABLE IF EXISTS "stack" CASCADE;

-- ─── 3. leave a marker ───────────────────────────────────────────────────
--
-- `_decrm_one_time_migration` already exists and is where this codebase
-- records irreversible steps. Worth a row: if someone later finds a report
-- or an export that references a stack name, this is the answer to "where
-- did it go".
INSERT INTO _decrm_one_time_migration ("key")
VALUES ('stack_dropped')
ON CONFLICT DO NOTHING;
