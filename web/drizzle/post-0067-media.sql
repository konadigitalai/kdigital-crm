-- Media library + Twilio-message attachments.
--
-- Companion to `feat(media): file attachments for Twilio messages`.
--
-- Design:
--   - `media_folder` — admin-managed categories (fixed folders, not tags).
--   - `media_asset`  — one row per uploaded file. Can be library-scoped
--     (is_library=true, shows in the library UI) or ad-hoc (is_library=false,
--     attached to one send only). `source='twilio_inbound'` marks assets
--     captured from inbound webhooks; they carry Twilio's private URL and
--     need Basic-auth proxying to render.
--   - `tw_message_media` — join between tw_message and media_asset,
--     preserves 0..9 ordinal so Twilio's MediaUrl order is deterministic.
--
-- The existing `attachment` table stays as-is (referenced by seed +
-- cleanup + party-dedup scripts). New feature ships alongside.
--
-- Idempotent — safe to replay.

CREATE TABLE IF NOT EXISTS media_folder (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  name        text NOT NULL,
  created_by  uuid REFERENCES party(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS media_folder_tenant_name_key
  ON media_folder (tenant_id, lower(name));

CREATE TABLE IF NOT EXISTS media_asset (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  folder_id         uuid REFERENCES media_folder(id) ON DELETE SET NULL,
  uploaded_by       uuid REFERENCES party(id) ON DELETE SET NULL,
  filename          text NOT NULL,
  content_type      text NOT NULL,
  size_bytes        bigint NOT NULL,
  sha256            text,
  blob_url          text NOT NULL,
  blob_pathname     text,
  is_library        boolean NOT NULL DEFAULT false,
  source            text NOT NULL DEFAULT 'user_upload',
  provider_hosted   boolean NOT NULL DEFAULT false,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_asset_source_check
    CHECK (source IN ('user_upload','twilio_inbound'))
);

CREATE INDEX IF NOT EXISTS media_asset_tenant_folder_idx
  ON media_asset (tenant_id, folder_id, created_at DESC);
CREATE INDEX IF NOT EXISTS media_asset_tenant_uploader_idx
  ON media_asset (tenant_id, uploaded_by, created_at DESC);
CREATE INDEX IF NOT EXISTS media_asset_tenant_library_idx
  ON media_asset (tenant_id, is_library, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS tw_message_media (
  message_id  uuid NOT NULL REFERENCES tw_message(id)  ON DELETE CASCADE,
  asset_id    uuid NOT NULL REFERENCES media_asset(id) ON DELETE RESTRICT,
  ordinal     smallint NOT NULL,
  PRIMARY KEY (message_id, ordinal)
);

CREATE INDEX IF NOT EXISTS tw_message_media_asset_idx
  ON tw_message_media (asset_id);

-- ─── Grants ──────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE
  ON media_folder, media_asset, tw_message_media
  TO decrm_app;

-- ─── RLS ─────────────────────────────────────────────────────────────────
-- Mirror the pattern in post-0066-twilio.sql. Idempotent.
-- tw_message_media has no tenant_id column; isolation is enforced by joining
-- through media_asset/tw_message, so we don't enable RLS on the join.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['media_folder','media_asset'];
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
