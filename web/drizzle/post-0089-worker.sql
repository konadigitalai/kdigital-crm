-- Workers — the workforce directory the CRM never had.
--
-- Trainers, advisors and recruiters already exist in this database, but only
-- as `app_user` rows (a login) plus a `party` (a name). There was nowhere to
-- record that someone is a full-time employee in the Delivery department who
-- joined in March, reports to Leena, works the evening shift and is available
-- for deployment. The Batches board picks trainers by "any party with an
-- app_user", which is why a finance admin shows up in the trainer dropdown.
--
-- Shape follows learner_profile exactly: a satellite of `party` keyed by
-- party_id, NOT a new identity table. A worker is a person the business
-- already knows. Name, email, phone and city stay on party + contact_point;
-- nothing about a human being is stored twice.
--
-- Restricted HR data (salary, personal documents, performance) is deliberately
-- ABSENT. The source workbook minimises it too. What is here is what the CRM
-- schedules and staffs against — nothing that would make this table a
-- payroll system with no access control in front of it.
--
-- Idempotent.

CREATE SEQUENCE IF NOT EXISTS seq_worker START 1000;
GRANT USAGE, SELECT ON SEQUENCE seq_worker TO decrm_app;

CREATE TABLE IF NOT EXISTS "worker" (
  -- PK = party_id. One worker record per person, and the FK guarantees the
  -- person exists before they can be employed.
  party_id      uuid PRIMARY KEY REFERENCES party(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),

  -- WRK-01042. Defaulted in SQL so every insert path gets one.
  employee_number text NOT NULL DEFAULT 'WRK-' || lpad(nextval('seq_worker')::text, 5, '0'),

  -- What kind of engagement this is. 'trainer' is separate from
  -- trainer_capable below on purpose: a delivery manager may be
  -- trainer_capable without being employed as a trainer.
  worker_type     text NOT NULL DEFAULT 'employee',
  designation     text,
  department      text,
  employment_type text,

  date_of_joining date,
  date_of_exit    date,

  -- Reporting line. party_id, not worker_id, so it can point at someone whose
  -- worker row has since been removed without orphaning.
  reporting_to_party_id uuid REFERENCES party(id) ON DELETE SET NULL,

  status   text NOT NULL DEFAULT 'active',
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',

  working_hours_per_week numeric(5,2),
  -- Free text ('Morning', 'IST evening', '2pm–11pm'). Shifts vary per team and
  -- an enum here would be wrong within a month.
  shift text,

  -- Searchable capability list. Array rather than a join table because it is
  -- read whole, written whole, and never joined against a skill master.
  skills text[] NOT NULL DEFAULT '{}',

  -- The two flags the scheduler actually filters on. Kept as columns, not
  -- derived from skills, because "can teach" and "can be deployed to a client"
  -- are decisions someone makes, not facts about a skill list.
  trainer_capable      boolean NOT NULL DEFAULT false,
  deployment_available boolean NOT NULL DEFAULT false,

  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT worker_type_check CHECK (
    worker_type IN ('employee','contractor','trainer','intern','vendor')),
  CONSTRAINT worker_employment_type_check CHECK (
    employment_type IS NULL OR employment_type IN ('full_time','part_time','contract','intern')),
  CONSTRAINT worker_status_check CHECK (
    status IN ('active','on_leave','notice_period','exited')),
  CONSTRAINT worker_hours_check CHECK (
    working_hours_per_week IS NULL OR (working_hours_per_week > 0 AND working_hours_per_week <= 168)),
  CONSTRAINT worker_exit_after_join_check CHECK (
    date_of_exit IS NULL OR date_of_joining IS NULL OR date_of_exit >= date_of_joining),
  -- Nobody reports to themselves.
  CONSTRAINT worker_no_self_report_check CHECK (
    reporting_to_party_id IS NULL OR reporting_to_party_id <> party_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS "worker_employee_number_uniq"
  ON "worker" ("tenant_id", "employee_number");
CREATE INDEX IF NOT EXISTS "worker_tenant_status_idx"
  ON "worker" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "worker_department_idx"
  ON "worker" ("tenant_id", "department") WHERE "department" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "worker_reporting_idx"
  ON "worker" ("tenant_id", "reporting_to_party_id");
-- The trainer picker's query: active + trainer_capable.
CREATE INDEX IF NOT EXISTS "worker_trainer_idx"
  ON "worker" ("tenant_id", "trainer_capable", "status") WHERE "trainer_capable" = true;
-- Skills search from the staffing side.
CREATE INDEX IF NOT EXISTS "worker_skills_gin"
  ON "worker" USING gin ("skills");

DROP TRIGGER IF EXISTS "worker_updated_at" ON "worker";
CREATE TRIGGER "worker_updated_at" BEFORE UPDATE ON "worker"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON "worker" TO decrm_app;

ALTER TABLE "worker" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "worker" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "worker_tenant_isolation" ON "worker";
CREATE POLICY "worker_tenant_isolation" ON "worker"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

-- ─── Backfill: every existing internal app_user becomes a worker ─────────
--
-- These people are already staff; without this the directory opens empty and
-- somebody re-types thirty names. worker_type comes from the app_user role so
-- the trainer flag is right on day one rather than defaulted to false for
-- everybody.
INSERT INTO worker (party_id, tenant_id, worker_type, designation, status, trainer_capable)
SELECT
  u.party_id,
  u.tenant_id,
  CASE WHEN u.role = 'trainer' THEN 'trainer' ELSE 'employee' END,
  initcap(replace(u.role, '_', ' ')),
  CASE WHEN u.active THEN 'active' ELSE 'exited' END,
  (u.role = 'trainer')
FROM app_user u
JOIN party p ON p.id = u.party_id
WHERE u.party_id IS NOT NULL
  -- Learners sign in too. They are not staff.
  AND u.role <> 'learner'
  AND p.is_system IS NOT TRUE
ON CONFLICT (party_id) DO NOTHING;

-- Anyone already assigned as a trainer or co-trainer on a batch is
-- trainer_capable by demonstration, whatever their app_user role says.
UPDATE worker w SET trainer_capable = true
WHERE trainer_capable = false
  AND EXISTS (
    SELECT 1 FROM cohort c
     WHERE c.trainer_id = w.party_id OR c.co_trainer_id = w.party_id
  );
