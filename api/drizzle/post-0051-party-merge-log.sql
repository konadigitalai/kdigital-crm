-- Phase 4 of the Party Model migration — merge audit trail + soft-delete flags.
--
-- Purpose: when two party rows are recognised as the same real-world person,
-- we merge them: the winner keeps the id, everything the loser referenced
-- reparents to the winner, and the loser is soft-deleted (kept for audit).
--
-- Adds:
--   party.is_merged           — filter merged rows out of every list.
--   party.merged_into_party_id — pointer to the winner for a UI redirect.
--   party.merged_at           — when the merge happened.
--   party_merge_log           — full audit row with snapshot for surgery-in-anger.
--
-- Idempotent. Rollback:
--   DROP TABLE party_merge_log CASCADE;
--   ALTER TABLE party DROP COLUMN is_merged, DROP COLUMN merged_into_party_id, DROP COLUMN merged_at;

-- ─── party soft-delete flags ─────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'party' AND column_name = 'is_merged'
  ) THEN
    ALTER TABLE "party" ADD COLUMN "is_merged" boolean NOT NULL DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'party' AND column_name = 'merged_into_party_id'
  ) THEN
    ALTER TABLE "party" ADD COLUMN "merged_into_party_id" uuid;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'party' AND column_name = 'merged_at'
  ) THEN
    ALTER TABLE "party" ADD COLUMN "merged_at" timestamp with time zone;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_merged_into_fk') THEN
    ALTER TABLE "party" ADD CONSTRAINT "party_merged_into_fk"
      FOREIGN KEY ("merged_into_party_id") REFERENCES "party"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_merged_not_self') THEN
    ALTER TABLE "party" ADD CONSTRAINT "party_merged_not_self"
      CHECK ("merged_into_party_id" IS NULL OR "merged_into_party_id" <> "id");
  END IF;
END $$;

-- Recent-merges report + "list only live parties" queries.
CREATE INDEX IF NOT EXISTS "party_merged_idx"
  ON "party" ("tenant_id", "is_merged", "merged_at" DESC);

-- ─── party_merge_log ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "party_merge_log" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"             uuid NOT NULL,
  "winner_party_id"       uuid NOT NULL,
  "loser_party_id"        uuid NOT NULL,
  "merged_by_party_id"    uuid,               -- app_user's party.id (Phase 2 unified)
  "merged_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "snapshot"              jsonb NOT NULL,     -- loser row + reparent counts
  "note"                  text
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_merge_log_tenant_fk') THEN
    ALTER TABLE "party_merge_log" ADD CONSTRAINT "party_merge_log_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_merge_log_winner_fk') THEN
    ALTER TABLE "party_merge_log" ADD CONSTRAINT "party_merge_log_winner_fk"
      FOREIGN KEY ("winner_party_id") REFERENCES "party"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_merge_log_loser_fk') THEN
    ALTER TABLE "party_merge_log" ADD CONSTRAINT "party_merge_log_loser_fk"
      FOREIGN KEY ("loser_party_id") REFERENCES "party"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_merge_log_merged_by_fk') THEN
    ALTER TABLE "party_merge_log" ADD CONSTRAINT "party_merge_log_merged_by_fk"
      FOREIGN KEY ("merged_by_party_id") REFERENCES "party"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "party_merge_log_tenant_idx"
  ON "party_merge_log" ("tenant_id", "merged_at" DESC);
CREATE INDEX IF NOT EXISTS "party_merge_log_winner_idx"
  ON "party_merge_log" ("tenant_id", "winner_party_id");
CREATE INDEX IF NOT EXISTS "party_merge_log_loser_idx"
  ON "party_merge_log" ("tenant_id", "loser_party_id");

ALTER TABLE "party_merge_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "party_merge_log" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "party_merge_log_tenant_isolation" ON "party_merge_log";
CREATE POLICY "party_merge_log_tenant_isolation" ON "party_merge_log"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "party_merge_log" TO decrm_app;
