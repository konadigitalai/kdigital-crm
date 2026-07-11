-- Campaigns: bulk outbound WhatsApp template sends with per-recipient state.
--
-- Phase 2 of the WhatsApp Templates + Campaign Engine (plan file
-- shimmering-singing-cray.md). Additive only.
--
-- Design:
--   - `campaign` — one row per campaign draft/schedule/run.
--       audience is a serialized FE filter tree (see web/src/components/filter).
--       variable_bindings maps each template placeholder to either a
--       literal string OR a field path like "party.name" / "lead.program".
--   - `campaign_recipient` — materialized once when the campaign is scheduled.
--       Unique on (campaign_id, party_id). Status transitions:
--         pending -> sending -> sent -> {delivered|read}   (happy path)
--         pending -> skipped_optout | skipped_no_phone     (pre-send gates)
--         sending -> failed                                (twilio 4xx/5xx or exception)
--   - tw_message.campaign_id gains a FK constraint here.
--   - activity.campaign_id column added — timeline rows can be rolled up
--     into a campaign in the UI.

CREATE TABLE IF NOT EXISTS campaign (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenant(id),
  name                      text NOT NULL,
  created_by                uuid REFERENCES party(id) ON DELETE SET NULL,
  channel                   text NOT NULL DEFAULT 'whatsapp',
  content_sid               text NOT NULL,
  content_variable_bindings jsonb NOT NULL DEFAULT '{}'::jsonb,
  audience                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                    text NOT NULL DEFAULT 'draft',
  scheduled_at              timestamptz,
  send_rate_per_sec         integer NOT NULL DEFAULT 5,
  daily_cap                 integer,
  created_at                timestamptz NOT NULL DEFAULT now(),
  started_at                timestamptz,
  completed_at              timestamptz,
  CONSTRAINT campaign_status_check
    CHECK (status IN ('draft','scheduled','running','paused','completed','cancelled')),
  CONSTRAINT campaign_channel_check
    CHECK (channel IN ('whatsapp','sms')),
  CONSTRAINT campaign_send_rate_check
    CHECK (send_rate_per_sec BETWEEN 1 AND 100)
);

CREATE INDEX IF NOT EXISTS campaign_tenant_status_idx
  ON campaign (tenant_id, status, scheduled_at);

CREATE TABLE IF NOT EXISTS campaign_recipient (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  campaign_id          uuid NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  party_id             uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  work_item_id         uuid REFERENCES work_item(id) ON DELETE SET NULL,
  status               text NOT NULL DEFAULT 'pending',
  error_code           text,
  error_message        text,
  tw_message_id        uuid REFERENCES tw_message(id) ON DELETE SET NULL,
  resolved_variables   jsonb,
  queued_at            timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  delivered_at         timestamptz,
  CONSTRAINT campaign_recipient_status_check
    CHECK (status IN ('pending','sending','sent','delivered','read',
                      'failed','skipped_optout','skipped_no_phone','skipped_dup'))
);

CREATE UNIQUE INDEX IF NOT EXISTS campaign_recipient_campaign_party_key
  ON campaign_recipient (campaign_id, party_id);
CREATE INDEX IF NOT EXISTS campaign_recipient_campaign_status_idx
  ON campaign_recipient (campaign_id, status);
CREATE INDEX IF NOT EXISTS campaign_recipient_tw_message_idx
  ON campaign_recipient (tw_message_id)
  WHERE tw_message_id IS NOT NULL;

-- ─── tw_message.campaign_id → campaign(id) ────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'tw_message_campaign_id_fkey'
      AND table_name      = 'tw_message'
  ) THEN
    ALTER TABLE tw_message
      ADD CONSTRAINT tw_message_campaign_id_fkey
      FOREIGN KEY (campaign_id) REFERENCES campaign(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ─── activity.campaign_id (nullable) — lets the timeline surface a rollup ─
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'activity' AND column_name = 'campaign_id'
  ) THEN
    ALTER TABLE activity ADD COLUMN campaign_id uuid;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'activity_campaign_id_fkey'
      AND table_name = 'activity'
  ) THEN
    ALTER TABLE activity
      ADD CONSTRAINT activity_campaign_id_fkey
      FOREIGN KEY (campaign_id) REFERENCES campaign(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS activity_campaign_idx
  ON activity (campaign_id, ts DESC)
  WHERE campaign_id IS NOT NULL;

-- ─── Grants ──────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON campaign, campaign_recipient TO decrm_app;

-- ─── RLS ─────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['campaign','campaign_recipient'];
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
