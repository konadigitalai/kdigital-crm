-- Slack directory cache — public/private channels the bot can see, and
-- active workspace users. Both are hydrated by a periodic sync (or an
-- admin-triggered refresh) against Slack's Web API, so the "share to
-- Slack" dialog can render a picker without hitting Slack on every open.
--
-- Why cache: users.list + conversations.list are rate-limited (Tier 2 &
-- 3, ~20–50 rpm) and the payload can be large. Caching lets the picker
-- feel instant.
--
-- Idempotent — safe to re-run.

BEGIN;

-- ── Channels ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "slack_channel_cache" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"    uuid NOT NULL,
  "slack_id"     text NOT NULL,          -- "C0123456"
  "name"         text NOT NULL,          -- "leads"  (no leading #)
  "is_private"   boolean NOT NULL DEFAULT false,
  "is_archived"  boolean NOT NULL DEFAULT false,
  "is_member"    boolean NOT NULL DEFAULT false, -- whether the bot has joined
  "topic"        text,
  "synced_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_channel_cache_tenant_fk') THEN
    ALTER TABLE "slack_channel_cache" ADD CONSTRAINT "slack_channel_cache_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "slack_channel_cache_tenant_slack_id_key"
  ON "slack_channel_cache" ("tenant_id", "slack_id");

CREATE INDEX IF NOT EXISTS "slack_channel_cache_tenant_name_idx"
  ON "slack_channel_cache" ("tenant_id", "name");

ALTER TABLE "slack_channel_cache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_channel_cache" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "slack_channel_cache_tenant_isolation" ON "slack_channel_cache";
CREATE POLICY "slack_channel_cache_tenant_isolation" ON "slack_channel_cache"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "slack_channel_cache" TO decrm_app;

DROP TRIGGER IF EXISTS slack_channel_cache_updated_at ON "slack_channel_cache";
CREATE TRIGGER slack_channel_cache_updated_at BEFORE UPDATE ON "slack_channel_cache"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Users ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "slack_user_cache" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"     uuid NOT NULL,
  "slack_id"      text NOT NULL,         -- "U0123456"
  "name"          text NOT NULL,         -- login handle
  "real_name"     text,                  -- display name / real name
  "display_name"  text,                  -- Slack "display name" field
  "email"         text,                  -- may be null depending on scopes
  "is_bot"        boolean NOT NULL DEFAULT false,
  "is_deleted"    boolean NOT NULL DEFAULT false,
  "image_url"     text,                  -- avatar
  "synced_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"    timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_user_cache_tenant_fk') THEN
    ALTER TABLE "slack_user_cache" ADD CONSTRAINT "slack_user_cache_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "slack_user_cache_tenant_slack_id_key"
  ON "slack_user_cache" ("tenant_id", "slack_id");

CREATE INDEX IF NOT EXISTS "slack_user_cache_tenant_name_idx"
  ON "slack_user_cache" ("tenant_id", "name");

ALTER TABLE "slack_user_cache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_user_cache" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "slack_user_cache_tenant_isolation" ON "slack_user_cache";
CREATE POLICY "slack_user_cache_tenant_isolation" ON "slack_user_cache"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "slack_user_cache" TO decrm_app;

DROP TRIGGER IF EXISTS slack_user_cache_updated_at ON "slack_user_cache";
CREATE TRIGGER slack_user_cache_updated_at BEFORE UPDATE ON "slack_user_cache"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
