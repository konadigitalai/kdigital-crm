-- Phase F: Edify Agent — home-page CRM chat assistant.
-- Logs each {question, answer, citations, suggestedAction} per user so the
-- home command box and the /agents/edify page can show recent history.
-- Idempotent.

CREATE TABLE IF NOT EXISTS "edify_chat_message" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   uuid NOT NULL,
  "user_id"     uuid NOT NULL,
  "asked_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "question"    text NOT NULL,
  "answer"      text NOT NULL,
  "citations"   jsonb,
  "suggested"   jsonb,
  "model"       text,
  "tokens_in"   integer,
  "tokens_out"  integer
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edify_chat_tenant_fk') THEN
    ALTER TABLE "edify_chat_message" ADD CONSTRAINT "edify_chat_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edify_chat_user_fk') THEN
    ALTER TABLE "edify_chat_message" ADD CONSTRAINT "edify_chat_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "edify_chat_user_time_idx"
  ON "edify_chat_message" ("tenant_id", "user_id", "asked_at" DESC);

ALTER TABLE "edify_chat_message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "edify_chat_message" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "edify_chat_tenant_isolation" ON "edify_chat_message";
CREATE POLICY "edify_chat_tenant_isolation" ON "edify_chat_message"
  USING (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "edify_chat_message" TO decrm_app;

-- Insert the Edify chat agent into every tenant's catalog (idempotent).
INSERT INTO agent (tenant_id, key, name, domain, operates_on, enabled, config)
SELECT t.id, 'edify', 'Edify Agent', 'sales', 'lead', true, '{}'::jsonb
FROM tenant t
ON CONFLICT (tenant_id, key) DO NOTHING;
