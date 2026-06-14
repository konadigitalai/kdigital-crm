-- Slack integration — outbound notification rules + delivery log + a
-- placeholder workspace table reserved for the v2 bot-token flow.
--
-- v1 ships with `slack_rule.webhook_url` populated (incoming-webhook URL
-- pasted by an admin). v2 will populate `slack_workspace.bot_token` per
-- tenant and rules will reference a channel by name; the schema is laid
-- out so that swap is a non-breaking insert + a column flip.
--
-- Idempotent. Safe to re-run on every db:migrate.

-- ─── slack_rule ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "slack_rule" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"    uuid NOT NULL,
  "name"         text NOT NULL,
  "event_type"   text NOT NULL,
  "enabled"      boolean NOT NULL DEFAULT true,
  "filter"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "webhook_url"  text,
  "channel"      text,
  "template"     text,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_rule_tenant_fk') THEN
    ALTER TABLE "slack_rule" ADD CONSTRAINT "slack_rule_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_rule_event_type_check') THEN
    ALTER TABLE "slack_rule" ADD CONSTRAINT "slack_rule_event_type_check"
      CHECK (event_type IN ('lead.created','case.opened','case.closed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_rule_name_len_check') THEN
    ALTER TABLE "slack_rule" ADD CONSTRAINT "slack_rule_name_len_check"
      CHECK (char_length(name) BETWEEN 1 AND 80);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "slack_rule_tenant_event_idx"
  ON "slack_rule" ("tenant_id", "event_type", "enabled");

ALTER TABLE "slack_rule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_rule" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "slack_rule_tenant_isolation" ON "slack_rule";
CREATE POLICY "slack_rule_tenant_isolation" ON "slack_rule"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "slack_rule" TO decrm_app;

DROP TRIGGER IF EXISTS slack_rule_updated_at ON "slack_rule";
CREATE TRIGGER slack_rule_updated_at BEFORE UPDATE ON "slack_rule"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── slack_delivery_log ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "slack_delivery_log" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"    uuid NOT NULL,
  "rule_id"      uuid,
  "event_type"   text NOT NULL,
  "status"       text NOT NULL,
  "http_status"  integer,
  "response"     text,
  "context"      jsonb NOT NULL DEFAULT '{}'::jsonb,
  "sent_at"      timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_delivery_log_tenant_fk') THEN
    ALTER TABLE "slack_delivery_log" ADD CONSTRAINT "slack_delivery_log_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_delivery_log_rule_fk') THEN
    ALTER TABLE "slack_delivery_log" ADD CONSTRAINT "slack_delivery_log_rule_fk"
      FOREIGN KEY ("rule_id") REFERENCES "slack_rule"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_delivery_log_status_check') THEN
    ALTER TABLE "slack_delivery_log" ADD CONSTRAINT "slack_delivery_log_status_check"
      CHECK (status IN ('ok','error'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "slack_delivery_log_tenant_sent_idx"
  ON "slack_delivery_log" ("tenant_id", "sent_at" DESC);

ALTER TABLE "slack_delivery_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_delivery_log" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "slack_delivery_log_tenant_isolation" ON "slack_delivery_log";
CREATE POLICY "slack_delivery_log_tenant_isolation" ON "slack_delivery_log"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "slack_delivery_log" TO decrm_app;

-- ─── slack_workspace (placeholder for v2) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS "slack_workspace" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"     uuid NOT NULL,
  "team_id"       text,
  "team_name"     text,
  "bot_token"     text,
  "installed_at"  timestamp with time zone,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"    timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_workspace_tenant_fk') THEN
    ALTER TABLE "slack_workspace" ADD CONSTRAINT "slack_workspace_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "slack_workspace_tenant_unique"
  ON "slack_workspace" ("tenant_id");

ALTER TABLE "slack_workspace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_workspace" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "slack_workspace_tenant_isolation" ON "slack_workspace";
CREATE POLICY "slack_workspace_tenant_isolation" ON "slack_workspace"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "slack_workspace" TO decrm_app;

DROP TRIGGER IF EXISTS slack_workspace_updated_at ON "slack_workspace";
CREATE TRIGGER slack_workspace_updated_at BEFORE UPDATE ON "slack_workspace"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── seed integrations.* on the Administrators system group per tenant ───

INSERT INTO user_group_permission (group_id, permission)
SELECT g.id, perm
FROM user_group g
CROSS JOIN (VALUES ('integrations.read'), ('integrations.manage')) AS p(perm)
WHERE g.name = 'Administrators' AND g.is_system = true
ON CONFLICT DO NOTHING;
