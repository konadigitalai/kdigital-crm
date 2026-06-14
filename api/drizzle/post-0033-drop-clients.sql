-- Drop the client domain entirely.
--
-- Wipes:
--   - time_block.client_id column + its FK + the client_idx index
--   - client_assignment table (RLS policy + grants drop with it)
--   - client table (RLS policy + grants drop with it)
--   - clients.manage permission rows from user_group_permission
--
-- Idempotent. Safe to re-run on every db:migrate.
--
-- This is irreversible: any existing time_blocks lose their client linkage.
-- Confirmed before write: 5 time_blocks had client_id set in dev, all test data.

-- 1. Drop FK + index on time_block, then the column itself.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_block_client_fk') THEN
    ALTER TABLE "time_block" DROP CONSTRAINT "time_block_client_fk";
  END IF;
END $$;

DROP INDEX IF EXISTS "time_block_client_idx";

ALTER TABLE "time_block" DROP COLUMN IF EXISTS "client_id";

-- 2. Drop the join table first (FKs cascade if anything still points to it,
--    but explicit DROP is clearer).
DROP TABLE IF EXISTS "client_assignment" CASCADE;

-- 3. Drop the client table.
DROP TABLE IF EXISTS "client" CASCADE;

-- 4. Strip the deprecated `clients.manage` permission from any group it
--    was granted to. The string is no longer in the API's catalog so
--    leaving it would be dead data.
DELETE FROM user_group_permission WHERE permission = 'clients.manage';
