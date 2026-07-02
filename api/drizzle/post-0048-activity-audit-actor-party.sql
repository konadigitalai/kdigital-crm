-- Phase 3 of the Party Model migration — actor_party_id on activity + audit_log.
--
-- Purpose: the existing `actor_type` + `actor_id` (text) + `actor_name`
-- (text) triple is decorative — nothing joins on actor_id and nothing
-- writes it. Add a real FK to party so we can:
--   - "show me everything Priya did" (group by actor_party_id → app_user)
--   - "show me all agent-authored activity in the last hour" (WHERE
--     actor_party_id = sentinel)
--   - Set up Phase 4 dedup + analytics.
--
-- Nullable — legacy rows before the migration have no actor_party_id.
-- Old text columns stay for one release as historical redundancy.
--
-- Idempotent.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'activity' AND column_name = 'actor_party_id'
  ) THEN
    ALTER TABLE "activity" ADD COLUMN "actor_party_id" uuid;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_log' AND column_name = 'actor_party_id'
  ) THEN
    ALTER TABLE "audit_log" ADD COLUMN "actor_party_id" uuid;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_actor_party_fk') THEN
    ALTER TABLE "activity" ADD CONSTRAINT "activity_actor_party_fk"
      FOREIGN KEY ("actor_party_id") REFERENCES "party"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_log_actor_party_fk') THEN
    ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_party_fk"
      FOREIGN KEY ("actor_party_id") REFERENCES "party"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Fast "actor timeline" lookups. Partial: only rows with actor_party_id set.
CREATE INDEX IF NOT EXISTS "activity_actor_party_idx"
  ON "activity" ("tenant_id", "actor_party_id", "ts" DESC)
  WHERE "actor_party_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "audit_log_actor_party_idx"
  ON "audit_log" ("tenant_id", "actor_party_id", "ts" DESC)
  WHERE "actor_party_id" IS NOT NULL;
