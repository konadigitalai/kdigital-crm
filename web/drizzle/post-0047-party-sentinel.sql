-- Phase 3 of the Party Model migration — tenant-level "System" sentinel party.
--
-- Purpose: activity + audit_log writes that come from agents / system code
-- need an actor. Before Phase 3 the `actor_type` + `actor_name` text pair
-- was the only signal; nothing could `JOIN party ON party.id = actor_party_id`.
-- We solve that by (a) making a sentinel party per tenant with a marker
-- flag, and (b) pointing every non-user actor row at that sentinel via
-- `activity.actor_party_id` / `audit_log.actor_party_id` (added in post-0048).
--
-- The sentinel is a special party: is_system=true, kind='org', is_internal=true,
-- name='System'. It has no email or contact points — it's an actor stub.
--
-- Idempotent. Reversible via
--   DELETE FROM party WHERE is_system = true; ALTER TABLE party DROP COLUMN is_system;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'party' AND column_name = 'is_system'
  ) THEN
    ALTER TABLE "party" ADD COLUMN "is_system" boolean NOT NULL DEFAULT false;
  END IF;
END $$;

-- Exactly one sentinel per tenant. Partial unique so non-sentinel rows
-- don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS "party_system_unique"
  ON "party" ("tenant_id")
  WHERE "is_system" = true;

-- Insert one sentinel per tenant that doesn't already have one.
INSERT INTO "party" (tenant_id, kind, name, is_internal, is_system, identifiers, attributes)
SELECT t.id, 'org', 'System', true, true, '{}'::jsonb, '{}'::jsonb
FROM "tenant" t
WHERE NOT EXISTS (
  SELECT 1 FROM "party" p WHERE p.tenant_id = t.id AND p.is_system = true
);
