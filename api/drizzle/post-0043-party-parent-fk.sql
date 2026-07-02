-- Phase 1 of the Party Model migration — org hierarchy self-FK.
--
-- Purpose: an org party can be a subsidiary of another org party
-- ("Beta is owned by Acme"). Salesforce spells this Account.ParentId;
-- ServiceNow spells it core_company.parent. Self-referencing FK.
--
-- Additive: nullable column, no data change, no route change.
--
-- Idempotent.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'party' AND column_name = 'parent_party_id'
  ) THEN
    ALTER TABLE "party" ADD COLUMN "parent_party_id" uuid;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_parent_fk') THEN
    ALTER TABLE "party" ADD CONSTRAINT "party_parent_fk"
      FOREIGN KEY ("parent_party_id") REFERENCES "party"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_parent_not_self') THEN
    ALTER TABLE "party" ADD CONSTRAINT "party_parent_not_self"
      CHECK ("parent_party_id" IS NULL OR "parent_party_id" <> "id");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "party_parent_idx"
  ON "party" ("tenant_id", "parent_party_id")
  WHERE "parent_party_id" IS NOT NULL;
