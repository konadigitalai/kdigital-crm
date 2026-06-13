-- Phase I: human-set Lead Rating (inbound | cold | warm | hot | superhot | enrolled).
-- The legacy `heat` column stays for back-compat; it gets auto-derived from
-- rating via a trigger so existing routes keep working until they're migrated.
-- Idempotent — safe to re-run.

-- 1. New column on lead.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lead' AND column_name = 'rating'
  ) THEN
    ALTER TABLE "lead" ADD COLUMN "rating" text NOT NULL DEFAULT 'inbound';
  END IF;
END $$;

-- 2. CHECK constraint for the new vocabulary.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_rating_check') THEN
    ALTER TABLE "lead" ADD CONSTRAINT "lead_rating_check"
      CHECK (rating IN ('inbound','cold','warm','hot','superhot','enrolled'));
  END IF;
END $$;

-- 3. Backfill from existing data:
--    - 'won' stage  → enrolled
--    - heat='hot' + score >= 90 → superhot
--    - heat='hot'   → hot
--    - heat='warm'  → warm
--    - heat='cold'  → cold
--    - everything else → inbound
UPDATE "lead"
SET rating = CASE
  WHEN stage = 'won' THEN 'enrolled'
  WHEN heat = 'hot' AND score >= 90 THEN 'superhot'
  WHEN heat = 'hot'  THEN 'hot'
  WHEN heat = 'warm' THEN 'warm'
  WHEN heat = 'cold' THEN 'cold'
  ELSE 'inbound'
END
WHERE rating = 'inbound' OR rating IS NULL;

-- 4. Trigger: keep `heat` in sync with `rating` so legacy queries keep working.
--    enrolled / superhot → 'hot' for `heat`. inbound → 'cold'. Others stay 1:1.
CREATE OR REPLACE FUNCTION sync_lead_heat_from_rating() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.heat = CASE NEW.rating
    WHEN 'enrolled' THEN 'hot'
    WHEN 'superhot' THEN 'hot'
    WHEN 'hot'      THEN 'hot'
    WHEN 'warm'     THEN 'warm'
    WHEN 'cold'     THEN 'cold'
    WHEN 'inbound'  THEN 'cold'
    ELSE 'cold'
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS lead_sync_heat_from_rating ON "lead";
CREATE TRIGGER lead_sync_heat_from_rating
  BEFORE INSERT OR UPDATE OF rating ON "lead"
  FOR EACH ROW EXECUTE FUNCTION sync_lead_heat_from_rating();

-- 5. Run the trigger once so the heat column is consistent post-backfill.
UPDATE "lead" SET rating = rating;

-- 6. Index — used by /summary and the leads filter.
CREATE INDEX IF NOT EXISTS "lead_rating_idx" ON "lead" ("rating");
