-- Phase G: Support-case module (ServiceNow-style; was named "ticket" before
-- being renamed to "support_case" in post-0027 — see that file for context).
--   - widen work_item_type_check to include 'support_case'
--   - new `support_case` extension table (1:1 with work_item)
--   - seq_support_case sequence + bump past existing CSE-* numbers
--   - RLS + grants
-- Idempotent. Safe to re-run.

-- 1. Widen work_item.type CHECK to include 'support_case'.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_item_type_check') THEN
    ALTER TABLE "work_item" DROP CONSTRAINT "work_item_type_check";
  END IF;
END $$;

ALTER TABLE "work_item"
  ADD CONSTRAINT "work_item_type_check"
  CHECK (type IN ('lead','deal','service_case','onboarding_task','agent_run','support_case','ticket'));
-- Note: 'ticket' is kept in the list temporarily so the rename in post-0027
-- doesn't fail because old rows still carry that value mid-migration.
-- post-0027 then re-tightens the check to exclude 'ticket'.

-- 2. support_case table.
-- Skip creation when an old `ticket` table is still around — post-0027 will
-- rename it. This file runs BEFORE post-0027, so on the very first
-- `db:migrate` after the rename ships, this guard prevents creating a
-- second empty table that would collide with the rename.
DO $$
DECLARE
  has_ticket      boolean;
  has_supportcase boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ticket'       AND relkind = 'r') INTO has_ticket;
  SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'support_case' AND relkind = 'r') INTO has_supportcase;

  IF NOT has_ticket AND NOT has_supportcase THEN
    CREATE TABLE "support_case" (
      "work_item_id"     uuid PRIMARY KEY NOT NULL,
      "tenant_id"        uuid NOT NULL,
      "requester_name"   text NOT NULL,
      "requester_email"  text NOT NULL,
      "requester_phone"  text NOT NULL,
      "requester_kind"   text NOT NULL,
      "party_id"         uuid,
      "subject"          text NOT NULL,
      "description"      text,
      "category"         text NOT NULL DEFAULT 'other',
      "priority"         integer NOT NULL DEFAULT 3,
      "status"           text NOT NULL DEFAULT 'open',
      "due_at"           timestamp with time zone,
      "remind_at"        timestamp with time zone,
      "resolved_at"      timestamp with time zone,
      "closed_at"        timestamp with time zone,
      "resolution"       text,
      "resolution_code"  text,
      "created_by_id"    uuid,
      "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at"       timestamp with time zone NOT NULL DEFAULT now()
    );
  END IF;
END $$;

-- The remaining FKs / checks / indexes / RLS / grants are scoped behind a
-- "table exists" guard. The first time post-0013 re-runs after post-0027 has
-- renamed `ticket` → `support_case`, both branches no-op gracefully.

DO $$
DECLARE has_supportcase boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'support_case' AND relkind = 'r') INTO has_supportcase;
  IF NOT has_supportcase THEN RETURN; END IF;

  -- FKs
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_case_work_item_id_work_item_id_fk') THEN
    EXECUTE 'ALTER TABLE "support_case" ADD CONSTRAINT "support_case_work_item_id_work_item_id_fk"
      FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_case_tenant_id_tenant_id_fk') THEN
    EXECUTE 'ALTER TABLE "support_case" ADD CONSTRAINT "support_case_tenant_id_tenant_id_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id")';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_case_party_id_party_id_fk') THEN
    EXECUTE 'ALTER TABLE "support_case" ADD CONSTRAINT "support_case_party_id_party_id_fk"
      FOREIGN KEY ("party_id") REFERENCES "party"("id")';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_case_created_by_id_app_user_id_fk') THEN
    EXECUTE 'ALTER TABLE "support_case" ADD CONSTRAINT "support_case_created_by_id_app_user_id_fk"
      FOREIGN KEY ("created_by_id") REFERENCES "app_user"("id")';
  END IF;

  -- Domain checks
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_case_requester_kind_check') THEN
    EXECUTE 'ALTER TABLE "support_case" ADD CONSTRAINT "support_case_requester_kind_check"
      CHECK (requester_kind IN (''lead'',''learner'',''external''))';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_case_status_check') THEN
    EXECUTE 'ALTER TABLE "support_case" ADD CONSTRAINT "support_case_status_check"
      CHECK (status IN (''open'',''in_progress'',''pending'',''resolved'',''closed'',''cancelled''))';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_case_category_check') THEN
    EXECUTE 'ALTER TABLE "support_case" ADD CONSTRAINT "support_case_category_check"
      CHECK (category IN (''billing'',''technical'',''content_lms'',''onboarding'',''cohort_batch'',''refund'',''certificate'',''other''))';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_case_priority_check') THEN
    EXECUTE 'ALTER TABLE "support_case" ADD CONSTRAINT "support_case_priority_check"
      CHECK (priority BETWEEN 1 AND 4)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_case_resolution_code_check') THEN
    EXECUTE 'ALTER TABLE "support_case" ADD CONSTRAINT "support_case_resolution_code_check"
      CHECK (resolution_code IS NULL OR resolution_code IN (''fixed'',''duplicate'',''wont_fix'',''no_action''))';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_case_closed_has_resolution') THEN
    EXECUTE 'ALTER TABLE "support_case" ADD CONSTRAINT "support_case_closed_has_resolution"
      CHECK (status <> ''closed'' OR (resolution IS NOT NULL AND length(trim(resolution)) > 0))';
  END IF;
END $$;

-- Indexes
DO $$
DECLARE has_supportcase boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'support_case' AND relkind = 'r') INTO has_supportcase;
  IF NOT has_supportcase THEN RETURN; END IF;

  EXECUTE 'CREATE INDEX IF NOT EXISTS "support_case_party_idx"  ON "support_case" ("tenant_id", "party_id")';
  EXECUTE 'CREATE INDEX IF NOT EXISTS "support_case_status_idx" ON "support_case" ("tenant_id", "status")';
  EXECUTE 'CREATE INDEX IF NOT EXISTS "support_case_due_idx"    ON "support_case" ("tenant_id", "due_at")';
  EXECUTE 'CREATE INDEX IF NOT EXISTS "support_case_remind_idx" ON "support_case" ("tenant_id", "remind_at")';
END $$;

-- 3. Sequence for human-friendly numbers (CSE-7000 onwards).
CREATE SEQUENCE IF NOT EXISTS seq_support_case START 7000;

-- Bump past any existing CSE-* numbers (idempotent).
DO $$
BEGIN
  PERFORM setval('seq_support_case', GREATEST(
    nextval('seq_support_case'),
    COALESCE((SELECT MAX(NULLIF(regexp_replace(number, '\D', '', 'g'), ''))::int FROM work_item WHERE type = 'support_case'), 7000)
  ));
END $$;

-- 4. RLS.
DO $$
DECLARE has_supportcase boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'support_case' AND relkind = 'r') INTO has_supportcase;
  IF NOT has_supportcase THEN RETURN; END IF;

  EXECUTE 'ALTER TABLE "support_case" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE "support_case" FORCE  ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS "support_case_tenant_isolation" ON "support_case"';
  EXECUTE 'CREATE POLICY "support_case_tenant_isolation" ON "support_case"
    USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
    WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL)';
END $$;

-- 5. Grants for the app role.
DO $$
DECLARE has_supportcase boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'support_case' AND relkind = 'r') INTO has_supportcase;
  IF has_supportcase THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "support_case" TO decrm_app';
  END IF;
END $$;
GRANT USAGE ON SEQUENCE seq_support_case TO decrm_app;

-- 6. updated_at trigger.
DO $$
DECLARE has_supportcase boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'support_case' AND relkind = 'r') INTO has_supportcase;
  IF NOT has_supportcase THEN RETURN; END IF;

  EXECUTE 'DROP TRIGGER IF EXISTS support_case_updated_at ON "support_case"';
  EXECUTE 'CREATE TRIGGER support_case_updated_at BEFORE UPDATE ON "support_case"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
END $$;
