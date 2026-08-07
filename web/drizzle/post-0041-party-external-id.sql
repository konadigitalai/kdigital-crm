-- Phase 1 of the Party Model migration — external system IDs.
--
-- Purpose: `party.identifiers` is a JSONB blob today. We can't uniquely
-- index it per external system (Instagram Lead ID, Razorpay customer ID,
-- Auth0 sub, etc.). `party_external_id` gives each external key its own
-- row with a proper unique index across (tenant, system, external_id).
--
-- Additive only. `party.identifiers` remains and is still written for
-- back-compat; new external IDs go in this table.
--
-- Append-only by design — no updated_at, no update trigger. If an
-- external ID changes, insert a new row and let the old one age out.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS "party_external_id" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"    uuid NOT NULL,
  "party_id"     uuid NOT NULL,
  "system"       text NOT NULL,
  "external_id"  text NOT NULL,
  "metadata"     jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_external_id_tenant_fk') THEN
    ALTER TABLE "party_external_id" ADD CONSTRAINT "party_external_id_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_external_id_party_fk') THEN
    ALTER TABLE "party_external_id" ADD CONSTRAINT "party_external_id_party_fk"
      FOREIGN KEY ("party_id") REFERENCES "party"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- One (system, external_id) maps to one party per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "party_external_id_system_key"
  ON "party_external_id" ("tenant_id", "system", "external_id");

-- Reverse lookup: "all external IDs for this party".
CREATE INDEX IF NOT EXISTS "party_external_id_party_idx"
  ON "party_external_id" ("tenant_id", "party_id");

ALTER TABLE "party_external_id" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "party_external_id" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "party_external_id_tenant_isolation" ON "party_external_id";
CREATE POLICY "party_external_id_tenant_isolation" ON "party_external_id"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "party_external_id" TO decrm_app;
