-- Cases board redesign — new support_case columns for the operational board +
-- richer record page. Severity stays as `priority` (relabelled in the UI); SLA
-- state / age / type-group are derived at query time, so no columns for those.
--
-- These columns are also declared in src/db/schema.ts (source of truth). This
-- file adds the pieces the app applies at migrate time — CHECK constraints,
-- indexes, the category-enum extension, and a re-issued GRANT. support_case
-- already has RLS from its original migration; nothing to re-enable. Idempotent.

ALTER TABLE support_case ADD COLUMN IF NOT EXISTS source            text NOT NULL DEFAULT 'manual';
ALTER TABLE support_case ADD COLUMN IF NOT EXISTS type_label        text;
ALTER TABLE support_case ADD COLUMN IF NOT EXISTS channel           text;
ALTER TABLE support_case ADD COLUMN IF NOT EXISTS raised_by         text;
ALTER TABLE support_case ADD COLUMN IF NOT EXISTS pending_with      text;
ALTER TABLE support_case ADD COLUMN IF NOT EXISTS first_response_at timestamptz;
ALTER TABLE support_case ADD COLUMN IF NOT EXISTS reopen_count      integer NOT NULL DEFAULT 0;
ALTER TABLE support_case ADD COLUMN IF NOT EXISTS preventable       boolean;
ALTER TABLE support_case ADD COLUMN IF NOT EXISTS root_cause        text;
ALTER TABLE support_case ADD COLUMN IF NOT EXISTS systemic_ref      text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_case_source_check') THEN
    ALTER TABLE support_case ADD CONSTRAINT support_case_source_check
      CHECK (source IN ('manual','auto'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_case_raised_by_check') THEN
    ALTER TABLE support_case ADD CONSTRAINT support_case_raised_by_check
      CHECK (raised_by IS NULL OR raised_by IN ('learner','internal','system'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_case_pending_with_check') THEN
    ALTER TABLE support_case ADD CONSTRAINT support_case_pending_with_check
      CHECK (pending_with IS NULL OR pending_with IN ('learner','internal'));
  END IF;
  -- Extend the category enum with 'data_privacy' (the "Data" type group).
  ALTER TABLE support_case DROP CONSTRAINT IF EXISTS support_case_category_check;
  ALTER TABLE support_case ADD  CONSTRAINT support_case_category_check
    CHECK (category IN ('billing','technical','content_lms','onboarding','cohort_batch','refund','certificate','data_privacy','other'));
END $$;

CREATE INDEX IF NOT EXISTS support_case_source_idx ON support_case (tenant_id, source);

GRANT SELECT, INSERT, UPDATE, DELETE ON support_case TO decrm_app;
