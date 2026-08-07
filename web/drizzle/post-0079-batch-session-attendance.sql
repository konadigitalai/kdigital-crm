-- Batch sessions + attendance — the persisted backbone of the Batches board's
-- Coverage %, Attendance %, and recording-SLA rollups.
--
--   batch_session : one row per ACTUAL class occurrence, materialized from the
--                   cohort schedule (days_of_week + times + date bounds). Status
--                   moves planned → delivered (or cancelled); a recording url +
--                   published timestamp drive coverage and the SLA check.
--   attendance    : one row per learner per session (present|absent|late|excused).
--                   The roster is the cohort's active batch_assignment learners;
--                   an unmarked learner has no row.
--
-- Both tables are also declared in src/db/schema.ts (source of truth for columns/
-- indexes/checks). This file adds the pieces Drizzle can't express — GRANTs +
-- RLS — and CREATE TABLE IF NOT EXISTS as belt-and-suspenders. Idempotent.

CREATE TABLE IF NOT EXISTS batch_session (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenant(id),
  cohort_id              uuid NOT NULL REFERENCES cohort(id) ON DELETE CASCADE,
  session_date           date NOT NULL,
  start_time             time,
  end_time               time,
  status                 text NOT NULL DEFAULT 'planned',
  recording_url          text,
  recording_published_at timestamptz,
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT batch_session_status_check CHECK (status IN ('planned','delivered','cancelled'))
);

-- One session per (cohort, date) — makes POST …/materialize idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS batch_session_uniq
  ON batch_session (cohort_id, session_date);
CREATE INDEX IF NOT EXISTS batch_session_cohort_idx
  ON batch_session (tenant_id, cohort_id, session_date);
CREATE INDEX IF NOT EXISTS batch_session_date_idx
  ON batch_session (tenant_id, session_date);

CREATE TABLE IF NOT EXISTS attendance (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  batch_session_id uuid NOT NULL REFERENCES batch_session(id) ON DELETE CASCADE,
  party_id         uuid NOT NULL REFERENCES party(id),
  status           text NOT NULL DEFAULT 'present',
  marked_by        uuid REFERENCES party(id) ON DELETE SET NULL,
  marked_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_status_check CHECK (status IN ('present','absent','late','excused'))
);

-- One mark per (session, learner) — upsert key for PUT …/attendance.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_uniq
  ON attendance (batch_session_id, party_id);
CREATE INDEX IF NOT EXISTS attendance_session_idx
  ON attendance (tenant_id, batch_session_id);
CREATE INDEX IF NOT EXISTS attendance_party_idx
  ON attendance (tenant_id, party_id);

-- ─── Grants ──────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON batch_session TO decrm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON attendance    TO decrm_app;

-- ─── RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE batch_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_session FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS batch_session_tenant_isolation ON batch_session;
CREATE POLICY batch_session_tenant_isolation ON batch_session
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS attendance_tenant_isolation ON attendance;
CREATE POLICY attendance_tenant_isolation ON attendance
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);
