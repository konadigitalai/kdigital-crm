-- Learner profile — a 1:1 satellite of `party`, keyed by party_id.
--
-- Why a satellite (party_id PK) and NOT a standalone learner table:
--   - Identity (name, email, phone, fee ledger) stays on `party`. This table
--     never duplicates any of it — it only adds durable learner-specific
--     attributes that don't belong on party and aren't a role transition
--     (party_role) or an engagement (enrolment / course_assignment).
--   - PK = party_id ⇒ exactly one profile per person. When a learner later
--     converts to intern/alumnus (party_role change), this row and all their
--     history stay attached to the same party.id — no data migration.
--
-- Anything role-shaped or variable goes in `attributes` jsonb; promote a key
-- to a real column only when you need to filter/sort/constrain on it.
--
-- Idempotent — safe to replay.

CREATE TABLE IF NOT EXISTS learner_profile (
  party_id          uuid PRIMARY KEY REFERENCES party(id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL REFERENCES tenant(id),

  -- Durable learner attributes (all optional — extend freely).
  lms_user_id       text,                                        -- external LMS account id
  mentor_party_id   uuid REFERENCES party(id) ON DELETE SET NULL,-- assigned mentor (also a party)
  skill_level       text,                                        -- beginner | intermediate | advanced
  placement_status  text,                                        -- not_started | in_progress | placed | deferred
  placed_company    text,
  placed_at         date,

  -- Lifecycle of the learner engagement itself (distinct from party_role).
  status            text NOT NULL DEFAULT 'active',              -- active | paused | completed | dropped

  -- The flexible 20% — role/programme-specific fields before they earn a column.
  attributes        jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT learner_profile_skill_level_check
    CHECK (skill_level IS NULL OR skill_level IN ('beginner','intermediate','advanced')),
  CONSTRAINT learner_profile_placement_status_check
    CHECK (placement_status IS NULL OR placement_status IN ('not_started','in_progress','placed','deferred')),
  CONSTRAINT learner_profile_status_check
    CHECK (status IN ('active','paused','completed','dropped'))
);

-- Tenant-scoped listing.
CREATE INDEX IF NOT EXISTS learner_profile_tenant_idx
  ON learner_profile (tenant_id);

-- "learners mentored by X".
CREATE INDEX IF NOT EXISTS learner_profile_mentor_idx
  ON learner_profile (tenant_id, mentor_party_id);

-- Placement dashboards / filters.
CREATE INDEX IF NOT EXISTS learner_profile_placement_idx
  ON learner_profile (tenant_id, placement_status);

-- ─── Grants ──────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON learner_profile TO decrm_app;

-- ─── RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE learner_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE learner_profile FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learner_profile_tenant_isolation ON learner_profile;
CREATE POLICY learner_profile_tenant_isolation ON learner_profile
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);
