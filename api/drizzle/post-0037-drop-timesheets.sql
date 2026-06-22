-- Drop timesheets feature (work_session + time_block tables) and rename
-- the leftover `timesheets.read.*` permission rows to `leaves.read.*`.
--
-- Background: timesheets was Phase G but is being removed. Leaves stays
-- and was previously gated on `timesheets.read.self/all` — those rows
-- have to be renamed so existing groups don't lose access to leaves.
--
-- Idempotent. Safe to re-run.

-- 1. Drop work_session + time_block. CASCADE removes any leftover FKs.
--    leave_day stays; calendar_event stays.
DROP TABLE IF EXISTS "time_block"   CASCADE;
DROP TABLE IF EXISTS "work_session" CASCADE;

-- 2. Rename existing user_group_permission rows so groups that had
--    `timesheets.read.*` keep equivalent access via the new names.
--    UPDATE skips rows that are already on the new permission name.
UPDATE "user_group_permission"
   SET permission = 'leaves.read.self'
 WHERE permission = 'timesheets.read.self'
   AND NOT EXISTS (
     SELECT 1 FROM "user_group_permission" p2
     WHERE p2.group_id = "user_group_permission".group_id
       AND p2.permission = 'leaves.read.self'
   );
UPDATE "user_group_permission"
   SET permission = 'leaves.read.all'
 WHERE permission = 'timesheets.read.all'
   AND NOT EXISTS (
     SELECT 1 FROM "user_group_permission" p2
     WHERE p2.group_id = "user_group_permission".group_id
       AND p2.permission = 'leaves.read.all'
   );

-- 3. Clean up any leftover rows where the rename couldn't happen (because
--    a duplicate `leaves.read.*` row already exists). These are stale.
DELETE FROM "user_group_permission" WHERE permission = 'timesheets.read.self';
DELETE FROM "user_group_permission" WHERE permission = 'timesheets.read.all';
