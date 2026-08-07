-- LMS — the learner-facing layer on top of the existing batch spine.
--
-- Shape, mirroring how course → cohort → batch_assignment already works:
--
--   cohort (batch)              existing
--     └── module                ordered units of study inside ONE batch
--           ├── module_resource video | recording | document | note | link
--           └── coursework      lab | assignment | assessment
--                 └── submission  one per learner per attempt
--
-- A learner sees a batch because they hold a batch_assignment row on it.
-- That is the whole access rule; nothing here re-implements it.
--
-- Modules hang off cohort, not course, deliberately: each batch's trainer
-- curates their own material. The cost is duplication when the same course
-- runs repeatedly — mitigated by a copy-from-batch action in the admin UI,
-- not by schema.
--
-- Progress is NEVER stored as a percentage. resource_progress holds facts
-- (position, completed_at); every "44%" in the UI is computed. A stored
-- percentage goes stale the moment an admin adds a resource.
--
-- Also declared in src/db/schema.ts (source of truth for columns/indexes).
-- This file adds what Drizzle can't express — GRANTs + RLS — plus
-- CREATE TABLE IF NOT EXISTS as belt-and-suspenders. Idempotent.

-- ─── Sequences ───────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS seq_learner     START 7000;
CREATE SEQUENCE IF NOT EXISTS seq_certificate START 20000;
GRANT USAGE, SELECT ON SEQUENCE seq_learner     TO decrm_app;
GRANT USAGE, SELECT ON SEQUENCE seq_certificate TO decrm_app;

-- ─── Columns on existing tables ──────────────────────────────────────────
-- LRN-#### shown in the portal header. Same pattern as enrolment.number.
ALTER TABLE learner_profile ADD COLUMN IF NOT EXISTS number text;
CREATE UNIQUE INDEX IF NOT EXISTS learner_profile_number_key
  ON learner_profile (tenant_id, number) WHERE number IS NOT NULL;

-- Backfill existing learners so nobody is left without an identifier.
UPDATE learner_profile
   SET number = 'LRN-' || lpad(nextval('seq_learner')::text, 4, '0')
 WHERE number IS NULL;

-- "Join at 7:00pm" had no source. Recurring link on the batch; a session may
-- override it (one-off room change) — readers COALESCE session over cohort.
ALTER TABLE cohort        ADD COLUMN IF NOT EXISTS join_url text;
ALTER TABLE batch_session ADD COLUMN IF NOT EXISTS join_url text;

-- ─── module ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS module (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  cohort_id  uuid NOT NULL REFERENCES cohort(id) ON DELETE CASCADE,
  rank       integer NOT NULL DEFAULT 0,
  title      text NOT NULL,
  summary    text,
  -- draft modules are invisible to lms.read.self; admins build then publish.
  status     text NOT NULL DEFAULT 'draft',
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_status_check CHECK (status IN ('draft','published'))
);
CREATE INDEX IF NOT EXISTS module_cohort_idx ON module (tenant_id, cohort_id, rank);

-- ─── module_resource ─────────────────────────────────────────────────────
-- kind drives which of the payload columns is meaningful. Enforced by the
-- CHECK below rather than by separate tables — five near-empty sibling
-- tables would buy nothing and cost every read a union.
CREATE TABLE IF NOT EXISTS module_resource (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  module_id        uuid NOT NULL REFERENCES module(id) ON DELETE CASCADE,
  rank             integer NOT NULL DEFAULT 0,
  title            text NOT NULL,
  kind             text NOT NULL,
  -- video | recording. Store the Vimeo ID, never a URL: the embed template,
  -- player options and privacy mode then live in one place in code.
  video_provider   text,
  video_ref        text,
  duration_seconds integer,
  -- recording: point at the class it came from instead of copying its URL,
  -- so batch_session stays the single source of truth for recordings.
  batch_session_id uuid REFERENCES batch_session(id) ON DELETE SET NULL,
  body             text,     -- note: markdown
  media_asset_id   uuid REFERENCES media_asset(id) ON DELETE SET NULL, -- document
  external_url     text,     -- link
  -- Only required resources count toward module completion.
  required         boolean NOT NULL DEFAULT true,
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_resource_kind_check
    CHECK (kind IN ('video','recording','document','note','link')),
  -- Each kind must carry its own payload. Cheap guarantee that a video row
  -- can always be played and a link row always resolves.
  CONSTRAINT module_resource_payload_check CHECK (
    (kind IN ('video','recording') AND video_ref  IS NOT NULL) OR
    (kind = 'document'            AND media_asset_id IS NOT NULL) OR
    (kind = 'note'                AND body        IS NOT NULL) OR
    (kind = 'link'                AND external_url IS NOT NULL)
  ),
  CONSTRAINT module_resource_duration_check
    CHECK (duration_seconds IS NULL OR duration_seconds > 0)
);
CREATE INDEX IF NOT EXISTS module_resource_module_idx
  ON module_resource (tenant_id, module_id, rank);
CREATE INDEX IF NOT EXISTS module_resource_session_idx
  ON module_resource (tenant_id, batch_session_id);

-- ─── resource_progress ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resource_progress (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  party_id         uuid NOT NULL REFERENCES party(id),
  resource_id      uuid NOT NULL REFERENCES module_resource(id) ON DELETE CASCADE,
  position_seconds integer NOT NULL DEFAULT 0,  -- powers Resume / "9:12 left"
  completed_at     timestamptz,
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_progress_position_check CHECK (position_seconds >= 0)
);
-- Upsert key for PUT …/progress.
CREATE UNIQUE INDEX IF NOT EXISTS resource_progress_uniq
  ON resource_progress (party_id, resource_id);
CREATE INDEX IF NOT EXISTS resource_progress_party_idx
  ON resource_progress (tenant_id, party_id);
CREATE INDEX IF NOT EXISTS resource_progress_resource_idx
  ON resource_progress (tenant_id, resource_id);

-- ─── coursework ──────────────────────────────────────────────────────────
-- Due dates live here rather than in a separate per-batch window table:
-- a module belongs to exactly one batch, so definition and instance are
-- the same row. That is what "modules inside the batch" buys us.
CREATE TABLE IF NOT EXISTS coursework (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  module_id  uuid NOT NULL REFERENCES module(id) ON DELETE CASCADE,
  rank       integer NOT NULL DEFAULT 0,
  type       text NOT NULL,
  title      text NOT NULL,
  brief      text,
  max_score  numeric(6,2),
  pass_score numeric(6,2),
  -- 'auto' is reserved. v1 grades by trainer; auto-grading needs a question
  -- bank or an external autograder posting scores back, neither of which
  -- exists yet. Kept in the CHECK so adopting it later is not a migration.
  grading    text NOT NULL DEFAULT 'trainer',
  opens_at   timestamptz,
  due_at     timestamptz,
  closes_at  timestamptz,
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coursework_type_check    CHECK (type IN ('lab','assignment','assessment')),
  CONSTRAINT coursework_grading_check CHECK (grading IN ('trainer','auto')),
  CONSTRAINT coursework_window_check
    CHECK (closes_at IS NULL OR due_at IS NULL OR closes_at >= due_at)
);
CREATE INDEX IF NOT EXISTS coursework_module_idx ON coursework (tenant_id, module_id, rank);
CREATE INDEX IF NOT EXISTS coursework_due_idx    ON coursework (tenant_id, due_at);

-- ─── submission ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS submission (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  coursework_id uuid NOT NULL REFERENCES coursework(id) ON DELETE CASCADE,
  party_id      uuid NOT NULL REFERENCES party(id),
  attempt       integer NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'draft',
  submitted_at  timestamptz,
  content       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- answers / repo url / notes
  score         numeric(6,2),
  feedback      text,
  graded_by     uuid REFERENCES party(id) ON DELETE SET NULL,
  graded_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT submission_status_check
    CHECK (status IN ('draft','submitted','late','graded','returned')),
  CONSTRAINT submission_attempt_check CHECK (attempt > 0),
  CONSTRAINT submission_score_check   CHECK (score IS NULL OR score >= 0),
  -- A graded row must actually carry a score.
  CONSTRAINT submission_graded_check
    CHECK (status <> 'graded' OR score IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS submission_uniq
  ON submission (coursework_id, party_id, attempt);
CREATE INDEX IF NOT EXISTS submission_coursework_idx ON submission (tenant_id, coursework_id);
CREATE INDEX IF NOT EXISTS submission_party_idx      ON submission (tenant_id, party_id);
CREATE INDEX IF NOT EXISTS submission_status_idx     ON submission (tenant_id, status);

-- ─── certificate ─────────────────────────────────────────────────────────
-- v1 stores a reference to a file an admin uploads, not a render pipeline.
CREATE TABLE IF NOT EXISTS certificate (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  enrolment_id   uuid NOT NULL REFERENCES enrolment(id) ON DELETE CASCADE,
  party_id       uuid NOT NULL REFERENCES party(id),
  number         text,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  url            text,
  media_asset_id uuid REFERENCES media_asset(id) ON DELETE SET NULL,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS certificate_number_key
  ON certificate (tenant_id, number) WHERE number IS NOT NULL;
CREATE INDEX IF NOT EXISTS certificate_party_idx     ON certificate (tenant_id, party_id);
CREATE INDEX IF NOT EXISTS certificate_enrolment_idx ON certificate (tenant_id, enrolment_id);

-- ─── Grants ──────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON module            TO decrm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON module_resource   TO decrm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON resource_progress TO decrm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON coursework        TO decrm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON submission        TO decrm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON certificate       TO decrm_app;

-- ─── RLS ─────────────────────────────────────────────────────────────────
-- Tenant isolation only — exactly as every other table here. It does NOT
-- scope a learner to their own rows: RLS knows the tenant, not the caller.
-- Per-learner scoping is the routes' job (they filter on req.user.partyId
-- and join through batch_assignment). Getting that wrong is a data breach,
-- so every learner route has a test asserting 404 on another learner's row.
ALTER TABLE module ENABLE ROW LEVEL SECURITY;
ALTER TABLE module FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS module_tenant_isolation ON module;
CREATE POLICY module_tenant_isolation ON module
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

ALTER TABLE module_resource ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_resource FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS module_resource_tenant_isolation ON module_resource;
CREATE POLICY module_resource_tenant_isolation ON module_resource
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

ALTER TABLE resource_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_progress FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS resource_progress_tenant_isolation ON resource_progress;
CREATE POLICY resource_progress_tenant_isolation ON resource_progress
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

ALTER TABLE coursework ENABLE ROW LEVEL SECURITY;
ALTER TABLE coursework FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS coursework_tenant_isolation ON coursework;
CREATE POLICY coursework_tenant_isolation ON coursework
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

ALTER TABLE submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS submission_tenant_isolation ON submission;
CREATE POLICY submission_tenant_isolation ON submission
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

ALTER TABLE certificate ENABLE ROW LEVEL SECURITY;
ALTER TABLE certificate FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS certificate_tenant_isolation ON certificate;
CREATE POLICY certificate_tenant_isolation ON certificate
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);
