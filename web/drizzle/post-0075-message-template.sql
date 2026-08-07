-- Saved messages (canned responses) for the inbox composer.
--
-- The document library keeps FILES in Vercel Blob because they're binary; a
-- saved message is just a title + a short body, so it lives in Postgres. That
-- keeps the composer's picker instant and lets it search by title without a
-- per-message blob fetch.
--
-- title  — the label shown in the picker ("Fee structure", "Demo follow-up").
-- body   — the text inserted into the composer when picked.
--
-- Tenant-scoped and shared across the tenant's agents (no per-user ownership
-- gate on reads); created_by is kept for attribution only.
--
-- Idempotent — safe to replay.

CREATE TABLE IF NOT EXISTS message_template (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  title               text NOT NULL,
  body                text NOT NULL,
  created_by_party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT message_template_title_len CHECK (char_length(title) BETWEEN 1 AND 120),
  CONSTRAINT message_template_body_len  CHECK (char_length(body)  BETWEEN 1 AND 4000)
);

-- The picker lists a tenant's templates alphabetically by title.
CREATE INDEX IF NOT EXISTS message_template_tenant_title_idx
  ON message_template (tenant_id, lower(title));

-- ─── Grants ──────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON message_template TO decrm_app;

-- ─── RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE message_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_template FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_template_tenant_isolation ON message_template;
CREATE POLICY message_template_tenant_isolation ON message_template
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);
