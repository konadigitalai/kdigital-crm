-- Phase: enforce numeric-only Price quoted (lead.value).
--
-- Historically lead.value was a free-form string ("₹1.49L" / "verbal yes" /
-- "asked re: EMI"). The UI now treats it as a pure rupee amount and renders
-- it via toLocaleString('en-IN'). This migration is a one-time normalization:
-- reset every existing lead.value to a sane default of 15000.
--
-- IMPORTANT — guarding against re-runs.
-- The migration runner (api/src/db/migrate.ts) re-executes every post-*.sql
-- file on every `db:migrate` invocation. Without a guard, this would wipe
-- every advisor's price edit back to 15000 each time anyone runs migrations.
-- We use a tiny one-row "marker" table to record that this normalization
-- has already happened; subsequent runs see the marker and skip the UPDATE.

CREATE TABLE IF NOT EXISTS "_decrm_one_time_migration" (
  "key"        text PRIMARY KEY,
  "applied_at" timestamp with time zone NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "_decrm_one_time_migration"
    WHERE  "key" = 'lead_value_default_15000_v1'
  ) THEN
    UPDATE "lead" SET "value" = '15000';

    INSERT INTO "_decrm_one_time_migration" ("key")
    VALUES ('lead_value_default_15000_v1');
  END IF;
END $$;
