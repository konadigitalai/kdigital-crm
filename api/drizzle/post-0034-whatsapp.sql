-- WhatsApp via Meta Cloud API — Phase 1 schema.
--
-- Six tables today:
--   wa_config           — per-tenant Meta credentials + connection status
--   wa_template         — synced from Meta (read-only locally)
--   wa_tag              — per-tenant color-coded labels for parties
--   wa_party_tag        — many-to-many between party and wa_tag
--   wa_conversation     — one row per (tenant, party) for the inbox
--   wa_message          — every inbound + outbound message
--
-- Phases 2 and beyond add wa_broadcast, wa_broadcast_recipient,
-- wa_automation, wa_automation_run as separate post-NNNN migrations so
-- the diff stays scoped per phase.
--
-- Idempotent. Mirrors post-0029-slack-integration.sql for RLS, GRANTs,
-- updated_at trigger.

-- ─── wa_config ────────────────────────────────────────────────────────────
-- One row per tenant. Holds plaintext Meta credentials (matches the
-- slack_rule.webhook_url precedent — encryption-at-rest deferred).
--
-- The three "setup" timestamps map to the three calls Meta requires before
-- inbound webhooks actually route to our app:
--   1. /verify on save     → connected_at
--   2. /{phone_number_id}/register     → registered_at
--   3. /{waba_id}/subscribed_apps      → subscribed_at
-- All three must be non-null for the integration to be fully wired. The
-- admin UI exposes each as a separate button so users see exactly which
-- step is incomplete.

CREATE TABLE IF NOT EXISTS "wa_config" (
  "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"              uuid NOT NULL,
  "phone_number_id"        text,
  "waba_id"                text,
  "app_id"                 text,
  "app_secret"             text,
  "system_user_token"      text,
  "webhook_verify_token"   text,
  "display_phone_number"   text,
  "verified_name"          text,
  "quality_rating"         text,
  "status"                 text NOT NULL DEFAULT 'disconnected',
  "connected_at"           timestamp with time zone,
  "registered_at"          timestamp with time zone,
  "subscribed_at"          timestamp with time zone,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_config_tenant_fk') THEN
    ALTER TABLE "wa_config" ADD CONSTRAINT "wa_config_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_config_status_check') THEN
    ALTER TABLE "wa_config" ADD CONSTRAINT "wa_config_status_check"
      CHECK (status IN ('disconnected', 'connected'));
  END IF;
END $$;

-- One config row per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "wa_config_tenant_unique"
  ON "wa_config" ("tenant_id");
-- Webhook receiver looks up the tenant by waba_id (Meta sends WABA id in
-- the payload's entry[0].id). Partial index so duplicate NULLs don't
-- collide before someone configures.
CREATE UNIQUE INDEX IF NOT EXISTS "wa_config_waba_id_unique"
  ON "wa_config" ("waba_id") WHERE "waba_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "wa_config_phone_number_id_unique"
  ON "wa_config" ("phone_number_id") WHERE "phone_number_id" IS NOT NULL;

ALTER TABLE "wa_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wa_config" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wa_config_tenant_isolation" ON "wa_config";
CREATE POLICY "wa_config_tenant_isolation" ON "wa_config"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "wa_config" TO decrm_app;

DROP TRIGGER IF EXISTS wa_config_updated_at ON "wa_config";
CREATE TRIGGER wa_config_updated_at BEFORE UPDATE ON "wa_config"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── wa_template ──────────────────────────────────────────────────────────
-- Local cache of Meta templates. Synced via GET /{waba_id}/message_templates;
-- never authored from the CRM (Meta dashboard is source of truth for approval
-- state).

CREATE TABLE IF NOT EXISTS "wa_template" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"        uuid NOT NULL,
  "template_name"    text NOT NULL,
  "language"         text NOT NULL DEFAULT 'en_US',
  "category"         text NOT NULL,
  "header_type"      text,
  "header_content"   text,
  "body_text"        text NOT NULL,
  "footer_text"      text,
  "buttons"          jsonb,
  "variable_count"   integer NOT NULL DEFAULT 0,
  "status"           text NOT NULL DEFAULT 'pending',
  "last_synced_at"   timestamp with time zone,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_template_tenant_fk') THEN
    ALTER TABLE "wa_template" ADD CONSTRAINT "wa_template_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_template_category_check') THEN
    ALTER TABLE "wa_template" ADD CONSTRAINT "wa_template_category_check"
      CHECK (category IN ('UTILITY', 'MARKETING', 'AUTHENTICATION'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_template_status_check') THEN
    ALTER TABLE "wa_template" ADD CONSTRAINT "wa_template_status_check"
      CHECK (status IN ('approved', 'pending', 'rejected', 'paused'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_template_header_type_check') THEN
    ALTER TABLE "wa_template" ADD CONSTRAINT "wa_template_header_type_check"
      CHECK (header_type IS NULL OR header_type IN ('text', 'image', 'video', 'document'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "wa_template_tenant_name_lang_key"
  ON "wa_template" ("tenant_id", "template_name", "language");
CREATE INDEX IF NOT EXISTS "wa_template_tenant_status_idx"
  ON "wa_template" ("tenant_id", "status");

ALTER TABLE "wa_template" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wa_template" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wa_template_tenant_isolation" ON "wa_template";
CREATE POLICY "wa_template_tenant_isolation" ON "wa_template"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "wa_template" TO decrm_app;

DROP TRIGGER IF EXISTS wa_template_updated_at ON "wa_template";
CREATE TRIGGER wa_template_updated_at BEFORE UPDATE ON "wa_template"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── wa_tag + wa_party_tag ────────────────────────────────────────────────
-- Tags are an inbox concept; they decorate parties in the WhatsApp surface.
-- Different from user_group / user_group_permission which are about app
-- access control.

CREATE TABLE IF NOT EXISTS "wa_tag" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   uuid NOT NULL,
  "name"        text NOT NULL,
  "color"       text NOT NULL DEFAULT '#3b82f6',
  "created_at"  timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_tag_tenant_fk') THEN
    ALTER TABLE "wa_tag" ADD CONSTRAINT "wa_tag_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_tag_name_len_check') THEN
    ALTER TABLE "wa_tag" ADD CONSTRAINT "wa_tag_name_len_check"
      CHECK (char_length(name) BETWEEN 1 AND 40);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "wa_tag_tenant_name_key"
  ON "wa_tag" ("tenant_id", lower("name"));

ALTER TABLE "wa_tag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wa_tag" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wa_tag_tenant_isolation" ON "wa_tag";
CREATE POLICY "wa_tag_tenant_isolation" ON "wa_tag"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "wa_tag" TO decrm_app;

CREATE TABLE IF NOT EXISTS "wa_party_tag" (
  "tenant_id"  uuid NOT NULL,
  "party_id"   uuid NOT NULL,
  "tag_id"     uuid NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("party_id", "tag_id")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_party_tag_tenant_fk') THEN
    ALTER TABLE "wa_party_tag" ADD CONSTRAINT "wa_party_tag_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_party_tag_party_fk') THEN
    ALTER TABLE "wa_party_tag" ADD CONSTRAINT "wa_party_tag_party_fk"
      FOREIGN KEY ("party_id") REFERENCES "party"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_party_tag_tag_fk') THEN
    ALTER TABLE "wa_party_tag" ADD CONSTRAINT "wa_party_tag_tag_fk"
      FOREIGN KEY ("tag_id") REFERENCES "wa_tag"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "wa_party_tag_tag_idx" ON "wa_party_tag" ("tag_id");
CREATE INDEX IF NOT EXISTS "wa_party_tag_party_idx" ON "wa_party_tag" ("party_id");

ALTER TABLE "wa_party_tag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wa_party_tag" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wa_party_tag_tenant_isolation" ON "wa_party_tag";
CREATE POLICY "wa_party_tag_tenant_isolation" ON "wa_party_tag"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "wa_party_tag" TO decrm_app;

-- ─── wa_conversation ──────────────────────────────────────────────────────
-- One row per (tenant, party). The inbox UI lists these; the thread view
-- pulls wa_message rows joined to one. Updated by:
--   - inbound webhook (last_message_at, last_inbound_at, unread_count++)
--   - outbound send  (last_message_at, last_message_text)
--   - explicit UI actions (status, assigned_user_id, mark-read)

CREATE TABLE IF NOT EXISTS "wa_conversation" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           uuid NOT NULL,
  "party_id"            uuid NOT NULL,
  "status"              text NOT NULL DEFAULT 'open',
  "assigned_user_id"    uuid,
  "last_message_text"   text,
  "last_message_at"     timestamp with time zone,
  "last_inbound_at"     timestamp with time zone,
  "unread_count"        integer NOT NULL DEFAULT 0,
  "labels"              text[] NOT NULL DEFAULT '{}'::text[],
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_conversation_tenant_fk') THEN
    ALTER TABLE "wa_conversation" ADD CONSTRAINT "wa_conversation_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_conversation_party_fk') THEN
    ALTER TABLE "wa_conversation" ADD CONSTRAINT "wa_conversation_party_fk"
      FOREIGN KEY ("party_id") REFERENCES "party"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_conversation_assigned_fk') THEN
    ALTER TABLE "wa_conversation" ADD CONSTRAINT "wa_conversation_assigned_fk"
      FOREIGN KEY ("assigned_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_conversation_status_check') THEN
    ALTER TABLE "wa_conversation" ADD CONSTRAINT "wa_conversation_status_check"
      CHECK (status IN ('open', 'pending', 'closed'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "wa_conversation_tenant_party_key"
  ON "wa_conversation" ("tenant_id", "party_id");
-- Inbox-list query: ORDER BY last_message_at DESC inside a tenant + status.
CREATE INDEX IF NOT EXISTS "wa_conversation_tenant_status_idx"
  ON "wa_conversation" ("tenant_id", "status", "last_message_at" DESC);
-- "Mine" filter: assigned_user_id + status.
CREATE INDEX IF NOT EXISTS "wa_conversation_assignee_idx"
  ON "wa_conversation" ("tenant_id", "assigned_user_id", "status")
  WHERE "assigned_user_id" IS NOT NULL;

ALTER TABLE "wa_conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wa_conversation" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wa_conversation_tenant_isolation" ON "wa_conversation";
CREATE POLICY "wa_conversation_tenant_isolation" ON "wa_conversation"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "wa_conversation" TO decrm_app;

DROP TRIGGER IF EXISTS wa_conversation_updated_at ON "wa_conversation";
CREATE TRIGGER wa_conversation_updated_at BEFORE UPDATE ON "wa_conversation"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── wa_message ───────────────────────────────────────────────────────────
-- Every inbound + outbound message. provider_message_id is the wamid Meta
-- returns (or sends in webhooks); UNIQUE WHERE NOT NULL prevents the
-- duplicate inbound rows that would otherwise come from Meta's webhook
-- retry behaviour on non-200 acks.

CREATE TABLE IF NOT EXISTS "wa_message" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"                uuid NOT NULL,
  "conversation_id"          uuid NOT NULL,
  "direction"                text NOT NULL,
  "sender_type"              text NOT NULL,
  "sender_user_id"           uuid,
  "content_type"             text NOT NULL DEFAULT 'text',
  "body"                     text,
  "media_url"                text,
  "media_mime"               text,
  "template_name"            text,
  "template_variables"       jsonb,
  "provider_message_id"      text,
  "status"                   text NOT NULL DEFAULT 'queued',
  "http_status"              integer,
  "error_code"               text,
  "error_message"            text,
  "in_reply_to_provider_id"  text,
  "sent_at"                  timestamp with time zone NOT NULL DEFAULT now(),
  "delivered_at"             timestamp with time zone,
  "read_at"                  timestamp with time zone,
  "raw_payload"              jsonb
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_message_tenant_fk') THEN
    ALTER TABLE "wa_message" ADD CONSTRAINT "wa_message_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_message_conversation_fk') THEN
    ALTER TABLE "wa_message" ADD CONSTRAINT "wa_message_conversation_fk"
      FOREIGN KEY ("conversation_id") REFERENCES "wa_conversation"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_message_sender_user_fk') THEN
    ALTER TABLE "wa_message" ADD CONSTRAINT "wa_message_sender_user_fk"
      FOREIGN KEY ("sender_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_message_direction_check') THEN
    ALTER TABLE "wa_message" ADD CONSTRAINT "wa_message_direction_check"
      CHECK (direction IN ('inbound', 'outbound'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_message_sender_type_check') THEN
    ALTER TABLE "wa_message" ADD CONSTRAINT "wa_message_sender_type_check"
      CHECK (sender_type IN ('customer', 'agent', 'bot', 'system'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_message_content_type_check') THEN
    ALTER TABLE "wa_message" ADD CONSTRAINT "wa_message_content_type_check"
      CHECK (content_type IN ('text', 'image', 'audio', 'video', 'document', 'template', 'interactive', 'reaction', 'location', 'unsupported'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_message_status_check') THEN
    ALTER TABLE "wa_message" ADD CONSTRAINT "wa_message_status_check"
      CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed'));
  END IF;
END $$;

-- Thread view: messages of one conversation, newest last (or first; we do
-- DESC for "page from latest").
CREATE INDEX IF NOT EXISTS "wa_message_conversation_sent_idx"
  ON "wa_message" ("conversation_id", "sent_at" DESC);
-- Webhook lookup: status callbacks reference our outbound by provider_message_id.
CREATE UNIQUE INDEX IF NOT EXISTS "wa_message_provider_msg_id_unique"
  ON "wa_message" ("provider_message_id") WHERE "provider_message_id" IS NOT NULL;
-- Tenant-wide delivery log feed for the admin page.
CREATE INDEX IF NOT EXISTS "wa_message_tenant_sent_idx"
  ON "wa_message" ("tenant_id", "sent_at" DESC);

ALTER TABLE "wa_message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wa_message" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wa_message_tenant_isolation" ON "wa_message";
CREATE POLICY "wa_message_tenant_isolation" ON "wa_message"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "wa_message" TO decrm_app;

-- ─── Permission backfill ──────────────────────────────────────────────────
-- Administrators get all four; advisors / sales advisor get read + send.
-- Broadcast + manage are admin-only because broadcasts can rack up real
-- Meta charges and config changes affect every advisor's sends.

INSERT INTO user_group_permission (group_id, permission)
SELECT g.id, perm
FROM user_group g
CROSS JOIN (VALUES
  ('whatsapp.read'),
  ('whatsapp.send'),
  ('whatsapp.broadcast'),
  ('whatsapp.manage')
) AS p(perm)
WHERE g.is_system = true AND g.name = 'Administrators'
ON CONFLICT DO NOTHING;

INSERT INTO user_group_permission (group_id, permission)
SELECT g.id, perm
FROM user_group g
CROSS JOIN (VALUES
  ('whatsapp.read'),
  ('whatsapp.send')
) AS p(perm)
WHERE g.is_system = true AND g.name IN ('Advisors', 'Sales advisor', 'Support rep')
ON CONFLICT DO NOTHING;
