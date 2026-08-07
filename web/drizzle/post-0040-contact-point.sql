-- Phase 1 of the Party Model migration — contact points.
--
-- Purpose: each party currently has exactly one email/phone/city inline.
-- Real people have work + personal email, WhatsApp + landline, billing +
-- shipping address. `contact_point` lets one party have many, each with
-- its own kind, label, verification state, consent record, and validity
-- window.
--
-- Additive only. `party.email` / `party.phone` remain the canonical primary
-- for now — writers dual-write into contact_point in the same transaction
-- (see api/src/routes/leads.ts, api/src/lib/whatsapp/inbox.ts, api/src/db/seed.ts).
-- Read migration is deferred to Phase 3.
--
-- Idempotent. Mirrors the RLS + GRANTs + updated_at trigger pattern from
-- post-0034-whatsapp.sql.

CREATE TABLE IF NOT EXISTS "contact_point" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   uuid NOT NULL,
  "party_id"    uuid NOT NULL,
  "kind"        text NOT NULL,
  "value"       text NOT NULL,
  "label"       text,
  "is_primary"  boolean NOT NULL DEFAULT false,
  "verified_at" timestamp with time zone,
  "consent"     jsonb NOT NULL DEFAULT '{}'::jsonb,
  "valid_from"  date NOT NULL DEFAULT CURRENT_DATE,
  "valid_to"    date,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_point_tenant_fk') THEN
    ALTER TABLE "contact_point" ADD CONSTRAINT "contact_point_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_point_party_fk') THEN
    ALTER TABLE "contact_point" ADD CONSTRAINT "contact_point_party_fk"
      FOREIGN KEY ("party_id") REFERENCES "party"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_point_kind_check') THEN
    ALTER TABLE "contact_point" ADD CONSTRAINT "contact_point_kind_check"
      CHECK (kind IN ('email','phone','whatsapp','address','social'));
  END IF;
END $$;

-- Fast lookup: "all contact points for this party by kind" (record page).
CREATE INDEX IF NOT EXISTS "contact_point_party_kind_idx"
  ON "contact_point" ("tenant_id", "party_id", "kind");

-- Fast lookup: "who has this email/phone value?" (dedup, inbound matching).
-- Partial: only currently-valid rows.
CREATE INDEX IF NOT EXISTS "contact_point_value_idx"
  ON "contact_point" ("tenant_id", "kind", "value")
  WHERE "valid_to" IS NULL;

-- At most one primary per (party, kind). Partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS "contact_point_primary_uniq"
  ON "contact_point" ("tenant_id", "party_id", "kind")
  WHERE "is_primary" = true;

-- Auto-bump updated_at (function defined in post-0005-updated-at.sql).
DROP TRIGGER IF EXISTS "contact_point_updated_at" ON "contact_point";
CREATE TRIGGER "contact_point_updated_at" BEFORE UPDATE ON "contact_point"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE "contact_point" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_point" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "contact_point_tenant_isolation" ON "contact_point";
CREATE POLICY "contact_point_tenant_isolation" ON "contact_point"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "contact_point" TO decrm_app;
