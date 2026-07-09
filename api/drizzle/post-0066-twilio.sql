-- Twilio SMS + WhatsApp messaging tables.
--
-- Companion to `feat(messaging): Twilio SMS + WhatsApp inbox`. Replaces the
-- Meta-era wa_* tables dropped in post-0065.
--
-- Design decisions (see plan file for full context):
--   - `tw_conversation` is one row per (tenant, party, channel). SMS and
--     WhatsApp threads with the same person are separate conversations.
--   - `tw_message.provider_message_id` is UNIQUE (nullable) — Twilio's
--     MessageSid. Inbound insert uses ON CONFLICT DO NOTHING for idempotency
--     because Twilio retries webhooks on any non-2xx.
--   - `is_unlinked=true` on a conversation means the party was auto-created
--     for an inbound from an unknown phone. The inbox UI surfaces a
--     "Promote to lead" action.
--
-- Idempotent — safe to replay.

CREATE TABLE IF NOT EXISTS tw_conversation (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  party_id            uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  channel             text NOT NULL,
  status              text NOT NULL DEFAULT 'open',
  assigned_user_id    uuid REFERENCES party(id) ON DELETE SET NULL,
  last_message_text   text,
  last_message_at     timestamptz,
  last_inbound_at     timestamptz,
  unread_count        integer NOT NULL DEFAULT 0,
  is_unlinked         boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tw_conversation_channel_check CHECK (channel IN ('sms','whatsapp')),
  CONSTRAINT tw_conversation_status_check  CHECK (status  IN ('open','closed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS tw_conversation_tenant_party_channel_key
  ON tw_conversation (tenant_id, party_id, channel);
CREATE INDEX IF NOT EXISTS tw_conversation_tenant_status_idx
  ON tw_conversation (tenant_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS tw_conversation_tenant_channel_idx
  ON tw_conversation (tenant_id, channel, last_message_at DESC);

CREATE TABLE IF NOT EXISTS tw_message (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  conversation_id       uuid NOT NULL REFERENCES tw_conversation(id) ON DELETE CASCADE,
  direction             text NOT NULL,
  channel               text NOT NULL,
  from_number           text NOT NULL,
  to_number             text NOT NULL,
  body                  text,
  provider_message_id   text,
  status                text NOT NULL DEFAULT 'queued',
  error_code            text,
  error_message         text,
  sender_user_id        uuid REFERENCES party(id) ON DELETE SET NULL,
  sent_at               timestamptz NOT NULL DEFAULT now(),
  delivered_at          timestamptz,
  raw_payload           jsonb,
  CONSTRAINT tw_message_direction_check CHECK (direction IN ('inbound','outbound')),
  CONSTRAINT tw_message_channel_check   CHECK (channel   IN ('sms','whatsapp')),
  CONSTRAINT tw_message_status_check    CHECK (status    IN ('queued','sent','delivered','read','failed','received'))
);

CREATE INDEX IF NOT EXISTS tw_message_conversation_sent_idx
  ON tw_message (conversation_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS tw_message_tenant_sent_idx
  ON tw_message (tenant_id, sent_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS tw_message_provider_message_id_key
  ON tw_message (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- ─── Grants ──────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON tw_conversation, tw_message TO decrm_app;

-- ─── RLS ─────────────────────────────────────────────────────────────────
-- Mirror the pattern in post-0046-rls-refresh.sql. Idempotent.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['tw_conversation','tw_message'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = current_tenant() OR current_tenant() IS NULL) WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL)',
      t, t
    );
  END LOOP;
END $$;
