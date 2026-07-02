-- Phase 1 of the Party Model migration — person↔org affiliations.
--
-- Purpose: today we can store an organization as a party (kind='org') and
-- a person as a party (kind='person'), but we have no typed way to link
-- them. The generic `relationship` table can encode the edge, but B2B sales
-- workflows need affiliations indexed and queried constantly, so they get
-- their own table (Salesforce's AccountContactRelation pattern).
--
-- Enables:
--   - "Jane works at Acme as decision_maker" (many rows per person, one
--     current + history).
--   - "Show all stakeholders at Acme" (org → people).
--   - "What's Jane's primary employer right now?" (is_primary + valid_to
--     IS NULL).
--
-- Additive only. Not read by any existing route.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS "party_affiliation" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"         uuid NOT NULL,
  "person_party_id"   uuid NOT NULL,
  "org_party_id"      uuid NOT NULL,
  "role_at_org"       text,
  "is_primary"        boolean NOT NULL DEFAULT false,
  "valid_from"        date NOT NULL DEFAULT CURRENT_DATE,
  "valid_to"          date,
  "attributes"        jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_affiliation_tenant_fk') THEN
    ALTER TABLE "party_affiliation" ADD CONSTRAINT "party_affiliation_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_affiliation_person_fk') THEN
    ALTER TABLE "party_affiliation" ADD CONSTRAINT "party_affiliation_person_fk"
      FOREIGN KEY ("person_party_id") REFERENCES "party"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_affiliation_org_fk') THEN
    ALTER TABLE "party_affiliation" ADD CONSTRAINT "party_affiliation_org_fk"
      FOREIGN KEY ("org_party_id") REFERENCES "party"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_affiliation_not_self') THEN
    ALTER TABLE "party_affiliation" ADD CONSTRAINT "party_affiliation_not_self"
      CHECK ("person_party_id" <> "org_party_id");
  END IF;
END $$;

-- One primary org per person at a time (soft: kind check is enforced by
-- the app, since we can't easily reference party.kind in a check here).
CREATE UNIQUE INDEX IF NOT EXISTS "party_affiliation_primary_uniq"
  ON "party_affiliation" ("tenant_id", "person_party_id")
  WHERE "is_primary" = true AND "valid_to" IS NULL;

CREATE INDEX IF NOT EXISTS "party_affiliation_person_idx"
  ON "party_affiliation" ("tenant_id", "person_party_id");
CREATE INDEX IF NOT EXISTS "party_affiliation_org_idx"
  ON "party_affiliation" ("tenant_id", "org_party_id");

DROP TRIGGER IF EXISTS "party_affiliation_updated_at" ON "party_affiliation";
CREATE TRIGGER "party_affiliation_updated_at" BEFORE UPDATE ON "party_affiliation"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE "party_affiliation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "party_affiliation" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "party_affiliation_tenant_isolation" ON "party_affiliation";
CREATE POLICY "party_affiliation_tenant_isolation" ON "party_affiliation"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "party_affiliation" TO decrm_app;
