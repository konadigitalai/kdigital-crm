-- Phase 4 of the Party Model migration — per-channel consent records.
--
-- Purpose: DPDP (India) + GDPR both require per-channel opt-in proof for
-- marketing communications. Today the WhatsApp broadcast recipient path
-- inserts anyone with a phone number — one regulator complaint away.
--
-- One row per (party, channel, valid_from) — end-dated when consent
-- flips. A partial unique index enforces at most one *current* row per
-- (party, channel). Reads use `WHERE valid_to IS NULL`.
--
-- Idempotent. Rollback via `DROP TABLE party_consent CASCADE`.

CREATE TABLE IF NOT EXISTS "party_consent" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"    uuid NOT NULL,
  "party_id"     uuid NOT NULL,
  "channel"      text NOT NULL,
  "opt_in"       boolean NOT NULL,
  "source"       text,                 -- 'signup' | 'unsubscribe' | 'legal_dsr' | …
  "evidence_url" text,                 -- link to the sign-up form / email / DSR request
  "valid_from"   date NOT NULL DEFAULT CURRENT_DATE,
  "valid_to"     date,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_consent_tenant_fk') THEN
    ALTER TABLE "party_consent" ADD CONSTRAINT "party_consent_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_consent_party_fk') THEN
    ALTER TABLE "party_consent" ADD CONSTRAINT "party_consent_party_fk"
      FOREIGN KEY ("party_id") REFERENCES "party"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_consent_channel_check') THEN
    ALTER TABLE "party_consent" ADD CONSTRAINT "party_consent_channel_check"
      CHECK (channel IN ('whatsapp','email','sms','calls'));
  END IF;
END $$;

-- One current row per (party, channel). Historical rows have valid_to IS NOT NULL.
CREATE UNIQUE INDEX IF NOT EXISTS "party_consent_current_uniq"
  ON "party_consent" ("tenant_id", "party_id", "channel")
  WHERE "valid_to" IS NULL;

-- "Who has opt_in for this channel right now?" — used by broadcast recipient add.
CREATE INDEX IF NOT EXISTS "party_consent_channel_optin_idx"
  ON "party_consent" ("tenant_id", "channel", "opt_in")
  WHERE "valid_to" IS NULL;

-- Reverse — full history for a party.
CREATE INDEX IF NOT EXISTS "party_consent_party_idx"
  ON "party_consent" ("tenant_id", "party_id", "channel", "valid_from" DESC);

-- Auto-bump updated_at (function defined in post-0005-updated-at.sql).
DROP TRIGGER IF EXISTS "party_consent_updated_at" ON "party_consent";
CREATE TRIGGER "party_consent_updated_at" BEFORE UPDATE ON "party_consent"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE "party_consent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "party_consent" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "party_consent_tenant_isolation" ON "party_consent";
CREATE POLICY "party_consent_tenant_isolation" ON "party_consent"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "party_consent" TO decrm_app;
