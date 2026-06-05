-- Create a non-bypass-RLS app role for the API to connect as.
-- Admin (decrm_admin) keeps bypass for migrations + maintenance.
-- App (decrm_app) is RLS-bound: it CANNOT see other tenants' rows.
--
-- The password is set by the migrate runner via env var DECRM_APP_PASSWORD if present,
-- otherwise this script just ensures the role exists with current grants.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'decrm_app') THEN
    EXECUTE 'CREATE ROLE decrm_app LOGIN NOBYPASSRLS PASSWORD ''SET_BY_MIGRATE_RUNNER''';
  END IF;
END $$;

-- Make sure NOBYPASSRLS is set even if the role pre-existed
ALTER ROLE decrm_app NOBYPASSRLS;

-- Grant table privileges (insert/select/update/delete on tenant-scoped tables;
-- audit_log gets INSERT only — UPDATE/DELETE is also blocked by triggers).
GRANT USAGE ON SCHEMA public TO decrm_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenant, app_user, party, party_role,
  program, cohort, enrolment, onboarding_task,
  work_item, lead, deal, service_case, agent_run, agent,
  relationship, activity, approval, approval_policy,
  embedding, attachment
TO decrm_app;

GRANT INSERT, SELECT ON audit_log TO decrm_app;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO decrm_app;

-- Future tables created by migrations should also be granted automatically:
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO decrm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO decrm_app;
