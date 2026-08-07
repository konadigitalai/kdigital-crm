-- Staffing — requisitions, candidates and applications.
--
-- The Academy's stated end-to-end is: a lead becomes a learner, a learner
-- becomes employable, and we place them. Everything up to "employable" now
-- exists. This is the last stretch, and it had no schema at all — placement
-- was two columns on learner_profile (placed_company, placed_at) recording
-- that it had happened, with nothing about how.
--
-- The gate into this module is deliberately NOT re-implemented here.
-- post-0088 put staffing_eligibility_status and staffing_consent_status on
-- learner_profile, because both are facts about the LEARNER — a learner who
-- withdraws consent must disappear from staffing regardless of how many
-- applications are open. `candidate` therefore carries only the recruiting
-- profile (experience, CTC, notice, résumé) and never restates eligibility.
-- CANDIDATE_ELIGIBLE below is the one place the gate is expressed.
--
-- Idempotent.

CREATE SEQUENCE IF NOT EXISTS seq_requisition START 1000;
CREATE SEQUENCE IF NOT EXISTS seq_candidate   START 1000;
CREATE SEQUENCE IF NOT EXISTS seq_application START 1000;
GRANT USAGE, SELECT ON SEQUENCE seq_requisition TO decrm_app;
GRANT USAGE, SELECT ON SEQUENCE seq_candidate   TO decrm_app;
GRANT USAGE, SELECT ON SEQUENCE seq_application TO decrm_app;

-- ─── 1. requisition — a hiring partner's open role ───────────────────────

CREATE TABLE IF NOT EXISTS "requisition" (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  number    text NOT NULL DEFAULT 'REQ-' || lpad(nextval('seq_requisition')::text, 5, '0'),

  account_party_id uuid NOT NULL REFERENCES account(party_id) ON DELETE CASCADE,

  job_title   text NOT NULL,
  designation text,
  department  text,
  job_description     text,
  key_responsibilities text,

  openings        integer NOT NULL DEFAULT 1,
  employment_type text,
  work_location   text,
  work_mode       text,

  -- Experience as a MONTH range, not "3-5 years". Ranges in years cannot
  -- express "18 months minimum", which is exactly where a fresh graduate of a
  -- six-month pathway sits.
  minimum_experience_months integer,
  maximum_experience_months integer,

  required_qualification text,
  required_skills  text[] NOT NULL DEFAULT '{}',
  preferred_skills text[] NOT NULL DEFAULT '{}',
  languages        text[] NOT NULL DEFAULT '{}',

  salary_min numeric(14,2),
  salary_max numeric(14,2),
  currency   text NOT NULL DEFAULT 'INR',
  budget_approved boolean NOT NULL DEFAULT false,

  hiring_manager_party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  recruiter_party_id      uuid REFERENCES party(id) ON DELETE SET NULL,

  approval_status    text NOT NULL DEFAULT 'not_required',
  approved_by_party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  approved_at        timestamptz,

  priority         integer NOT NULL DEFAULT 3,
  target_close_date date,
  status           text NOT NULL DEFAULT 'draft',

  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT requisition_openings_check CHECK (openings > 0),
  CONSTRAINT requisition_employment_type_check CHECK (
    employment_type IS NULL OR employment_type IN ('full_time','part_time','contract','intern')),
  CONSTRAINT requisition_work_mode_check CHECK (
    work_mode IS NULL OR work_mode IN ('onsite','remote','hybrid')),
  CONSTRAINT requisition_experience_range_check CHECK (
    minimum_experience_months IS NULL OR maximum_experience_months IS NULL
    OR maximum_experience_months >= minimum_experience_months),
  CONSTRAINT requisition_experience_sign_check CHECK (
    (minimum_experience_months IS NULL OR minimum_experience_months >= 0)
    AND (maximum_experience_months IS NULL OR maximum_experience_months >= 0)),
  CONSTRAINT requisition_salary_range_check CHECK (
    salary_min IS NULL OR salary_max IS NULL OR salary_max >= salary_min),
  CONSTRAINT requisition_approval_status_check CHECK (
    approval_status IN ('not_required','pending','approved','rejected')),
  CONSTRAINT requisition_priority_check CHECK (priority BETWEEN 1 AND 4),
  CONSTRAINT requisition_status_check CHECK (
    status IN ('draft','open','on_hold','filled','cancelled','closed')),
  -- An approved requisition records who approved it and when. Without this the
  -- approval trail is decorative.
  CONSTRAINT requisition_approved_evidence_check CHECK (
    approval_status <> 'approved' OR (approved_by_party_id IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "requisition_number_uniq" ON "requisition" ("tenant_id", "number");
CREATE INDEX IF NOT EXISTS "requisition_account_idx"   ON "requisition" ("tenant_id", "account_party_id");
CREATE INDEX IF NOT EXISTS "requisition_status_idx"    ON "requisition" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "requisition_recruiter_idx" ON "requisition" ("tenant_id", "recruiter_party_id");
CREATE INDEX IF NOT EXISTS "requisition_skills_gin"    ON "requisition" USING gin ("required_skills");

DROP TRIGGER IF EXISTS "requisition_updated_at" ON "requisition";
CREATE TRIGGER "requisition_updated_at" BEFORE UPDATE ON "requisition"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON "requisition" TO decrm_app;
ALTER TABLE "requisition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "requisition" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "requisition_tenant_isolation" ON "requisition";
CREATE POLICY "requisition_tenant_isolation" ON "requisition"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

-- ─── 2. candidate — a learner's recruiting profile ───────────────────────
--
-- Party satellite, same shape as worker and learner_profile. A candidate IS a
-- learner; there is no separate identity and no copied name or email.

CREATE TABLE IF NOT EXISTS "candidate" (
  party_id  uuid PRIMARY KEY REFERENCES party(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  number    text NOT NULL DEFAULT 'CAN-' || lpad(nextval('seq_candidate')::text, 5, '0'),

  total_experience_months integer,
  current_employer    text,
  current_designation text,
  current_ctc  numeric(14,2),
  expected_ctc numeric(14,2),
  currency     text NOT NULL DEFAULT 'INR',
  notice_period_days integer,

  skills text[] NOT NULL DEFAULT '{}',
  highest_qualification text,
  work_history_summary  text,
  certifications text[] NOT NULL DEFAULT '{}',

  resume_attachment_id uuid REFERENCES attachment(id) ON DELETE SET NULL,
  portfolio_url text,

  profile_status text NOT NULL DEFAULT 'draft',

  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT candidate_experience_check CHECK (
    total_experience_months IS NULL OR total_experience_months >= 0),
  CONSTRAINT candidate_notice_check CHECK (
    notice_period_days IS NULL OR notice_period_days >= 0),
  CONSTRAINT candidate_ctc_check CHECK (
    (current_ctc  IS NULL OR current_ctc  >= 0) AND
    (expected_ctc IS NULL OR expected_ctc >= 0)),
  CONSTRAINT candidate_profile_status_check CHECK (
    profile_status IN ('draft','ready','active','placed','withdrawn'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "candidate_number_uniq" ON "candidate" ("tenant_id", "number");
CREATE INDEX IF NOT EXISTS "candidate_status_idx" ON "candidate" ("tenant_id", "profile_status");
CREATE INDEX IF NOT EXISTS "candidate_skills_gin" ON "candidate" USING gin ("skills");

DROP TRIGGER IF EXISTS "candidate_updated_at" ON "candidate";
CREATE TRIGGER "candidate_updated_at" BEFORE UPDATE ON "candidate"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON "candidate" TO decrm_app;
ALTER TABLE "candidate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "candidate_tenant_isolation" ON "candidate";
CREATE POLICY "candidate_tenant_isolation" ON "candidate"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

-- ─── 3. application — candidate × requisition ────────────────────────────

CREATE TABLE IF NOT EXISTS "application" (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  number    text NOT NULL DEFAULT 'APP-' || lpad(nextval('seq_application')::text, 5, '0'),

  candidate_party_id uuid NOT NULL REFERENCES candidate(party_id) ON DELETE CASCADE,
  requisition_id     uuid NOT NULL REFERENCES requisition(id)     ON DELETE CASCADE,

  applied_at       timestamptz NOT NULL DEFAULT now(),
  stage            text NOT NULL DEFAULT 'applied',
  stage_updated_at timestamptz NOT NULL DEFAULT now(),

  -- Machine screening. The score is the model's; screening_factors is the
  -- evidence behind it. Both are kept because a rejection a candidate can
  -- contest needs to show its reasoning, not just its number.
  screening_score   integer,
  screening_factors jsonb NOT NULL DEFAULT '{}'::jsonb,

  assigned_recruiter_party_id uuid REFERENCES party(id) ON DELETE SET NULL,

  interview_status text,
  offer_status     text,
  rejection_reason text,

  -- Governance: an automated screen must be signed off by a human before it
  -- can reject someone. 'not_required' is for applications a human staged
  -- manually in the first place.
  human_review_status text NOT NULL DEFAULT 'not_required',

  status text NOT NULL DEFAULT 'open',

  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT application_stage_check CHECK (
    stage IN ('applied','screening','shortlisted','interviewing','offered','hired','rejected','withdrawn')),
  CONSTRAINT application_screening_score_check CHECK (
    screening_score IS NULL OR screening_score BETWEEN 0 AND 100),
  CONSTRAINT application_interview_status_check CHECK (
    interview_status IS NULL
    OR interview_status IN ('not_scheduled','scheduled','completed','no_show','cancelled')),
  CONSTRAINT application_offer_status_check CHECK (
    offer_status IS NULL
    OR offer_status IN ('none','extended','accepted','declined','withdrawn')),
  CONSTRAINT application_human_review_check CHECK (
    human_review_status IN ('not_required','pending','approved','rejected')),
  CONSTRAINT application_status_check CHECK (status IN ('open','closed')),
  -- A rejection says why. Empty rejections are how a pipeline stops being
  -- reviewable.
  CONSTRAINT application_rejection_reason_check CHECK (
    stage <> 'rejected' OR (rejection_reason IS NOT NULL AND length(btrim(rejection_reason)) > 0))
);

-- One application per candidate per requisition. Re-applying is a stage
-- change, not a second row.
CREATE UNIQUE INDEX IF NOT EXISTS "application_candidate_requisition_uniq"
  ON "application" ("candidate_party_id", "requisition_id");
CREATE UNIQUE INDEX IF NOT EXISTS "application_number_uniq" ON "application" ("tenant_id", "number");
CREATE INDEX IF NOT EXISTS "application_requisition_idx" ON "application" ("tenant_id", "requisition_id", "stage");
CREATE INDEX IF NOT EXISTS "application_candidate_idx"   ON "application" ("tenant_id", "candidate_party_id");
CREATE INDEX IF NOT EXISTS "application_recruiter_idx"   ON "application" ("tenant_id", "assigned_recruiter_party_id");

DROP TRIGGER IF EXISTS "application_updated_at" ON "application";
CREATE TRIGGER "application_updated_at" BEFORE UPDATE ON "application"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION application_stamp_stage_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    NEW.stage_updated_at = now();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "application_stage_stamp" ON "application";
CREATE TRIGGER "application_stage_stamp" BEFORE UPDATE ON "application"
  FOR EACH ROW EXECUTE FUNCTION application_stamp_stage_change();

GRANT SELECT, INSERT, UPDATE, DELETE ON "application" TO decrm_app;
ALTER TABLE "application" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "application" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "application_tenant_isolation" ON "application";
CREATE POLICY "application_tenant_isolation" ON "application"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

-- ─── 4. The staffing gate, expressed once ────────────────────────────────
--
-- Who may be put forward. Both conditions live on learner_profile, so a
-- learner who withdraws consent leaves this view immediately and every caller
-- that reads it stops offering them — without any of those callers having to
-- remember the rule.

CREATE OR REPLACE VIEW "candidate_eligible"
WITH (security_invoker = true) AS
SELECT
  c.party_id,
  c.tenant_id,
  c.number,
  c.profile_status,
  c.total_experience_months,
  c.skills,
  lp.staffing_eligibility_status,
  lp.staffing_consent_status,
  lp.progress_percent,
  lp.placement_status
FROM candidate c
JOIN learner_profile lp ON lp.party_id = c.party_id
WHERE lp.staffing_eligibility_status = 'qualified'
  AND lp.staffing_consent_status     = 'granted'
  AND c.profile_status IN ('ready','active');

GRANT SELECT ON "candidate_eligible" TO decrm_app;
