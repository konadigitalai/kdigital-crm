-- Phase 2 of the Party Model migration — flip every FK that names a person
-- from app_user.id → party.id.
--
-- Strategy for each of the 17 columns: rename-in-place.
--    1. Add sibling <col>_new uuid (nullability matches original).
--    2. Backfill: SET <col>_new = u.party_id FROM app_user u WHERE t.<col> = u.id.
--    3. If original was NOT NULL, tighten <col>_new to NOT NULL post-backfill.
--    4. Add FK <col>_new → party(id) with the same ON DELETE rule.
--    5. Drop the old FK constraint and old column.
--    6. Rename <col>_new → <col> (indexes on <col>_new follow the rename).
--    7. Recreate any indexes that referenced the OLD column (dropped in step 5).
--
-- Preflight: assert every app_user has party_id (post-0044 already enforced this,
-- but re-check so this migration is self-contained if run standalone).
--
-- Idempotent guards on every step: check if <col>_new exists / if new FK
-- already points at party. Safe to re-run.

-- ─── Preflight ────────────────────────────────────────────────────────────
DO $$
DECLARE orphans int;
BEGIN
  SELECT count(*) INTO orphans FROM app_user WHERE party_id IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION 'post-0045: cannot flip FKs — % app_user rows have NULL party_id (run post-0044 first)', orphans;
  END IF;
END $$;

-- Helper: returns true if the given column already references party(id).
-- We use this to make each block a no-op on re-run.
CREATE OR REPLACE FUNCTION _pm_col_targets(_table text, _column text, _target_table text)
RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class      t ON t.oid = c.conrelid
    JOIN pg_class      ft ON ft.oid = c.confrelid
    JOIN pg_attribute  a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f'
      AND t.relname = _table
      AND a.attname = _column
      AND ft.relname = _target_table
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Column-by-column flips. Each block is independent + idempotent.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. work_item.assignee_id (nullable, no ON DELETE rule)
DO $$ BEGIN
  IF NOT _pm_col_targets('work_item','assignee_id','party') THEN
    ALTER TABLE work_item ADD COLUMN IF NOT EXISTS assignee_id_new uuid;
    UPDATE work_item t SET assignee_id_new = u.party_id
      FROM app_user u WHERE t.assignee_id = u.id AND t.assignee_id_new IS NULL;
    ALTER TABLE work_item ADD CONSTRAINT work_item_assignee_party_fk
      FOREIGN KEY (assignee_id_new) REFERENCES party(id);
    ALTER TABLE work_item DROP CONSTRAINT IF EXISTS work_item_assignee_id_app_user_id_fk;
    DROP INDEX IF EXISTS wi_assignee_idx;
    ALTER TABLE work_item DROP COLUMN assignee_id;
    ALTER TABLE work_item RENAME COLUMN assignee_id_new TO assignee_id;
    -- Keep the ORIGINAL constraint name so downstream idempotency guards
    -- (IF NOT EXISTS WHERE conname = 'work_item_assignee_id_app_user_id_fk')
    -- still see the constraint on re-run and skip.
    ALTER TABLE work_item RENAME CONSTRAINT work_item_assignee_party_fk TO work_item_assignee_id_app_user_id_fk;
    CREATE INDEX wi_assignee_idx ON work_item (tenant_id, assignee_id);
  END IF;
END $$;

-- 2. lead.advisor_id (nullable, no ON DELETE rule)
DO $$ BEGIN
  IF NOT _pm_col_targets('lead','advisor_id','party') THEN
    ALTER TABLE lead ADD COLUMN IF NOT EXISTS advisor_id_new uuid;
    UPDATE lead t SET advisor_id_new = u.party_id
      FROM app_user u WHERE t.advisor_id = u.id AND t.advisor_id_new IS NULL;
    ALTER TABLE lead ADD CONSTRAINT lead_advisor_party_fk
      FOREIGN KEY (advisor_id_new) REFERENCES party(id);
    ALTER TABLE lead DROP CONSTRAINT IF EXISTS lead_advisor_id_app_user_id_fk;
    DROP INDEX IF EXISTS lead_advisor_idx;
    ALTER TABLE lead DROP COLUMN advisor_id;
    ALTER TABLE lead RENAME COLUMN advisor_id_new TO advisor_id;
    ALTER TABLE lead RENAME CONSTRAINT lead_advisor_party_fk TO lead_advisor_id_app_user_id_fk;
    CREATE INDEX lead_advisor_idx ON lead (tenant_id, advisor_id);
  END IF;
END $$;

-- 3. cohort.trainer_id (nullable, ON DELETE SET NULL)
DO $$ BEGIN
  IF NOT _pm_col_targets('cohort','trainer_id','party') THEN
    ALTER TABLE cohort ADD COLUMN IF NOT EXISTS trainer_id_new uuid;
    UPDATE cohort t SET trainer_id_new = u.party_id
      FROM app_user u WHERE t.trainer_id = u.id AND t.trainer_id_new IS NULL;
    ALTER TABLE cohort ADD CONSTRAINT cohort_trainer_party_fk
      FOREIGN KEY (trainer_id_new) REFERENCES party(id) ON DELETE SET NULL;
    ALTER TABLE cohort DROP CONSTRAINT IF EXISTS cohort_trainer_fk;
    DROP INDEX IF EXISTS cohort_trainer_idx;
    ALTER TABLE cohort DROP COLUMN trainer_id;
    ALTER TABLE cohort RENAME COLUMN trainer_id_new TO trainer_id;
    ALTER TABLE cohort RENAME CONSTRAINT cohort_trainer_party_fk TO cohort_trainer_fk;
    CREATE INDEX cohort_trainer_idx ON cohort (tenant_id, trainer_id);
  END IF;
END $$;

-- 4. cohort.co_trainer_id (nullable, ON DELETE SET NULL)
DO $$ BEGIN
  IF NOT _pm_col_targets('cohort','co_trainer_id','party') THEN
    ALTER TABLE cohort ADD COLUMN IF NOT EXISTS co_trainer_id_new uuid;
    UPDATE cohort t SET co_trainer_id_new = u.party_id
      FROM app_user u WHERE t.co_trainer_id = u.id AND t.co_trainer_id_new IS NULL;
    ALTER TABLE cohort ADD CONSTRAINT cohort_co_trainer_party_fk
      FOREIGN KEY (co_trainer_id_new) REFERENCES party(id) ON DELETE SET NULL;
    ALTER TABLE cohort DROP CONSTRAINT IF EXISTS cohort_co_trainer_fk;
    DROP INDEX IF EXISTS cohort_co_trainer_idx;
    ALTER TABLE cohort DROP COLUMN co_trainer_id;
    ALTER TABLE cohort RENAME COLUMN co_trainer_id_new TO co_trainer_id;
    ALTER TABLE cohort RENAME CONSTRAINT cohort_co_trainer_party_fk TO cohort_co_trainer_fk;
    CREATE INDEX cohort_co_trainer_idx ON cohort (tenant_id, co_trainer_id);
  END IF;
END $$;

-- 5. support_case.created_by_id (nullable, no ON DELETE rule)
DO $$ BEGIN
  IF NOT _pm_col_targets('support_case','created_by_id','party') THEN
    ALTER TABLE support_case ADD COLUMN IF NOT EXISTS created_by_id_new uuid;
    UPDATE support_case t SET created_by_id_new = u.party_id
      FROM app_user u WHERE t.created_by_id = u.id AND t.created_by_id_new IS NULL;
    ALTER TABLE support_case ADD CONSTRAINT support_case_created_by_party_fk
      FOREIGN KEY (created_by_id_new) REFERENCES party(id);
    ALTER TABLE support_case DROP CONSTRAINT IF EXISTS support_case_created_by_id_app_user_id_fk;
    ALTER TABLE support_case DROP COLUMN created_by_id;
    ALTER TABLE support_case RENAME COLUMN created_by_id_new TO created_by_id;
    ALTER TABLE support_case RENAME CONSTRAINT support_case_created_by_party_fk TO support_case_created_by_id_app_user_id_fk;
  END IF;
END $$;

-- 6. approval.decided_by (nullable, no ON DELETE rule)
DO $$ BEGIN
  IF NOT _pm_col_targets('approval','decided_by','party') THEN
    ALTER TABLE approval ADD COLUMN IF NOT EXISTS decided_by_new uuid;
    UPDATE approval t SET decided_by_new = u.party_id
      FROM app_user u WHERE t.decided_by = u.id AND t.decided_by_new IS NULL;
    ALTER TABLE approval ADD CONSTRAINT approval_decided_by_party_fk
      FOREIGN KEY (decided_by_new) REFERENCES party(id);
    ALTER TABLE approval DROP CONSTRAINT IF EXISTS approval_decided_by_app_user_id_fk;
    ALTER TABLE approval DROP COLUMN decided_by;
    ALTER TABLE approval RENAME COLUMN decided_by_new TO decided_by;
    ALTER TABLE approval RENAME CONSTRAINT approval_decided_by_party_fk TO approval_decided_by_app_user_id_fk;
  END IF;
END $$;

-- 7. forecast_snapshot.generated_by (nullable, no ON DELETE rule in schema.ts; existing DB has SET NULL)
DO $$ BEGIN
  IF NOT _pm_col_targets('forecast_snapshot','generated_by','party') THEN
    ALTER TABLE forecast_snapshot ADD COLUMN IF NOT EXISTS generated_by_new uuid;
    UPDATE forecast_snapshot t SET generated_by_new = u.party_id
      FROM app_user u WHERE t.generated_by = u.id AND t.generated_by_new IS NULL;
    ALTER TABLE forecast_snapshot ADD CONSTRAINT forecast_snapshot_generated_by_party_fk
      FOREIGN KEY (generated_by_new) REFERENCES party(id) ON DELETE SET NULL;
    ALTER TABLE forecast_snapshot DROP CONSTRAINT IF EXISTS forecast_snapshot_user_fk;
    ALTER TABLE forecast_snapshot DROP COLUMN generated_by;
    ALTER TABLE forecast_snapshot RENAME COLUMN generated_by_new TO generated_by;
    ALTER TABLE forecast_snapshot RENAME CONSTRAINT forecast_snapshot_generated_by_party_fk TO forecast_snapshot_user_fk;
  END IF;
END $$;

-- 8. edify_chat_session.user_id (NOT NULL, ON DELETE CASCADE)
DO $$ BEGIN
  IF NOT _pm_col_targets('edify_chat_session','user_id','party') THEN
    ALTER TABLE edify_chat_session ADD COLUMN IF NOT EXISTS user_id_new uuid;
    UPDATE edify_chat_session t SET user_id_new = u.party_id
      FROM app_user u WHERE t.user_id = u.id AND t.user_id_new IS NULL;
    ALTER TABLE edify_chat_session ALTER COLUMN user_id_new SET NOT NULL;
    ALTER TABLE edify_chat_session ADD CONSTRAINT edify_chat_session_user_party_fk
      FOREIGN KEY (user_id_new) REFERENCES party(id) ON DELETE CASCADE;
    ALTER TABLE edify_chat_session DROP CONSTRAINT IF EXISTS edify_session_user_fk;
    DROP INDEX IF EXISTS edify_session_user_time_idx;
    ALTER TABLE edify_chat_session DROP COLUMN user_id;
    ALTER TABLE edify_chat_session RENAME COLUMN user_id_new TO user_id;
    ALTER TABLE edify_chat_session RENAME CONSTRAINT edify_chat_session_user_party_fk TO edify_session_user_fk;
    CREATE INDEX edify_session_user_time_idx ON edify_chat_session (tenant_id, user_id, last_at DESC);
  END IF;
END $$;

-- 9. edify_chat_message.user_id (NOT NULL, ON DELETE CASCADE)
DO $$ BEGIN
  IF NOT _pm_col_targets('edify_chat_message','user_id','party') THEN
    ALTER TABLE edify_chat_message ADD COLUMN IF NOT EXISTS user_id_new uuid;
    UPDATE edify_chat_message t SET user_id_new = u.party_id
      FROM app_user u WHERE t.user_id = u.id AND t.user_id_new IS NULL;
    ALTER TABLE edify_chat_message ALTER COLUMN user_id_new SET NOT NULL;
    ALTER TABLE edify_chat_message ADD CONSTRAINT edify_chat_message_user_party_fk
      FOREIGN KEY (user_id_new) REFERENCES party(id) ON DELETE CASCADE;
    ALTER TABLE edify_chat_message DROP CONSTRAINT IF EXISTS edify_chat_user_fk;
    DROP INDEX IF EXISTS edify_chat_user_time_idx;
    ALTER TABLE edify_chat_message DROP COLUMN user_id;
    ALTER TABLE edify_chat_message RENAME COLUMN user_id_new TO user_id;
    ALTER TABLE edify_chat_message RENAME CONSTRAINT edify_chat_message_user_party_fk TO edify_chat_user_fk;
    CREATE INDEX edify_chat_user_time_idx ON edify_chat_message (tenant_id, user_id, asked_at DESC);
  END IF;
END $$;

-- 10. leave_day.user_id (NOT NULL, ON DELETE CASCADE, UNIQUE (user_id, date))
DO $$ BEGIN
  IF NOT _pm_col_targets('leave_day','user_id','party') THEN
    ALTER TABLE leave_day ADD COLUMN IF NOT EXISTS user_id_new uuid;
    UPDATE leave_day t SET user_id_new = u.party_id
      FROM app_user u WHERE t.user_id = u.id AND t.user_id_new IS NULL;
    ALTER TABLE leave_day ALTER COLUMN user_id_new SET NOT NULL;
    ALTER TABLE leave_day ADD CONSTRAINT leave_day_user_party_fk
      FOREIGN KEY (user_id_new) REFERENCES party(id) ON DELETE CASCADE;
    ALTER TABLE leave_day DROP CONSTRAINT IF EXISTS leave_day_user_fk;
    DROP INDEX IF EXISTS leave_day_user_date_key;   -- unique index on (user_id, date)
    ALTER TABLE leave_day DROP COLUMN user_id;
    ALTER TABLE leave_day RENAME COLUMN user_id_new TO user_id;
    ALTER TABLE leave_day RENAME CONSTRAINT leave_day_user_party_fk TO leave_day_user_fk;
    CREATE UNIQUE INDEX leave_day_user_date_key ON leave_day (user_id, date);
  END IF;
END $$;

-- 11. calendar_event.organizer_id (NOT NULL, ON DELETE CASCADE)
DO $$ BEGIN
  IF NOT _pm_col_targets('calendar_event','organizer_id','party') THEN
    ALTER TABLE calendar_event ADD COLUMN IF NOT EXISTS organizer_id_new uuid;
    UPDATE calendar_event t SET organizer_id_new = u.party_id
      FROM app_user u WHERE t.organizer_id = u.id AND t.organizer_id_new IS NULL;
    ALTER TABLE calendar_event ALTER COLUMN organizer_id_new SET NOT NULL;
    ALTER TABLE calendar_event ADD CONSTRAINT calendar_event_organizer_party_fk
      FOREIGN KEY (organizer_id_new) REFERENCES party(id) ON DELETE CASCADE;
    ALTER TABLE calendar_event DROP CONSTRAINT IF EXISTS calendar_event_org_fk;
    DROP INDEX IF EXISTS calendar_event_org_time_idx;
    ALTER TABLE calendar_event DROP COLUMN organizer_id;
    ALTER TABLE calendar_event RENAME COLUMN organizer_id_new TO organizer_id;
    ALTER TABLE calendar_event RENAME CONSTRAINT calendar_event_organizer_party_fk TO calendar_event_org_fk;
    CREATE INDEX calendar_event_org_time_idx ON calendar_event (tenant_id, organizer_id, start_at);
  END IF;
END $$;

-- 12. calendar_invitee.user_id (NOT NULL, ON DELETE CASCADE, has 2 indexes)
DO $$ BEGIN
  IF NOT _pm_col_targets('calendar_invitee','user_id','party') THEN
    ALTER TABLE calendar_invitee ADD COLUMN IF NOT EXISTS user_id_new uuid;
    UPDATE calendar_invitee t SET user_id_new = u.party_id
      FROM app_user u WHERE t.user_id = u.id AND t.user_id_new IS NULL;
    ALTER TABLE calendar_invitee ALTER COLUMN user_id_new SET NOT NULL;
    ALTER TABLE calendar_invitee ADD CONSTRAINT calendar_invitee_user_party_fk
      FOREIGN KEY (user_id_new) REFERENCES party(id) ON DELETE CASCADE;
    ALTER TABLE calendar_invitee DROP CONSTRAINT IF EXISTS calendar_invitee_user_fk;
    DROP INDEX IF EXISTS calendar_invitee_pk;
    DROP INDEX IF EXISTS calendar_invitee_user_idx;
    ALTER TABLE calendar_invitee DROP COLUMN user_id;
    ALTER TABLE calendar_invitee RENAME COLUMN user_id_new TO user_id;
    ALTER TABLE calendar_invitee RENAME CONSTRAINT calendar_invitee_user_party_fk TO calendar_invitee_user_fk;
    CREATE UNIQUE INDEX calendar_invitee_pk ON calendar_invitee (event_id, user_id);
    CREATE INDEX calendar_invitee_user_idx ON calendar_invitee (user_id, rsvp);
  END IF;
END $$;

-- 13. saved_view.owner_id (NOT NULL, ON DELETE CASCADE)
DO $$ BEGIN
  IF NOT _pm_col_targets('saved_view','owner_id','party') THEN
    ALTER TABLE saved_view ADD COLUMN IF NOT EXISTS owner_id_new uuid;
    UPDATE saved_view t SET owner_id_new = u.party_id
      FROM app_user u WHERE t.owner_id = u.id AND t.owner_id_new IS NULL;
    ALTER TABLE saved_view ALTER COLUMN owner_id_new SET NOT NULL;
    ALTER TABLE saved_view ADD CONSTRAINT saved_view_owner_party_fk
      FOREIGN KEY (owner_id_new) REFERENCES party(id) ON DELETE CASCADE;
    ALTER TABLE saved_view DROP CONSTRAINT IF EXISTS saved_view_owner_fk;
    DROP INDEX IF EXISTS saved_view_owner_scope_idx;
    ALTER TABLE saved_view DROP COLUMN owner_id;
    ALTER TABLE saved_view RENAME COLUMN owner_id_new TO owner_id;
    ALTER TABLE saved_view RENAME CONSTRAINT saved_view_owner_party_fk TO saved_view_owner_fk;
    CREATE INDEX saved_view_owner_scope_idx ON saved_view (tenant_id, owner_id, scope);
  END IF;
END $$;

-- 14. wa_conversation.assigned_user_id (nullable, ON DELETE SET NULL, partial index)
DO $$ BEGIN
  IF NOT _pm_col_targets('wa_conversation','assigned_user_id','party') THEN
    ALTER TABLE wa_conversation ADD COLUMN IF NOT EXISTS assigned_user_id_new uuid;
    UPDATE wa_conversation t SET assigned_user_id_new = u.party_id
      FROM app_user u WHERE t.assigned_user_id = u.id AND t.assigned_user_id_new IS NULL;
    ALTER TABLE wa_conversation ADD CONSTRAINT wa_conversation_assigned_party_fk
      FOREIGN KEY (assigned_user_id_new) REFERENCES party(id) ON DELETE SET NULL;
    ALTER TABLE wa_conversation DROP CONSTRAINT IF EXISTS wa_conversation_assigned_fk;
    DROP INDEX IF EXISTS wa_conversation_assignee_idx;
    ALTER TABLE wa_conversation DROP COLUMN assigned_user_id;
    ALTER TABLE wa_conversation RENAME COLUMN assigned_user_id_new TO assigned_user_id;
    ALTER TABLE wa_conversation RENAME CONSTRAINT wa_conversation_assigned_party_fk TO wa_conversation_assigned_fk;
    CREATE INDEX wa_conversation_assignee_idx ON wa_conversation (tenant_id, assigned_user_id, status)
      WHERE assigned_user_id IS NOT NULL;
  END IF;
END $$;

-- 15. wa_message.sender_user_id (nullable, ON DELETE SET NULL)
DO $$ BEGIN
  IF NOT _pm_col_targets('wa_message','sender_user_id','party') THEN
    ALTER TABLE wa_message ADD COLUMN IF NOT EXISTS sender_user_id_new uuid;
    UPDATE wa_message t SET sender_user_id_new = u.party_id
      FROM app_user u WHERE t.sender_user_id = u.id AND t.sender_user_id_new IS NULL;
    ALTER TABLE wa_message ADD CONSTRAINT wa_message_sender_user_party_fk
      FOREIGN KEY (sender_user_id_new) REFERENCES party(id) ON DELETE SET NULL;
    ALTER TABLE wa_message DROP CONSTRAINT IF EXISTS wa_message_sender_user_fk;
    ALTER TABLE wa_message DROP COLUMN sender_user_id;
    ALTER TABLE wa_message RENAME COLUMN sender_user_id_new TO sender_user_id;
    ALTER TABLE wa_message RENAME CONSTRAINT wa_message_sender_user_party_fk TO wa_message_sender_user_fk;
  END IF;
END $$;

-- 16. wa_broadcast.created_by (nullable, ON DELETE SET NULL)
DO $$ BEGIN
  IF NOT _pm_col_targets('wa_broadcast','created_by','party') THEN
    ALTER TABLE wa_broadcast ADD COLUMN IF NOT EXISTS created_by_new uuid;
    UPDATE wa_broadcast t SET created_by_new = u.party_id
      FROM app_user u WHERE t.created_by = u.id AND t.created_by_new IS NULL;
    ALTER TABLE wa_broadcast ADD CONSTRAINT wa_broadcast_creator_party_fk
      FOREIGN KEY (created_by_new) REFERENCES party(id) ON DELETE SET NULL;
    ALTER TABLE wa_broadcast DROP CONSTRAINT IF EXISTS wa_broadcast_creator_fk;
    ALTER TABLE wa_broadcast DROP COLUMN created_by;
    ALTER TABLE wa_broadcast RENAME COLUMN created_by_new TO created_by;
    ALTER TABLE wa_broadcast RENAME CONSTRAINT wa_broadcast_creator_party_fk TO wa_broadcast_creator_fk;
  END IF;
END $$;

-- 17. wa_automation.created_by (nullable, ON DELETE SET NULL)
DO $$ BEGIN
  IF NOT _pm_col_targets('wa_automation','created_by','party') THEN
    ALTER TABLE wa_automation ADD COLUMN IF NOT EXISTS created_by_new uuid;
    UPDATE wa_automation t SET created_by_new = u.party_id
      FROM app_user u WHERE t.created_by = u.id AND t.created_by_new IS NULL;
    ALTER TABLE wa_automation ADD CONSTRAINT wa_automation_creator_party_fk
      FOREIGN KEY (created_by_new) REFERENCES party(id) ON DELETE SET NULL;
    ALTER TABLE wa_automation DROP CONSTRAINT IF EXISTS wa_automation_creator_fk;
    ALTER TABLE wa_automation DROP COLUMN created_by;
    ALTER TABLE wa_automation RENAME COLUMN created_by_new TO created_by;
    ALTER TABLE wa_automation RENAME CONSTRAINT wa_automation_creator_party_fk TO wa_automation_creator_fk;
  END IF;
END $$;

-- ─── Final assertion: no FK anywhere still targets app_user (except app_user.party_id itself) ─
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(
    format('%s.%s → app_user (constraint %s)',
      conrelid::regclass, (SELECT string_agg(attname, ',')
                            FROM pg_attribute
                            WHERE attrelid = c.conrelid AND attnum = ANY(c.conkey)),
      conname), E'\n')
  INTO bad
  FROM pg_constraint c
  JOIN pg_class ft ON ft.oid = c.confrelid
  WHERE c.contype = 'f'
    AND ft.relname = 'app_user'
    AND c.conrelid::regclass::text NOT IN ('app_user'); -- self-references shouldn't exist, but be safe
  IF bad IS NOT NULL THEN
    RAISE WARNING 'post-0045: remaining FKs still target app_user:\n%', bad;
  ELSE
    RAISE NOTICE 'post-0045: all person-shaped FKs now target party — flip complete';
  END IF;
END $$;

-- Cleanup the helper function so it doesn't linger.
DROP FUNCTION IF EXISTS _pm_col_targets(text, text, text);
