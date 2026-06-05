-- Auto-bump updated_at on UPDATE for tables that have it.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['party','work_item'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_updated_at ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t, t
    );
  END LOOP;
END $$;
