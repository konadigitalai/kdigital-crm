-- Phase G: Ticket module (ServiceNow-style support cases).
--   - widen work_item_type_check to include 'ticket'
--   - new `ticket` extension table (1:1 with work_item)
--   - seq_ticket sequence + bump past existing TKT-* numbers
--   - RLS + grants
-- Idempotent. Safe to re-run.

-- 1. Widen work_item.type CHECK to include 'ticket'.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_item_type_check') THEN
    ALTER TABLE "work_item" DROP CONSTRAINT "work_item_type_check";
  END IF;
END $$;

ALTER TABLE "work_item"
  ADD CONSTRAINT "work_item_type_check"
  CHECK (type IN ('lead','deal','service_case','onboarding_task','agent_run','ticket'));

-- 2. ticket table.
CREATE TABLE IF NOT EXISTS "ticket" (
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

-- FKs
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_work_item_id_work_item_id_fk') THEN
    ALTER TABLE "ticket" ADD CONSTRAINT "ticket_work_item_id_work_item_id_fk"
      FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_tenant_id_tenant_id_fk') THEN
    ALTER TABLE "ticket" ADD CONSTRAINT "ticket_tenant_id_tenant_id_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_party_id_party_id_fk') THEN
    ALTER TABLE "ticket" ADD CONSTRAINT "ticket_party_id_party_id_fk"
      FOREIGN KEY ("party_id") REFERENCES "party"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_created_by_id_app_user_id_fk') THEN
    ALTER TABLE "ticket" ADD CONSTRAINT "ticket_created_by_id_app_user_id_fk"
      FOREIGN KEY ("created_by_id") REFERENCES "app_user"("id");
  END IF;
END $$;

-- Domain checks
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_requester_kind_check') THEN
    ALTER TABLE "ticket" ADD CONSTRAINT "ticket_requester_kind_check"
      CHECK (requester_kind IN ('lead','learner','external'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_status_check') THEN
    ALTER TABLE "ticket" ADD CONSTRAINT "ticket_status_check"
      CHECK (status IN ('open','in_progress','pending','resolved','closed','cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_category_check') THEN
    ALTER TABLE "ticket" ADD CONSTRAINT "ticket_category_check"
      CHECK (category IN ('billing','technical','content_lms','onboarding','cohort_batch','refund','certificate','other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_priority_check') THEN
    ALTER TABLE "ticket" ADD CONSTRAINT "ticket_priority_check"
      CHECK (priority BETWEEN 1 AND 4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_resolution_code_check') THEN
    ALTER TABLE "ticket" ADD CONSTRAINT "ticket_resolution_code_check"
      CHECK (resolution_code IS NULL OR resolution_code IN ('fixed','duplicate','wont_fix','no_action'));
  END IF;
  -- Resolution-required-at-close. Belt and braces with the route check.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_closed_has_resolution') THEN
    ALTER TABLE "ticket" ADD CONSTRAINT "ticket_closed_has_resolution"
      CHECK (status <> 'closed' OR (resolution IS NOT NULL AND length(trim(resolution)) > 0));
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS "ticket_party_idx"       ON "ticket" ("tenant_id", "party_id");
CREATE INDEX IF NOT EXISTS "ticket_status_idx"      ON "ticket" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "ticket_due_idx"         ON "ticket" ("tenant_id", "due_at");
CREATE INDEX IF NOT EXISTS "ticket_remind_idx"      ON "ticket" ("tenant_id", "remind_at");

-- 3. Sequence for human-friendly numbers (TKT-7000 onwards).
CREATE SEQUENCE IF NOT EXISTS seq_ticket START 7000;

-- Bump past any existing TKT-* numbers (idempotent).
DO $$
BEGIN
  PERFORM setval('seq_ticket', GREATEST(
    nextval('seq_ticket'),
    COALESCE((SELECT MAX(NULLIF(regexp_replace(number, '\D', '', 'g'), ''))::int FROM work_item WHERE type = 'ticket'), 7000)
  ));
END $$;

-- 4. RLS — same pattern as post-0003-rls.sql.
ALTER TABLE "ticket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ticket_tenant_isolation" ON "ticket";
CREATE POLICY "ticket_tenant_isolation" ON "ticket"
  USING (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

-- 5. Grants for the app role.
GRANT SELECT, INSERT, UPDATE, DELETE ON "ticket" TO decrm_app;
GRANT USAGE ON SEQUENCE seq_ticket TO decrm_app;

-- 6. updated_at trigger (mirror post-0005-updated-at.sql for `ticket`).
DROP TRIGGER IF EXISTS ticket_updated_at ON "ticket";
CREATE TRIGGER ticket_updated_at BEFORE UPDATE ON "ticket"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
