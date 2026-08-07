-- WhatsApp automations.
--
-- Two tables:
--   wa_automation       — the rule (trigger + ordered action list)
--   wa_automation_run   — execution audit (one row per fire)
--
-- Triggers (v1):
--   - inbound_message_keyword: fires when an inbound wa_message body
--     matches a keyword/regex.
--   - new_contact: fires when we first see a phone number that wasn't a
--     party before.
--   - lead_created: fires when emitEvent('lead.created') fans out.
--
-- Actions (v1):
--   - send_template: send an approved template (positional vars).
--   - send_text: only if conversation is in 24h window.
--   - add_tag: attach a wa_tag to the party.
--   - assign_user: set wa_conversation.assigned_user_id.
--   - set_status: set wa_conversation.status.
--
-- Conditions live in trigger.config (e.g. keyword regex, lead source filter).
-- The runner is in api/src/lib/whatsapp/automations.ts.

CREATE TABLE IF NOT EXISTS "wa_automation" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   uuid NOT NULL,
  "name"        text NOT NULL,
  "description" text,
  "trigger"     jsonb NOT NULL,                  -- { type, config }
  "actions"     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ordered list of { type, config }
  "enabled"     boolean NOT NULL DEFAULT false,
  "created_by"  uuid,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_automation_tenant_fk') THEN
    ALTER TABLE "wa_automation" ADD CONSTRAINT "wa_automation_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_automation_creator_fk') THEN
    ALTER TABLE "wa_automation" ADD CONSTRAINT "wa_automation_creator_fk"
      FOREIGN KEY ("created_by") REFERENCES "app_user"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_automation_name_len_check') THEN
    ALTER TABLE "wa_automation" ADD CONSTRAINT "wa_automation_name_len_check"
      CHECK (char_length(name) BETWEEN 1 AND 120);
  END IF;
END $$;

-- Look up enabled automations by trigger type — small table, but the
-- WHERE condition lets us skip disabled rules cheaply.
CREATE INDEX IF NOT EXISTS "wa_automation_tenant_trigger_idx"
  ON "wa_automation" ("tenant_id", (trigger->>'type'))
  WHERE enabled = true;

ALTER TABLE "wa_automation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wa_automation" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wa_automation_tenant_isolation" ON "wa_automation";
CREATE POLICY "wa_automation_tenant_isolation" ON "wa_automation"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "wa_automation" TO decrm_app;

DROP TRIGGER IF EXISTS wa_automation_updated_at ON "wa_automation";
CREATE TRIGGER wa_automation_updated_at BEFORE UPDATE ON "wa_automation"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── wa_automation_run ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "wa_automation_run" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"        uuid NOT NULL,
  "automation_id"    uuid NOT NULL,
  "party_id"         uuid,
  "conversation_id"  uuid,
  "status"           text NOT NULL DEFAULT 'running',  -- 'running'|'completed'|'failed'|'skipped'
  "context"          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- the trigger event payload (redacted)
  "actions_log"      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- per-action {type, ok, error}
  "error_message"    text,
  "started_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at"     timestamp with time zone
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_automation_run_tenant_fk') THEN
    ALTER TABLE "wa_automation_run" ADD CONSTRAINT "wa_automation_run_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_automation_run_automation_fk') THEN
    ALTER TABLE "wa_automation_run" ADD CONSTRAINT "wa_automation_run_automation_fk"
      FOREIGN KEY ("automation_id") REFERENCES "wa_automation"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_automation_run_party_fk') THEN
    ALTER TABLE "wa_automation_run" ADD CONSTRAINT "wa_automation_run_party_fk"
      FOREIGN KEY ("party_id") REFERENCES "party"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_automation_run_conv_fk') THEN
    ALTER TABLE "wa_automation_run" ADD CONSTRAINT "wa_automation_run_conv_fk"
      FOREIGN KEY ("conversation_id") REFERENCES "wa_conversation"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_automation_run_status_check') THEN
    ALTER TABLE "wa_automation_run" ADD CONSTRAINT "wa_automation_run_status_check"
      CHECK (status IN ('running', 'completed', 'failed', 'skipped'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "wa_automation_run_automation_started_idx"
  ON "wa_automation_run" ("automation_id", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "wa_automation_run_tenant_started_idx"
  ON "wa_automation_run" ("tenant_id", "started_at" DESC);

ALTER TABLE "wa_automation_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wa_automation_run" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wa_automation_run_tenant_isolation" ON "wa_automation_run";
CREATE POLICY "wa_automation_run_tenant_isolation" ON "wa_automation_run"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "wa_automation_run" TO decrm_app;
