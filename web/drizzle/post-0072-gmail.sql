-- Gmail two-way email channel.
--
-- Adds `email` as a fourth channel on the existing tw_conversation +
-- tw_message tables, the same way post-0071 added `voice` for Exotel. Email
-- threads therefore land in the same inbox the FE already renders, get the
-- same unread counts, the same promote-to-lead flow, and the same activity
-- mirror onto the lead timeline. No parallel thread/message tables.
--
-- Shape notes:
--   - One tw_conversation per (tenant, party, 'email') — the existing unique
--     index. ALL mail with that person lives in that one conversation; the
--     individual Gmail threads are distinguished by tw_message.provider_thread_id.
--     This is what makes "everything for this lead in one place" fall out.
--   - tw_message.from_number / to_number hold EMAIL ADDRESSES when
--     channel='email'. The column names are a Twilio-era misnomer (the whole
--     tw_ prefix already is, since Exotel voice reuses these tables); we keep
--     them rather than adding parallel from_addr/to_addr columns that would
--     be NULL for every other channel.
--   - provider_message_id = Gmail's message id. It is already UNIQUE, which
--     is what makes the sync idempotent AND dedupes our own outbound sends
--     when they come back around through the SENT-folder sync.
--
-- Additive only; safe to replay.

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
    CHECK (channel IN ('sms','whatsapp','voice','email'));
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
    CHECK (channel IN ('sms','whatsapp','voice','email'));
END $$;

-- ─── Widen media_asset.source for Gmail attachments ───────────────────────
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
    CHECK (source IN ('user_upload','twilio_inbound','exotel_recording','gmail_attachment'));
END $$;

-- ─── Email-specific columns on tw_message ─────────────────────────────────
-- All nullable — every one of these is NULL for sms/whatsapp/voice rows.
ALTER TABLE tw_message ADD COLUMN IF NOT EXISTS subject             text;
ALTER TABLE tw_message ADD COLUMN IF NOT EXISTS body_html           text;
ALTER TABLE tw_message ADD COLUMN IF NOT EXISTS to_addrs            text[];
ALTER TABLE tw_message ADD COLUMN IF NOT EXISTS cc_addrs            text[];
ALTER TABLE tw_message ADD COLUMN IF NOT EXISTS provider_thread_id  text;
-- The RFC 5322 Message-ID header. Distinct from provider_message_id (Gmail's
-- own opaque id): this is the value other mail servers quote back at us in
-- In-Reply-To/References, so it's what stitches a reply to its parent.
ALTER TABLE tw_message ADD COLUMN IF NOT EXISTS rfc822_message_id   text;
ALTER TABLE tw_message ADD COLUMN IF NOT EXISTS in_reply_to         text;
-- Which connected mailbox this message flowed through. Needed to know which
-- OAuth token can fetch its attachments, and which account to reply from.
ALTER TABLE tw_message ADD COLUMN IF NOT EXISTS gmail_account_id    uuid;

CREATE INDEX IF NOT EXISTS tw_message_provider_thread_idx
  ON tw_message (provider_thread_id)
  WHERE provider_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tw_message_rfc822_idx
  ON tw_message (rfc822_message_id)
  WHERE rfc822_message_id IS NOT NULL;

-- ─── gmail_account — one row per connected mailbox ────────────────────────
-- Mirrors slack_user_link: per-CRM-user OAuth link, token stored server-side,
-- reconnecting overwrites. The shared fallback mailbox (support@…) is just a
-- row with is_shared = true, connected once by an admin; app_user_id is NULL
-- for it since it belongs to nobody in particular.
CREATE TABLE IF NOT EXISTS gmail_account (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  app_user_id       uuid REFERENCES app_user(id) ON DELETE CASCADE,
  email             text NOT NULL,
  refresh_token     text NOT NULL,
  access_token      text,
  -- When access_token expires. The client refreshes ~60s ahead of this.
  expires_at        timestamptz,
  scopes            text,
  is_shared         boolean NOT NULL DEFAULT false,
  -- Gmail history cursor. The sync worker asks for everything after this.
  -- NULL = never synced; the first sync seeds it without backfilling.
  history_id        text,
  last_synced_at    timestamptz,
  -- Consecutive sync failures. Trips to revoked_at after repeated auth
  -- failures so a dead token stops being polled every 60s forever.
  sync_error_count  integer NOT NULL DEFAULT 0,
  sync_error        text,
  connected_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One live account per CRM user, and one per email address per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS gmail_account_app_user_key
  ON gmail_account (app_user_id)
  WHERE app_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS gmail_account_tenant_email_key
  ON gmail_account (tenant_id, lower(email));
CREATE INDEX IF NOT EXISTS gmail_account_tenant_idx
  ON gmail_account (tenant_id) WHERE revoked_at IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tw_message_gmail_account_fk') THEN
    ALTER TABLE tw_message ADD CONSTRAINT tw_message_gmail_account_fk
      FOREIGN KEY (gmail_account_id) REFERENCES gmail_account(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ─── Grants ──────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON gmail_account TO decrm_app;

-- ─── RLS ─────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['gmail_account'];
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

DROP TRIGGER IF EXISTS gmail_account_updated_at ON gmail_account;
CREATE TRIGGER gmail_account_updated_at BEFORE UPDATE ON gmail_account
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
