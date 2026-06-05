-- Row-Level Security on every tenant-scoped table.
-- Policies key off current_tenant() which reads the per-request GUC app.tenant_id.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'tenant','app_user','party','party_role',
    'program','cohort','enrolment','onboarding_task',
    'work_item','lead','deal','service_case','agent_run','agent',
    'relationship','activity','approval','approval_policy','audit_log',
    'embedding','attachment'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);

    -- Tenant table itself: filter by id, not tenant_id.
    IF t = 'tenant' THEN
      EXECUTE format(
        'CREATE POLICY %I_tenant_isolation ON %I USING (id = current_tenant() OR current_tenant() IS NULL) WITH CHECK (id = current_tenant() OR current_tenant() IS NULL)',
        t, t
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = current_tenant() OR current_tenant() IS NULL) WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL)',
        t, t
      );
    END IF;
  END LOOP;
END $$;

-- Note: the `OR current_tenant() IS NULL` escape hatch lets the seed script and
-- the DB owner run unconstrained. In production, the API role will always set
-- the GUC, so the escape never fires for it.
