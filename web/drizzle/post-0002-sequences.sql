-- Per-type sequences for human-friendly numbers.
-- App code does e.g. 'LEAD-' || nextval('seq_lead') so prefixes stay flexible.

CREATE SEQUENCE IF NOT EXISTS seq_lead START 9700;
CREATE SEQUENCE IF NOT EXISTS seq_deal START 3100;
CREATE SEQUENCE IF NOT EXISTS seq_case START 4400;
CREATE SEQUENCE IF NOT EXISTS seq_onb  START 6100;
CREATE SEQUENCE IF NOT EXISTS seq_run  START 2030;

-- Bump every sequence past whatever the seed inserted. Uses subqueries with
-- regexp to extract the numeric suffix. Idempotent — safe on every migrate.
DO $$
BEGIN
  PERFORM setval('seq_lead', GREATEST(
    nextval('seq_lead'),
    COALESCE((SELECT MAX(NULLIF(regexp_replace(number, '\D', '', 'g'), ''))::int FROM work_item WHERE type = 'lead'), 9700)
  ));
  PERFORM setval('seq_run', GREATEST(
    nextval('seq_run'),
    COALESCE((SELECT MAX(NULLIF(regexp_replace(number, '\D', '', 'g'), ''))::int FROM work_item WHERE type = 'agent_run'), 2030)
  ));
END $$;
