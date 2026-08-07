-- Per-CRM-user Slack account link. When an operator clicks "Connect Slack"
-- on a record page, Slack's OAuth v2 user flow returns an xoxp-… user
-- token scoped to their account. We store it here so the "Share to Slack"
-- dialog can:
--   - list channels THEY are in (via conversations.list called with THEIR
--     token, filtered is_member=true),
--   - post messages AS THEM (chat.postMessage with the user token),
--   - avoid Slack workspace-admin approval for auto-joining channels.
--
-- One row per (tenant, app_user). Reconnecting overwrites the token.
--
-- Idempotent — safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS "slack_user_link" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"      uuid NOT NULL,
  "app_user_id"    uuid NOT NULL,
  "slack_user_id"  text NOT NULL,       -- "U0123456"
  "slack_team_id"  text,                -- Slack workspace id
  "user_token"     text NOT NULL,       -- xoxp-…
  "scopes"         text,                -- CSV of scopes actually granted
  "connected_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at"     timestamp with time zone,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"     timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_user_link_tenant_fk') THEN
    ALTER TABLE "slack_user_link" ADD CONSTRAINT "slack_user_link_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_user_link_app_user_fk') THEN
    ALTER TABLE "slack_user_link" ADD CONSTRAINT "slack_user_link_app_user_fk"
      FOREIGN KEY ("app_user_id") REFERENCES "app_user"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- Only one active link per CRM user.
CREATE UNIQUE INDEX IF NOT EXISTS "slack_user_link_app_user_key"
  ON "slack_user_link" ("app_user_id");

CREATE INDEX IF NOT EXISTS "slack_user_link_tenant_idx"
  ON "slack_user_link" ("tenant_id");

ALTER TABLE "slack_user_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_user_link" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "slack_user_link_tenant_isolation" ON "slack_user_link";
CREATE POLICY "slack_user_link_tenant_isolation" ON "slack_user_link"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "slack_user_link" TO decrm_app;

DROP TRIGGER IF EXISTS slack_user_link_updated_at ON "slack_user_link";
CREATE TRIGGER slack_user_link_updated_at BEFORE UPDATE ON "slack_user_link"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
