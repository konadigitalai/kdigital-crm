-- Voice channel support (Exotel integration).
--
-- Extends the existing tw_conversation + tw_message tables with a `voice`
-- channel so click-to-call and missed-call events land in the same inbox
-- the FE already renders for SMS + WhatsApp. Also widens media_asset.source
-- to accept Exotel-hosted recording URLs (proxied on playback), and adds a
-- tw_call_event table for the per-callback lifecycle (in-progress →
-- answered → terminal). Additive only; safe to replay.

-- ─── Widen tw_conversation.channel ────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tw_conversation_channel_check'
      AND conrelid = 'tw_conversation'::regclass
  ) THEN
    ALTER TABLE tw_conversation DROP CONSTRAINT tw_conversation_channel_check;
  END IF;
  ALTER TABLE tw_conversation ADD CONSTRAINT tw_conversation_channel_check
    CHECK (channel IN ('sms','whatsapp','voice'));
END $$;

-- ─── Widen tw_message.channel ─────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tw_message_channel_check'
      AND conrelid = 'tw_message'::regclass
  ) THEN
    ALTER TABLE tw_message DROP CONSTRAINT tw_message_channel_check;
  END IF;
  ALTER TABLE tw_message ADD CONSTRAINT tw_message_channel_check
    CHECK (channel IN ('sms','whatsapp','voice'));
END $$;

-- ─── Widen media_asset.source to accept Exotel recordings ─────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'media_asset_source_check'
      AND conrelid = 'media_asset'::regclass
  ) THEN
    ALTER TABLE media_asset DROP CONSTRAINT media_asset_source_check;
  END IF;
  ALTER TABLE media_asset ADD CONSTRAINT media_asset_source_check
    CHECK (source IN ('user_upload','twilio_inbound','exotel_recording'));
END $$;

-- ─── tw_call_event — per-callback lifecycle from Exotel StatusCallback ────
-- Exotel POSTs one or more callbacks per call (subscribed via
-- `StatusCallbackEvents=terminal,answered`). We persist each so the
-- timeline can show "started → answered → completed" and so retries are
-- idempotent via UNIQUE (tw_message_id, event_type).
CREATE TABLE IF NOT EXISTS tw_call_event (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  tw_message_id      uuid NOT NULL REFERENCES tw_message(id) ON DELETE CASCADE,
  call_sid           text NOT NULL,
  event_type         text NOT NULL,            -- 'answered' | 'terminal' | 'inbound_missed' | 'in-progress' | …
  status             text,                     -- 'completed' | 'no-answer' | 'busy' | 'failed' | …
  duration_seconds   integer,
  recording_url      text,
  legs               jsonb,                    -- Exotel Legs[] verbatim
  raw                jsonb NOT NULL,           -- full webhook body, first 8 KB
  received_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tw_call_event_msg_evt_key
  ON tw_call_event (tw_message_id, event_type);
CREATE INDEX IF NOT EXISTS tw_call_event_call_sid_idx
  ON tw_call_event (call_sid, received_at);

-- ─── Grants ──────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON tw_call_event TO decrm_app;

-- ─── RLS ─────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['tw_call_event'];
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
