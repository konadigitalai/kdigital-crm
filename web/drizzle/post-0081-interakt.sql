-- Interakt (WhatsApp) sync — per-tenant Secret Key storage for the
-- "Sync to Interakt" lead action. The api_key is the base64 Secret Key copied
-- from the Interakt dashboard (Settings → Developer Setting → Secret Key); it is
-- used verbatim as the `Authorization: Basic <key>` header. Stored server-side
-- only and never returned to the browser unmasked.
--
-- Also declared in src/db/schema.ts (source of truth). Idempotent.

CREATE TABLE IF NOT EXISTS interakt_account (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  api_key      text,
  enabled      boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS interakt_account_tenant_unique
  ON interakt_account (tenant_id);

-- ─── Grants ──────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON interakt_account TO decrm_app;

-- ─── RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE interakt_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE interakt_account FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS interakt_account_tenant_isolation ON interakt_account;
CREATE POLICY interakt_account_tenant_isolation ON interakt_account
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);
