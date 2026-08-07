-- Phase 4 of the Party Model migration — dedup engine tables.
--
--   party_match_rule            configurable per-tenant matching rules
--   party_duplicate_candidate   scanner output queue
--
-- The scanner (api/src/lib/party/dedup.ts) reads enabled rules and inserts
-- candidate pairs. Ops team reviews the queue via GET /parties/duplicates,
-- then either dismisses or merges via POST /parties/merge (which writes to
-- party_merge_log from post-0051 and reparents FKs via the helper).
--
-- Idempotent. Rollback: DROP TABLE party_duplicate_candidate, party_match_rule CASCADE.

-- ─── party_match_rule ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "party_match_rule" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   uuid NOT NULL,
  "name"        text NOT NULL,
  "kind"        text NOT NULL,      -- exact_external_id | exact_email | e164_phone | fuzzy_name_city
  "config"      jsonb NOT NULL DEFAULT '{}'::jsonb,
  "enabled"     boolean NOT NULL DEFAULT true,
  "weight"      integer NOT NULL DEFAULT 100,   -- higher = more confident match
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_match_rule_tenant_fk') THEN
    ALTER TABLE "party_match_rule" ADD CONSTRAINT "party_match_rule_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_match_rule_kind_check') THEN
    ALTER TABLE "party_match_rule" ADD CONSTRAINT "party_match_rule_kind_check"
      CHECK (kind IN ('exact_external_id','exact_email','e164_phone','fuzzy_name_city'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "party_match_rule_tenant_enabled_idx"
  ON "party_match_rule" ("tenant_id", "enabled");

DROP TRIGGER IF EXISTS "party_match_rule_updated_at" ON "party_match_rule";
CREATE TRIGGER "party_match_rule_updated_at" BEFORE UPDATE ON "party_match_rule"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE "party_match_rule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "party_match_rule" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "party_match_rule_tenant_isolation" ON "party_match_rule";
CREATE POLICY "party_match_rule_tenant_isolation" ON "party_match_rule"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "party_match_rule" TO decrm_app;

-- Seed default rules for every tenant that doesn't already have any.
INSERT INTO "party_match_rule" (tenant_id, name, kind, config, weight)
SELECT t.id, kind_name, kind, cfg::jsonb, w
FROM "tenant" t
CROSS JOIN (VALUES
  ('Exact external system ID', 'exact_external_id', '{}',                              100),
  ('Exact primary email',      'exact_email',       '{}',                              90),
  ('E.164 phone match',        'e164_phone',        '{}',                              85),
  ('Fuzzy name + same city',   'fuzzy_name_city',   '{"pg_trgm_threshold":0.7}',       50)
) AS r(kind_name, kind, cfg, w)
WHERE NOT EXISTS (
  SELECT 1 FROM "party_match_rule" mr
  WHERE mr.tenant_id = t.id AND mr.kind = r.kind
);

-- ─── party_duplicate_candidate ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "party_duplicate_candidate" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"             uuid NOT NULL,
  "party_a_id"            uuid NOT NULL,
  "party_b_id"            uuid NOT NULL,
  "matched_by_rule_id"    uuid,
  "score"                 numeric(5, 2),          -- 0.00..100.00
  "evidence"              jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status"                text NOT NULL DEFAULT 'pending',
  "detected_at"           timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at"           timestamp with time zone,
  "resolved_by_party_id"  uuid
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_dup_tenant_fk') THEN
    ALTER TABLE "party_duplicate_candidate" ADD CONSTRAINT "party_dup_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_dup_a_fk') THEN
    ALTER TABLE "party_duplicate_candidate" ADD CONSTRAINT "party_dup_a_fk"
      FOREIGN KEY ("party_a_id") REFERENCES "party"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_dup_b_fk') THEN
    ALTER TABLE "party_duplicate_candidate" ADD CONSTRAINT "party_dup_b_fk"
      FOREIGN KEY ("party_b_id") REFERENCES "party"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_dup_rule_fk') THEN
    ALTER TABLE "party_duplicate_candidate" ADD CONSTRAINT "party_dup_rule_fk"
      FOREIGN KEY ("matched_by_rule_id") REFERENCES "party_match_rule"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_dup_resolver_fk') THEN
    ALTER TABLE "party_duplicate_candidate" ADD CONSTRAINT "party_dup_resolver_fk"
      FOREIGN KEY ("resolved_by_party_id") REFERENCES "party"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_dup_status_check') THEN
    ALTER TABLE "party_duplicate_candidate" ADD CONSTRAINT "party_dup_status_check"
      CHECK (status IN ('pending','confirmed','dismissed','merged'));
  END IF;
  -- Canonical ordering: party_a_id < party_b_id so re-scans don't insert (a,b) AND (b,a).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_dup_ab_order') THEN
    ALTER TABLE "party_duplicate_candidate" ADD CONSTRAINT "party_dup_ab_order"
      CHECK ("party_a_id" < "party_b_id");
  END IF;
END $$;

-- Only one *pending* candidate per (a, b). Once resolved (dismissed/merged),
-- a future scan can re-open it — but the reparented winner→loser edge means
-- exact-match rules won't fire again anyway.
CREATE UNIQUE INDEX IF NOT EXISTS "party_dup_pending_uniq"
  ON "party_duplicate_candidate" ("tenant_id", "party_a_id", "party_b_id")
  WHERE "status" = 'pending';

CREATE INDEX IF NOT EXISTS "party_dup_status_idx"
  ON "party_duplicate_candidate" ("tenant_id", "status", "detected_at" DESC);

ALTER TABLE "party_duplicate_candidate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "party_duplicate_candidate" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "party_dup_tenant_isolation" ON "party_duplicate_candidate";
CREATE POLICY "party_dup_tenant_isolation" ON "party_duplicate_candidate"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "party_duplicate_candidate" TO decrm_app;
