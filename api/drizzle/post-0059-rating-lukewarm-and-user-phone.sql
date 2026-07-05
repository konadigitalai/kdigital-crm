-- Two additive changes bundled together because they landed in the same push:
--
--   1. Extend lead.rating vocab with a new value: 'lukewarm'. It sits between
--      'cold' and 'warm' in the funnel — still cold-derived heat.
--   2. Add app_user.phone so the new Manage Advisors page can capture a
--      contact number for each teammate.
--
-- Idempotent.

-- ── 1. rating: add 'lukewarm' ────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_rating_check') THEN
    ALTER TABLE "lead" DROP CONSTRAINT "lead_rating_check";
  END IF;
END $$;

ALTER TABLE "lead" ADD CONSTRAINT "lead_rating_check"
  CHECK (rating IN ('new lead','attempted','cold','lukewarm','warm','hot','superhot','enrolled'));

-- Extend the heat-sync trigger. Lukewarm still counts as 'cold' heat — it's
-- the "slightly better than cold, not yet warm" step.
CREATE OR REPLACE FUNCTION sync_lead_heat_from_rating() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.heat = CASE NEW.rating
    WHEN 'enrolled'  THEN 'hot'
    WHEN 'superhot'  THEN 'hot'
    WHEN 'hot'       THEN 'hot'
    WHEN 'warm'      THEN 'warm'
    WHEN 'lukewarm'  THEN 'cold'
    WHEN 'cold'      THEN 'cold'
    WHEN 'attempted' THEN 'cold'
    WHEN 'new lead'  THEN 'cold'
    ELSE 'cold'
  END;
  RETURN NEW;
END $$;

-- No backfill needed — nothing has been set to 'lukewarm' yet.

-- ── 2. app_user.phone ────────────────────────────────────────────────────
-- Free-text so we don't force a country-code split at this stage. Format
-- validation happens in the API route.
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "phone" text;
