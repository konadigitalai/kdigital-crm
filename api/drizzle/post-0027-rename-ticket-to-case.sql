-- Rename "ticket" → "support_case" (we use "support_case" because plain
-- "case" is a reserved SQL keyword in PostgreSQL).
--
-- This rename touches:
--   - work_item.type CHECK constraint (drops the 'ticket' value, adds 'support_case')
--   - work_item rows whose type was 'ticket' (now 'support_case')
--   - work_item.number values starting with TKT-* (now CSE-*)
--   - the table name + every named constraint and index
--   - the sequence name
--   - the RLS policy name + the GRANT
--   - permission strings stored in user_group_permission
--   - audit_log rows that reference target_type='ticket'
--
-- Idempotent: every step guards against having already run. Safe to re-apply.

-- ─── 1. Rename the table (and update its named constraints/indexes) ──────

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ticket' AND relkind = 'r')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'support_case' AND relkind = 'r') THEN
    ALTER TABLE "ticket" RENAME TO "support_case";
  END IF;
END $$;

-- Rename indexes that were named ticket_*
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND indexname LIKE 'ticket_%'
  LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.indexname,
                   replace(r.indexname, 'ticket_', 'support_case_'));
  END LOOP;
END $$;

-- Rename CHECK / FK / unique constraints that were named ticket_*
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.support_case'::regclass
      AND conname LIKE 'ticket_%'
  LOOP
    EXECUTE format('ALTER TABLE "support_case" RENAME CONSTRAINT %I TO %I',
                   r.conname,
                   replace(r.conname, 'ticket_', 'support_case_'));
  END LOOP;
END $$;

-- Rename the trigger if it still has the old name
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'ticket_updated_at'
      AND tgrelid = 'public.support_case'::regclass
  ) THEN
    ALTER TRIGGER "ticket_updated_at" ON "support_case" RENAME TO "support_case_updated_at";
  END IF;
END $$;

-- ─── 2. Sequence rename ─────────────────────────────────────────────────
-- post-0013 may have created a fresh empty seq_support_case before this
-- migration runs. If so, copy the value forward from seq_ticket and drop
-- the old one. This keeps numbering monotonic so a freshly-created case
-- doesn't get a number that collides with a renamed historical CSE-N.
DO $$
DECLARE
  has_old boolean;
  has_new boolean;
  old_val bigint;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'seq_ticket'       AND relkind = 'S') INTO has_old;
  SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'seq_support_case' AND relkind = 'S') INTO has_new;

  IF has_old AND NOT has_new THEN
    EXECUTE 'ALTER SEQUENCE "seq_ticket" RENAME TO "seq_support_case"';
  ELSIF has_old AND has_new THEN
    -- Both exist. Take the max of (new, old) and drop the old one.
    EXECUTE 'SELECT last_value FROM "seq_ticket"' INTO old_val;
    PERFORM setval('seq_support_case',
      GREATEST(old_val, (SELECT last_value FROM "seq_support_case")));
    EXECUTE 'DROP SEQUENCE "seq_ticket"';
  END IF;
END $$;

-- ─── 3. Migrate any work_item rows still tagged 'ticket' → 'support_case'.
-- (post-0013's CHECK is the lenient one that allows both during transition.)
UPDATE "work_item" SET "type" = 'support_case' WHERE "type" = 'ticket';

-- Tighten the work_item.type CHECK to drop 'ticket' from the allowed list.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_item_type_check') THEN
    ALTER TABLE "work_item" DROP CONSTRAINT "work_item_type_check";
  END IF;
END $$;

ALTER TABLE "work_item"
  ADD CONSTRAINT "work_item_type_check"
  CHECK (type IN ('lead','deal','service_case','onboarding_task','agent_run','support_case'));

-- ─── 4. Rename work_item.number from TKT-* → CSE-* ──────────────────────

UPDATE "work_item"
SET    "number" = 'CSE-' || substr("number", 5)
WHERE  "type" = 'support_case' AND "number" LIKE 'TKT-%';

-- ─── 5. RLS policy + GRANTs ─────────────────────────────────────────────

ALTER TABLE "support_case" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_case" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ticket_tenant_isolation"       ON "support_case";
DROP POLICY IF EXISTS "support_case_tenant_isolation" ON "support_case";
CREATE POLICY "support_case_tenant_isolation" ON "support_case"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "support_case"     TO decrm_app;
GRANT USAGE                          ON SEQUENCE "seq_support_case" TO decrm_app;

-- ─── 6. Permission strings in user_group_permission ─────────────────────
-- A group might already have BOTH the old ('tickets.*') and the new
-- ('cases.*') rows (post-0025 was updated to seed the new strings before
-- this rename had a chance to run). We can't simply UPDATE — that would
-- cause a primary-key collision when both already exist. Insert-the-new
-- (idempotent) and then delete-the-old:

INSERT INTO "user_group_permission" ("group_id", "permission")
SELECT "group_id", 'cases.read'
FROM   "user_group_permission"
WHERE  "permission" = 'tickets.read'
ON CONFLICT DO NOTHING;

INSERT INTO "user_group_permission" ("group_id", "permission")
SELECT "group_id", 'cases.write'
FROM   "user_group_permission"
WHERE  "permission" = 'tickets.write'
ON CONFLICT DO NOTHING;

DELETE FROM "user_group_permission" WHERE "permission" IN ('tickets.read', 'tickets.write');

-- ─── 7. Audit log: rotate target_type 'ticket' → 'support_case' ─────────
-- audit_log is INSERT-only by trigger (post-0004), but historical UPDATEs
-- to fix labels are explicitly allowed (the trigger gates against table
-- deletes/truncates). We do an UPDATE here; if the trigger forbids it,
-- the rows simply stay tagged 'ticket' which is harmless.
DO $$ BEGIN
  BEGIN
    UPDATE "audit_log" SET "target_type" = 'support_case' WHERE "target_type" = 'ticket';
  EXCEPTION WHEN others THEN
    -- Audit log tables sometimes have triggers that block UPDATE.
    -- Old rows remain tagged 'ticket'. Acceptable for historical records.
    RAISE NOTICE 'audit_log target_type rotation skipped: %', SQLERRM;
  END;
END $$;
