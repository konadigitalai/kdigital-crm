-- Fields the KDigital v1.2 workbook carries that the CRM had nowhere to put.
--
-- post-0087 landed the catalogue. This one closes the gaps on the records that
-- HANG off the catalogue — lead, enrolment, cohort, learner_profile — so an
-- import from the workbook stops dropping columns on the floor.
--
-- Two vocabulary notes, because this is where the workbook and the CRM
-- disagree and the disagreement is deliberate:
--
--   delivery mode. The registry says Online | Classroom | Hybrid and
--   program.delivery_modes stores those verbatim, because CAT-010 forbids
--   silently rewording an approved record. The CRM has said
--   online | offline | hybrid since post-0024 and lead.delivery_mode already
--   uses it. Rather than break one of the two, the operational columns added
--   here follow the CRM vocabulary and 'Classroom' maps to 'offline'. The
--   mapping lives in web/src/lib/deliveryMode.ts so it exists exactly once.
--
--   money. The workbook is in MINOR UNITS (integer paise: 8500000 = ₹85,000)
--   and this schema is numeric(12,2) rupees. Nothing here changes that — the
--   currency column added to lead and enrolment records WHICH currency an
--   amount is in, which was previously assumed to be INR everywhere. Any
--   importer divides by 100 on the way in.
--
-- Additive and idempotent. Every column is nullable or defaulted, so no
-- existing row becomes invalid.

-- ─── 1. lead: who the person is before they enrol ────────────────────────
--
-- The workbook's intake sheet asks three qualifying questions the CRM had no
-- home for. They drive segmentation ("final-year students in Hyderabad") and
-- fee conversations, so they belong on the lead, not in the description blob
-- where they were previously being typed by hand.

ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "working_status"  text;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "year_of_passout" integer;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "current_company" text;
-- lead.value is numeric with no unit. Every existing row is INR, hence the
-- default — but stating it means a future non-INR quote is representable
-- instead of silently wrong.
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "currency" text NOT NULL DEFAULT 'INR';
-- Which campaign produced this lead. lead.source is a free-text channel
-- ('Website', 'Referral'); this is the actual campaign row, so spend can be
-- attributed to revenue.
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "source_campaign_id" uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_working_status_check') THEN
    ALTER TABLE "lead" ADD CONSTRAINT "lead_working_status_check"
      CHECK ("working_status" IS NULL OR "working_status" IN ('student','working','not_working'));
  END IF;
  -- A four-digit year, loosely fenced. Deliberately wide: learners do enrol
  -- with a passout year a few years out.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_year_of_passout_check') THEN
    ALTER TABLE "lead" ADD CONSTRAINT "lead_year_of_passout_check"
      CHECK ("year_of_passout" IS NULL OR ("year_of_passout" BETWEEN 1950 AND 2100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_source_campaign_fk') THEN
    ALTER TABLE "lead" ADD CONSTRAINT "lead_source_campaign_fk"
      FOREIGN KEY ("source_campaign_id") REFERENCES "campaign"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "lead_source_campaign_idx"
  ON "lead" ("tenant_id", "source_campaign_id") WHERE "source_campaign_id" IS NOT NULL;

-- ─── 2. enrolment: the commercial engagement ─────────────────────────────
--
-- An enrolment had a party, a programme and a fee ledger, but no owner, no
-- delivery mode and no dates of its own — it inherited them from whichever
-- batch the learner happened to be assigned to. That breaks as soon as a
-- learner sits in several batches, which is the normal case for a nine-course
-- pathway.

ALTER TABLE "enrolment" ADD COLUMN IF NOT EXISTS "advisor_id" uuid;
ALTER TABLE "enrolment" ADD COLUMN IF NOT EXISTS "delivery_mode" text;
ALTER TABLE "enrolment" ADD COLUMN IF NOT EXISTS "timezone" text NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE "enrolment" ADD COLUMN IF NOT EXISTS "currency" text NOT NULL DEFAULT 'INR';
-- When the engagement starts and when it is contractually expected to finish.
-- Distinct from any single batch's dates: the programme spans all of them.
ALTER TABLE "enrolment" ADD COLUMN IF NOT EXISTS "start_date" date;
ALTER TABLE "enrolment" ADD COLUMN IF NOT EXISTS "expected_completion_date" date;
-- Admission gating. The workbook tracks these as three separate signals
-- because they are cleared by three different people at three different
-- times; collapsing them into one status loses who is blocked on what.
ALTER TABLE "enrolment" ADD COLUMN IF NOT EXISTS "admission_checklist_status" text NOT NULL DEFAULT 'pending';
ALTER TABLE "enrolment" ADD COLUMN IF NOT EXISTS "identity_proof_status"      text NOT NULL DEFAULT 'not_submitted';
-- Does this learner want to be put forward for staffing on completion? Drives
-- the candidate pipeline (post-0091) and is asked at enrolment, not at the end.
ALTER TABLE "enrolment" ADD COLUMN IF NOT EXISTS "staffing_interest" boolean NOT NULL DEFAULT false;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enrolment_advisor_fk') THEN
    ALTER TABLE "enrolment" ADD CONSTRAINT "enrolment_advisor_fk"
      FOREIGN KEY ("advisor_id") REFERENCES "party"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enrolment_delivery_mode_check') THEN
    ALTER TABLE "enrolment" ADD CONSTRAINT "enrolment_delivery_mode_check"
      CHECK ("delivery_mode" IS NULL OR "delivery_mode" IN ('online','offline','hybrid'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enrolment_admission_checklist_check') THEN
    ALTER TABLE "enrolment" ADD CONSTRAINT "enrolment_admission_checklist_check"
      CHECK ("admission_checklist_status" IN ('pending','partial','complete'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enrolment_identity_proof_check') THEN
    ALTER TABLE "enrolment" ADD CONSTRAINT "enrolment_identity_proof_check"
      CHECK ("identity_proof_status" IN ('not_submitted','submitted','verified','rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enrolment_date_range_check') THEN
    ALTER TABLE "enrolment" ADD CONSTRAINT "enrolment_date_range_check"
      CHECK ("expected_completion_date" IS NULL OR "start_date" IS NULL
             OR "expected_completion_date" >= "start_date");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "enrolment_advisor_idx"
  ON "enrolment" ("tenant_id", "advisor_id") WHERE "advisor_id" IS NOT NULL;

-- Backfill the advisor from the lead the enrolment was converted out of, so
-- existing rows are not all unowned. Only fills where it can be derived.
UPDATE enrolment e
   SET advisor_id = l.advisor_id
  FROM lead l
 WHERE e.deal_id = l.work_item_id
   AND e.advisor_id IS NULL
   AND l.advisor_id IS NOT NULL;

-- ─── 3. cohort: where and when a batch actually runs ─────────────────────
--
-- A batch already had a schedule and a join_url. It did not record whether it
-- is an online or a classroom batch, nor where the classroom is, so the
-- Batches board could not answer "which Hyderabad classroom batches run on
-- Saturday". join_url being present was the only proxy, and hybrid batches
-- have one too.

ALTER TABLE "cohort" ADD COLUMN IF NOT EXISTS "delivery_mode" text;
ALTER TABLE "cohort" ADD COLUMN IF NOT EXISTS "timezone" text NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE "cohort" ADD COLUMN IF NOT EXISTS "location" text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cohort_delivery_mode_check') THEN
    ALTER TABLE "cohort" ADD CONSTRAINT "cohort_delivery_mode_check"
      CHECK ("delivery_mode" IS NULL OR "delivery_mode" IN ('online','offline','hybrid'));
  END IF;
END $$;

-- ─── 4. learner_profile: progress, risk and staffing eligibility ─────────
--
-- The profile knew where a learner ended up (placed / not placed) but nothing
-- about how they are doing on the way there. Risk is what an advisor acts on
-- weeks before a drop-out; without it the first signal is the drop-out.
--
-- progress_percent is a cached roll-up, not a source of truth — the truth is
-- resource_progress. Cached because the learners list renders it for every
-- row and recomputing per row is a join per learner per page.

ALTER TABLE "learner_profile" ADD COLUMN IF NOT EXISTS "progress_percent" integer;
ALTER TABLE "learner_profile" ADD COLUMN IF NOT EXISTS "risk_level"  text;
ALTER TABLE "learner_profile" ADD COLUMN IF NOT EXISTS "risk_reason" text;
-- Staffing gate. A learner reaches the candidate pipeline only when they are
-- BOTH qualified and have consented — two independent facts, so two columns.
ALTER TABLE "learner_profile" ADD COLUMN IF NOT EXISTS "staffing_eligibility_status" text NOT NULL DEFAULT 'not_assessed';
ALTER TABLE "learner_profile" ADD COLUMN IF NOT EXISTS "staffing_consent_status"     text NOT NULL DEFAULT 'not_asked';
ALTER TABLE "learner_profile" ADD COLUMN IF NOT EXISTS "staffing_consent_at" timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'learner_profile_progress_check') THEN
    ALTER TABLE "learner_profile" ADD CONSTRAINT "learner_profile_progress_check"
      CHECK ("progress_percent" IS NULL OR "progress_percent" BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'learner_profile_risk_level_check') THEN
    ALTER TABLE "learner_profile" ADD CONSTRAINT "learner_profile_risk_level_check"
      CHECK ("risk_level" IS NULL OR "risk_level" IN ('low','medium','high'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'learner_profile_staffing_eligibility_check') THEN
    ALTER TABLE "learner_profile" ADD CONSTRAINT "learner_profile_staffing_eligibility_check"
      CHECK ("staffing_eligibility_status" IN ('not_assessed','qualified','not_qualified'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'learner_profile_staffing_consent_check') THEN
    ALTER TABLE "learner_profile" ADD CONSTRAINT "learner_profile_staffing_consent_check"
      CHECK ("staffing_consent_status" IN ('not_asked','granted','withheld','withdrawn'));
  END IF;
END $$;

-- The staffing pipeline's entry query: who is qualified AND consenting.
CREATE INDEX IF NOT EXISTS "learner_profile_staffing_idx"
  ON "learner_profile" ("tenant_id", "staffing_eligibility_status", "staffing_consent_status");
CREATE INDEX IF NOT EXISTS "learner_profile_risk_idx"
  ON "learner_profile" ("tenant_id", "risk_level") WHERE "risk_level" IS NOT NULL;
