-- Per-user preferences for saved-view tabs. Lets each user:
--   - HIDE any saved_view (own or shared) from their personal tab strip
--   - REORDER tabs in the strip
--
-- One row per (user, view) — a row EXISTS only when the user has an
-- explicit preference. Absent rows use defaults (visible, natural order
-- from the saved_view creation).
--
-- Idempotent — safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS "user_view_preference" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"    uuid NOT NULL,
  "user_id"      uuid NOT NULL,           -- the CRM user (app_user.id)
  "view_id"      uuid,                    -- NULL for the implicit "All leads" default; else saved_view.id
  "scope"        text NOT NULL,           -- 'pipeline_list' etc. (matches saved_view.scope)
  "hidden"       boolean NOT NULL DEFAULT false,
  "sort_order"   integer NOT NULL DEFAULT 0,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_view_preference_tenant_fk') THEN
    ALTER TABLE "user_view_preference" ADD CONSTRAINT "user_view_preference_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_view_preference_user_fk') THEN
    ALTER TABLE "user_view_preference" ADD CONSTRAINT "user_view_preference_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE;
  END IF;
  -- Deliberately NO FK to saved_view — view_id is NULL for the "All leads"
  -- pseudo-view, and the tenant admins may hard-delete a saved_view that
  -- users still have preferences for (in which case the pref row becomes
  -- inert and can be reaped later).
END $$;

-- One preference per (user, view). NULL view_id represents the implicit
-- "All leads" tab, so we need a partial unique index for that case too.
CREATE UNIQUE INDEX IF NOT EXISTS "user_view_preference_user_view_key"
  ON "user_view_preference" ("user_id", "view_id")
  WHERE view_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "user_view_preference_user_default_key"
  ON "user_view_preference" ("user_id", "scope")
  WHERE view_id IS NULL;

CREATE INDEX IF NOT EXISTS "user_view_preference_scope_idx"
  ON "user_view_preference" ("tenant_id", "user_id", "scope");

ALTER TABLE "user_view_preference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_view_preference" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_view_preference_tenant_isolation" ON "user_view_preference";
CREATE POLICY "user_view_preference_tenant_isolation" ON "user_view_preference"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "user_view_preference" TO decrm_app;

DROP TRIGGER IF EXISTS user_view_preference_updated_at ON "user_view_preference";
CREATE TRIGGER user_view_preference_updated_at BEFORE UPDATE ON "user_view_preference"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
