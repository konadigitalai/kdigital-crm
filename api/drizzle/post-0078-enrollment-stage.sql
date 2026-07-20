-- Enrollment stage between lead and learner.
--
--   lead --(Enroll)--> enrolled --(verify payment, Convert to Learner)--> learner
--
-- The `enrolment` row IS the enrollment record (party + program + fee ledger +
-- batches). This migration gives it a human number and payment-verification
-- fields, and adds the 'enrolled' party_role for the in-between stage.
--
-- Additive + idempotent. No data is dropped. Existing enrolments are given a
-- number by backfill; existing learners keep their 'learner' role untouched.

-- ── 1. Roles — add 'enrolled' (pre-learner) and 'intern' (onward pipeline) ─
ALTER TABLE party_role DROP CONSTRAINT IF EXISTS party_role_role_check;
ALTER TABLE party_role ADD CONSTRAINT party_role_role_check
  CHECK (role IN ('lead','contact','enrolled','learner','intern','advisor','alumnus'));

-- ── 2. Enrollment human number (ENR-#####) + per-type sequence ────────────
CREATE SEQUENCE IF NOT EXISTS seq_enrolment START 200;
GRANT USAGE, SELECT ON SEQUENCE seq_enrolment TO decrm_app;

ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS number text;

-- Backfill a number for every existing enrolment that lacks one. nextval is
-- called once per row, so numbers are unique and monotonic.
UPDATE enrolment
   SET number = 'ENR-' || lpad(nextval('seq_enrolment')::text, 5, '0')
 WHERE number IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS enrolment_tenant_number_key
  ON enrolment (tenant_id, number);

-- ── 3. Payment verification — the gate for enrolled → learner ─────────────
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS payment_verified_at timestamptz;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS payment_verified_by uuid
  REFERENCES party(id) ON DELETE SET NULL;

-- ── 4. Status — add 'pending' (pre-verification) and 'on_hold' ────────────
ALTER TABLE enrolment DROP CONSTRAINT IF EXISTS enrolment_status_check;
ALTER TABLE enrolment ADD CONSTRAINT enrolment_status_check
  CHECK (status IN ('pending','active','on_hold','completed','dropped','deferred'));
