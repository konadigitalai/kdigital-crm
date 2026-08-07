-- Phase 2 of the Party Model migration — defensive RLS reassert.
--
-- post-0045 rebuilt several columns in place (ALTER … DROP COLUMN + RENAME).
-- RLS policies operate at row level and don't depend on any individual
-- column, but re-asserting the isolation policy on each tenant-scoped table
-- costs almost nothing and eliminates any chance that policy state was
-- rebuilt in a way that leaves an unexpected default.
--
-- Idempotent. Mirrors post-0003-rls.sql exactly.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'tenant','app_user','party','party_role',
    'contact_point','party_external_id','party_affiliation',
    'program','cohort','enrolment','onboarding_task',
    'work_item','lead','deal','service_case','agent_run','agent',
    'relationship','activity','approval','approval_policy','audit_log',
    'embedding','attachment',
    'saved_view','support_case','forecast_snapshot',
    'edify_chat_session','edify_chat_message',
    'leave_day','calendar_event',
    -- calendar_invitee has no tenant_id (parent calendar_event does); RLS is inherited via joins.
    'wa_config','wa_template','wa_tag','wa_party_tag',
    'wa_conversation','wa_message','wa_broadcast','wa_broadcast_recipient',
    'wa_automation','wa_automation_run'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Skip anything not present (e.g. dropped tables like agent_assignment
    -- if this ever runs against an old schema).
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
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
