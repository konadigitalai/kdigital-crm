-- Lead tasks / activities — the schedulable, forward-looking counterpart to
-- the `activity` table.
--
-- Why a new table rather than reusing what's there:
--   - `activity` is an append-only PAST-tense feed (ts, verb, detail). It has
--     no due date, status or assignee, so a follow-up scheduled for Friday is
--     unqueryable — today it survives only as payload.kind='schedule' text.
--   - `calendar_event` is people-centric (organizer + RSVP invitees) and has
--     no work_item link, so a lead's demo can't hang off it.
--
-- `lead_task` is what the Leads calendar reads: one row per scheduled thing an
-- advisor owes a lead (follow-up, call, demo, campus visit, enrolment…), with
-- a due_at, an open/done/cancelled lifecycle, and an assignee.
--
-- Creating / completing a task still writes a mirror row into `activity`, so
-- the record-page timeline keeps working with no changes (same trick
-- leads.ts already uses for notes and comms).
--
-- Idempotent — safe to replay.

CREATE TABLE IF NOT EXISTS lead_task (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  work_item_id        uuid NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
  kind                text NOT NULL DEFAULT 'follow_up',
  title               text NOT NULL,
  notes               text,
  -- The instant the task is due. all_day rows still carry a timestamp (IST
  -- midnight) so a single ORDER BY due_at sorts timed and all-day together;
  -- the UI keys off all_day to decide whether to render a time.
  due_at              timestamptz NOT NULL,
  all_day             boolean NOT NULL DEFAULT false,
  duration_min        integer,
  status              text NOT NULL DEFAULT 'open',
  assignee_party_id   uuid REFERENCES party(id) ON DELETE SET NULL,
  created_by_party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT lead_task_kind_check
    CHECK (kind IN ('follow_up','call','demo','campus_visit',
                    'trainer_talk','enrollment','re_engage','task')),
  CONSTRAINT lead_task_status_check
    CHECK (status IN ('open','done','cancelled')),
  CONSTRAINT lead_task_duration_check
    CHECK (duration_min IS NULL OR duration_min BETWEEN 1 AND 1440)
);

-- The calendar's only query shape: everything in a month window, tenant-wide.
CREATE INDEX IF NOT EXISTS lead_task_tenant_due_idx
  ON lead_task (tenant_id, due_at);

-- The record page's Activity panel: this lead's tasks, soonest first.
CREATE INDEX IF NOT EXISTS lead_task_wi_due_idx
  ON lead_task (tenant_id, work_item_id, due_at);

-- "My open tasks" — the advisor filter on the calendar toolbar.
CREATE INDEX IF NOT EXISTS lead_task_assignee_open_idx
  ON lead_task (tenant_id, assignee_party_id, due_at)
  WHERE status = 'open';

-- ─── Grants ──────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_task TO decrm_app;

-- ─── RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE lead_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_task FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_task_tenant_isolation ON lead_task;
CREATE POLICY lead_task_tenant_isolation ON lead_task
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);
