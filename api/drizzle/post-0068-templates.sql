-- WhatsApp Templates (Twilio Content Builder cache) + tw_message extensions.
--
-- Phase 1 of the WhatsApp Templates + Campaign Engine (see plan file
-- shimmering-singing-cray.md). Additive only — safe to replay, safe to
-- roll back by reverting code (unused columns/tables stay quiet).
--
-- wa_template is a READ-THROUGH cache of Twilio Content Builder templates.
-- We do NOT try to own the source of truth; Twilio does. We snapshot the
-- SID + friendly name + variable list + type block so the FE can render a
-- picker + variable form without an extra hop to Twilio on every keystroke.
--
-- tw_message gains three additive columns:
--   content_sid          — Twilio ContentSid used for this outbound send
--   content_variables    — resolved variables JSON that were sent
--   campaign_id          — nullable now; becomes FK to campaign in phase 2

CREATE TABLE IF NOT EXISTS wa_template (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  content_sid       text NOT NULL,
  friendly_name     text NOT NULL,
  language          text,
  category          text,
  variables         jsonb NOT NULL DEFAULT '{}'::jsonb,
  types             jsonb NOT NULL DEFAULT '{}'::jsonb,
  approval_status   text NOT NULL DEFAULT 'unknown',
  approval_note     text,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wa_template_approval_status_check
    CHECK (approval_status IN ('draft','pending','approved','rejected','unknown','paused'))
);

CREATE UNIQUE INDEX IF NOT EXISTS wa_template_tenant_content_sid_key
  ON wa_template (tenant_id, content_sid);
CREATE INDEX IF NOT EXISTS wa_template_tenant_approval_idx
  ON wa_template (tenant_id, approval_status);

-- ─── tw_message additive columns ──────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tw_message' AND column_name = 'content_sid'
  ) THEN
    ALTER TABLE tw_message ADD COLUMN content_sid text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tw_message' AND column_name = 'content_variables'
  ) THEN
    ALTER TABLE tw_message ADD COLUMN content_variables jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tw_message' AND column_name = 'campaign_id'
  ) THEN
    -- No FK yet — campaign table lands in phase 2 (post-0069). This column
    -- stays nullable + unconstrained for now so template sends outside a
    -- campaign are fine.
    ALTER TABLE tw_message ADD COLUMN campaign_id uuid;
  END IF;
END $$;

-- Handy index for later campaign detail views.
CREATE INDEX IF NOT EXISTS tw_message_campaign_idx
  ON tw_message (campaign_id, sent_at DESC)
  WHERE campaign_id IS NOT NULL;

-- ─── Grants ──────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON wa_template TO decrm_app;

-- ─── RLS ─────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['wa_template'];
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
