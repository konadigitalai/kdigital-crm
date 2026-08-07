-- Fix: two tables from 0001_dark_blob.sql (lead_score_signal, agent_assignment)
-- pre-dated post-0006-app-role.sql's ALTER DEFAULT PRIVILEGES statement, so
-- they never got GRANT-ed to decrm_app. They were also missing from the RLS
-- array in post-0003-rls.sql.
--
-- Symptom on QA / any long-lived DB where post-0006 ran after these tables
-- already existed: POST /leads returns 500 "permission denied for table
-- lead_score_signal" the moment the seed loop tries to insert a scoring signal.
--
-- Idempotent. Safe to run on DBs where the grants already exist.

-- ─── Grants ──────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
  lead_score_signal,
  agent_assignment
TO decrm_app;

-- ─── RLS ─────────────────────────────────────────────────────────────────
-- Both tables have tenant_id — enforce tenant isolation like every other
-- tenant-scoped table.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['lead_score_signal','agent_assignment'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = current_tenant() OR current_tenant() IS NULL) WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL)',
      t, t
    );
  END LOOP;
END $$;
