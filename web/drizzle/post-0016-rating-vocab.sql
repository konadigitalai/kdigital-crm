-- Phase B vocabulary: extend lead.rating values to the user-chosen set.
--   inbound  → 'new lead'   (renamed)
--   (new)    → 'attempted'   (added)
-- Full set after this migration: new lead | attempted | cold | warm | hot | superhot | enrolled
-- Idempotent.

-- 1. Drop the old CHECK if present so we can replace it with the wider set.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_rating_check') THEN
    ALTER TABLE "lead" DROP CONSTRAINT "lead_rating_check";
  END IF;
END $$;

-- 2. Backfill: rename `inbound` → `new lead`. Skip if no such rows.
UPDATE "lead" SET rating = 'new lead' WHERE rating = 'inbound';

-- 3. Re-add the CHECK with the new vocabulary.
ALTER TABLE "lead" ADD CONSTRAINT "lead_rating_check"
  CHECK (rating IN ('new lead','attempted','cold','warm','hot','superhot','enrolled'));

-- 4. Update the heat-sync trigger to handle the new values.
CREATE OR REPLACE FUNCTION sync_lead_heat_from_rating() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.heat = CASE NEW.rating
    WHEN 'enrolled'  THEN 'hot'
    WHEN 'superhot'  THEN 'hot'
    WHEN 'hot'       THEN 'hot'
    WHEN 'warm'      THEN 'warm'
    WHEN 'cold'      THEN 'cold'
    WHEN 'attempted' THEN 'cold'
    WHEN 'new lead'  THEN 'cold'
    ELSE 'cold'
  END;
  RETURN NEW;
END $$;

-- 5. Run the trigger once so legacy `heat` is consistent with the renamed values.
UPDATE "lead" SET rating = rating;

-- 6. Update the default for new rows.
ALTER TABLE "lead" ALTER COLUMN "rating" SET DEFAULT 'new lead';

-- 7. Insert the NBA agent into every tenant's catalog (idempotent — uses
--    the existing tenant_key unique index).
INSERT INTO agent (tenant_id, key, name, domain, operates_on, enabled, config)
SELECT t.id, 'nba', 'Next-Best-Action Agent', 'sales', 'lead', true, '{}'::jsonb
FROM tenant t
ON CONFLICT (tenant_id, key) DO NOTHING;
