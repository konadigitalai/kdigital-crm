-- A short, human-readable code for a programme: PRG-11.
--
-- Every other thing a learner sees already has one — LRN-7712 for the learner,
-- AAI-AUG-01-C1 for the batch, ENR-00231 for the enrolment — and the portal
-- prints those codes because that is what people quote to each other on a
-- call. The programme was the one level with nothing to quote.
--
-- The code comes from a DB default rather than the app, so every insert path
-- gets one: the CRM's POST /programs, the seed script, and any future import
-- all inherit it without remembering to.
--
-- Idempotent.

CREATE SEQUENCE IF NOT EXISTS seq_program;

ALTER TABLE program ADD COLUMN IF NOT EXISTS code text;

-- Backfill existing rows before attaching the default, so the sequence can
-- start after the highest number already handed out.
--
-- Ordered by name because `program` has no created_at to order by. That makes
-- the assignment arbitrary but STABLE: this runs once, the codes are then
-- fixed, and renaming a programme afterwards does not renumber anything.
DO $$
DECLARE
  n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM program WHERE code IS NULL) THEN
    WITH numbered AS (
      SELECT id, row_number() OVER (ORDER BY tenant_id, name, id) AS rn
      FROM program
      WHERE code IS NULL
    )
    UPDATE program p
    SET code = 'PRG-' || lpad(numbered.rn::text, 2, '0')
    FROM numbered
    WHERE p.id = numbered.id;
  END IF;

  -- Park the sequence past everything already assigned, whatever the width.
  SELECT COALESCE(max(NULLIF(regexp_replace(code, '^PRG-', ''), '')::bigint), 0)
    INTO n
  FROM program
  WHERE code ~ '^PRG-[0-9]+$';

  PERFORM setval('seq_program', GREATEST(n, 1), n > 0);
END $$;

ALTER TABLE program
  ALTER COLUMN code SET DEFAULT 'PRG-' || lpad(nextval('seq_program')::text, 2, '0');

-- One code per tenant. Partial so the constraint can be added before every
-- legacy row is guaranteed to have one.
CREATE UNIQUE INDEX IF NOT EXISTS program_tenant_code_uniq
  ON program (tenant_id, code)
  WHERE code IS NOT NULL;

GRANT USAGE, SELECT ON SEQUENCE seq_program TO decrm_app;
