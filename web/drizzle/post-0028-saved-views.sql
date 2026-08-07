-- Saved views — per-user (or shared with the tenant) snapshots of a list
-- view's filter rules + column visibility/order. Used right now by the
-- pipeline list; the `scope` column lets us add other lists later
-- (cases list, learners list, etc.) without a new table per surface.
--
-- Idempotent. Safe to re-run.

CREATE TABLE IF NOT EXISTS "saved_view" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   uuid NOT NULL,
  "owner_id"    uuid NOT NULL,                          -- the user who created it
  "scope"       text NOT NULL,                          -- e.g. 'pipeline_list'
  "name"        text NOT NULL,
  "visibility"  text NOT NULL DEFAULT 'personal',       -- 'personal' | 'shared'
  "filter"      jsonb NOT NULL DEFAULT '{}'::jsonb,     -- shape: { rules: [...] }
  "columns"     text[],                                 -- visible column keys, in display order
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_view_tenant_fk') THEN
    ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_view_owner_fk') THEN
    ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_owner_fk"
      FOREIGN KEY ("owner_id") REFERENCES "app_user"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_view_visibility_check') THEN
    ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_visibility_check"
      CHECK (visibility IN ('personal', 'shared'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "saved_view_owner_scope_idx"
  ON "saved_view" ("tenant_id", "owner_id", "scope");
CREATE INDEX IF NOT EXISTS "saved_view_shared_scope_idx"
  ON "saved_view" ("tenant_id", "scope") WHERE visibility = 'shared';

-- RLS — tenant isolation. Visibility (personal vs shared) is enforced at the
-- route level (filtering by owner_id when reading; visibility-check on writes
-- so a non-admin can't promote their view to shared if we don't allow it).
ALTER TABLE "saved_view" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saved_view" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "saved_view_tenant_isolation" ON "saved_view";
CREATE POLICY "saved_view_tenant_isolation" ON "saved_view"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "saved_view" TO decrm_app;

-- updated_at trigger (mirrors post-0005-updated-at.sql).
DROP TRIGGER IF EXISTS saved_view_updated_at ON "saved_view";
CREATE TRIGGER saved_view_updated_at BEFORE UPDATE ON "saved_view"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
