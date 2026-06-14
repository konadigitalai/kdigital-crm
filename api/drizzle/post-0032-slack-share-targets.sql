-- Slack manual-share targets — one row per surface (leads | learners | cases)
-- per tenant. Click "Share to Slack" on a record → API renders a preview using
-- the configured field whitelist + webhook → user adds notes → POST.
--
-- Distinct from `slack_rule` (which is for *automated* event-driven posts).
-- Both end up logged in `slack_delivery_log`, just with different rule_id /
-- context shapes.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS "slack_share_target" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"      uuid NOT NULL,
  "surface"        text NOT NULL,                    -- 'leads' | 'learners' | 'cases'
  "enabled"        boolean NOT NULL DEFAULT true,
  "channel"        text,                             -- FYI label, e.g. '#sales-leads'
  "webhook_url"    text,
  "field_keys"     text[] NOT NULL DEFAULT '{}'::text[],  -- whitelist of fields to include in the preview
  "header_template" text,                            -- optional override; default depends on surface
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"     timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_share_target_tenant_fk') THEN
    ALTER TABLE "slack_share_target" ADD CONSTRAINT "slack_share_target_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_share_target_surface_check') THEN
    ALTER TABLE "slack_share_target" ADD CONSTRAINT "slack_share_target_surface_check"
      CHECK (surface IN ('leads','learners','cases'));
  END IF;
END $$;

-- One row per (tenant, surface). UPSERT logic in the API hangs off this.
CREATE UNIQUE INDEX IF NOT EXISTS "slack_share_target_tenant_surface_key"
  ON "slack_share_target" ("tenant_id", "surface");

ALTER TABLE "slack_share_target" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_share_target" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "slack_share_target_tenant_isolation" ON "slack_share_target";
CREATE POLICY "slack_share_target_tenant_isolation" ON "slack_share_target"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "slack_share_target" TO decrm_app;

DROP TRIGGER IF EXISTS slack_share_target_updated_at ON "slack_share_target";
CREATE TRIGGER slack_share_target_updated_at BEFORE UPDATE ON "slack_share_target"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
