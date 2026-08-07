-- The KDigital v1.2 Final Programme and Course Registry, given a home.
--
-- Until now `program` was a name + a price and `course` was a name, which was
-- enough while the catalogue lived in one advisor's head. The approved
-- registry says something stronger: an ID like K-P003-FSAE or K-C008-PYTH is
-- PERMANENT (CAT-001), it is what credit is resolved by (CAT-002), and the
-- display name may be refined afterwards without the ID moving (CAT-004).
-- None of that survives if the only stable thing we store is a uuid we
-- minted ourselves and a name someone can rename.
--
-- So: `registry_id` becomes the external key everything else quotes, and the
-- descriptive fields the registry carries (family, credential, alias,
-- catalogue version, effective dates) stop being lost on import.
--
-- The structural change is program_course. The registry has a composite
-- pathway — Forward Deployed AI Engineer (K-P008-FDE) — whose components are
-- seven OTHER PROGRAMMES plus five of its own courses (CAT-007). A junction
-- that can only hold courses cannot say that without duplicating 45 course
-- rows, which is exactly what CAT-007 forbids. program_course therefore gains
-- a component_type and a child_program_id, and course_id becomes nullable.
--
-- Naming: `code` (PRG-11, from post-0086) stays as the short thing a learner
-- quotes on a call. `short_code` is the registry mnemonic (FSAE) and is a
-- different identifier with a different owner — the registry, not us. Same
-- for `enabled` (our operational on/off) vs `catalogue_status` (the
-- registry's publication state). Neither pair is a rename of the other.
--
-- Idempotent.

-- ─── 1. program: registry columns ────────────────────────────────────────

ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "registry_id"        text;
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "short_code"         text;
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "catalogue_sequence" integer;
-- Official long form ("DevOps & AI Operations: MLOps, LLMOps and AgentOps")
-- kept apart from the display name, because the registry ships both and
-- CAT-010 forbids silently collapsing one into the other.
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "full_name"          text;
-- Normalised spelling for search only ("DevOps and AI Operations"). Never
-- rendered as the record's name.
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "search_alias"       text;
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "programme_type"     text;
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "family"             text;
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "credential_type"    text;
-- Which modes this pathway may be sold in. Array rather than three booleans
-- so the enrolment's delivery_mode can be validated with a simple = ANY().
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "delivery_modes"     text[];
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "catalogue_version"  text;
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "catalogue_status"   text NOT NULL DEFAULT 'Published';
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "effective_from"     date;
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "effective_to"       date;
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "source_registry"    text;
-- program had no timestamps at all, which is why post-0086 had to order by
-- name to hand out codes deterministically.
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "created_at"         timestamptz NOT NULL DEFAULT now();
ALTER TABLE "program" ADD COLUMN IF NOT EXISTS "updated_at"         timestamptz NOT NULL DEFAULT now();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_catalogue_status_check') THEN
    ALTER TABLE "program" ADD CONSTRAINT "program_catalogue_status_check"
      CHECK ("catalogue_status" IN ('Draft','Published','Retired'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_effective_range_check') THEN
    ALTER TABLE "program" ADD CONSTRAINT "program_effective_range_check"
      CHECK ("effective_to" IS NULL OR "effective_from" IS NULL OR "effective_to" >= "effective_from");
  END IF;
END $$;

-- Partial so it can be added while pre-registry programmes still have NULL.
CREATE UNIQUE INDEX IF NOT EXISTS "program_registry_id_uniq"
  ON "program" ("tenant_id", "registry_id") WHERE "registry_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "program_short_code_uniq"
  ON "program" ("tenant_id", "short_code")  WHERE "short_code"  IS NOT NULL;

DROP TRIGGER IF EXISTS "program_updated_at" ON "program";
CREATE TRIGGER "program_updated_at" BEFORE UPDATE ON "program"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 2. course: registry columns ─────────────────────────────────────────

ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "registry_id"        text;
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "short_code"         text;
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "catalogue_sequence" integer;
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "search_alias"       text;
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "family"             text;
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "credential_type"    text;
-- CAT-015: the stable ID and the curriculum version are separate things. The
-- pattern ("K-C008-PYTH-VYYYY.N") is what a cohort's concrete version
-- ("K-C008-PYTH-V2026.1") is minted from.
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "curriculum_version_pattern" text;
-- CAT-002/003: may this course's completion be credited into another
-- pathway, and may it be sold on its own?
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "reusable_across_programmes" boolean NOT NULL DEFAULT true;
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "independently_deliverable"  boolean NOT NULL DEFAULT true;
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "catalogue_version"  text;
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "catalogue_status"   text NOT NULL DEFAULT 'Published';
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "effective_from"     date;
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "effective_to"       date;
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "source_registry"    text;
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "created_at"         timestamptz NOT NULL DEFAULT now();
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "updated_at"         timestamptz NOT NULL DEFAULT now();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'course_catalogue_status_check') THEN
    ALTER TABLE "course" ADD CONSTRAINT "course_catalogue_status_check"
      CHECK ("catalogue_status" IN ('Draft','Published','Retired'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'course_effective_range_check') THEN
    ALTER TABLE "course" ADD CONSTRAINT "course_effective_range_check"
      CHECK ("effective_to" IS NULL OR "effective_from" IS NULL OR "effective_to" >= "effective_from");
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "course_registry_id_uniq"
  ON "course" ("tenant_id", "registry_id") WHERE "registry_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "course_short_code_uniq"
  ON "course" ("tenant_id", "short_code")  WHERE "short_code"  IS NOT NULL;

DROP TRIGGER IF EXISTS "course_updated_at" ON "course";
CREATE TRIGGER "course_updated_at" BEFORE UPDATE ON "course"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 3. program_course becomes a programme-component table ───────────────
--
-- A component is EITHER a course or a referenced programme. Existing rows are
-- all courses, so the default backfills them correctly and course_id can be
-- relaxed to NULL in the same step.

ALTER TABLE "program_course" ADD COLUMN IF NOT EXISTS "component_type" text NOT NULL DEFAULT 'course';
ALTER TABLE "program_course" ADD COLUMN IF NOT EXISTS "child_program_id" uuid;
-- 'Core Course' | 'Foundation Course' | 'Product Specialisation' |
-- 'Referenced Pathway' | 'FDE-Specific Course' — free text on purpose: the
-- registry owns this vocabulary and adds to it between catalogue versions.
ALTER TABLE "program_course" ADD COLUMN IF NOT EXISTS "component_role" text;
-- CAT-008: how ServiceNow keeps product areas grouped behind the core
-- platform pathway instead of forking duplicate courses.
ALTER TABLE "program_course" ADD COLUMN IF NOT EXISTS "specialisation_group" text;
ALTER TABLE "program_course" ADD COLUMN IF NOT EXISTS "required" boolean NOT NULL DEFAULT true;
ALTER TABLE "program_course" ADD COLUMN IF NOT EXISTS "credit_reuse_allowed" boolean NOT NULL DEFAULT true;
ALTER TABLE "program_course" ADD COLUMN IF NOT EXISTS "catalogue_status" text NOT NULL DEFAULT 'Active';
ALTER TABLE "program_course" ADD COLUMN IF NOT EXISTS "effective_from" date;
ALTER TABLE "program_course" ADD COLUMN IF NOT EXISTS "effective_to"   date;
ALTER TABLE "program_course" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();

ALTER TABLE "program_course" ALTER COLUMN "course_id" DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_course_child_program_id_fk') THEN
    ALTER TABLE "program_course" ADD CONSTRAINT "program_course_child_program_id_fk"
      FOREIGN KEY ("child_program_id") REFERENCES "program"("id") ON DELETE CASCADE;
  END IF;

  -- Exactly one target, and it must agree with component_type. Without this a
  -- row could claim to be a programme reference while carrying a course_id.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_course_component_target_check') THEN
    ALTER TABLE "program_course" ADD CONSTRAINT "program_course_component_target_check"
      CHECK (
        ("component_type" = 'course'    AND "course_id" IS NOT NULL AND "child_program_id" IS NULL)
        OR
        ("component_type" = 'programme' AND "child_program_id" IS NOT NULL AND "course_id" IS NULL)
      );
  END IF;

  -- One level of self-reference is all the registry needs; a programme
  -- referencing itself is a cycle by definition, so refuse it outright.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_course_no_self_reference_check') THEN
    ALTER TABLE "program_course" ADD CONSTRAINT "program_course_no_self_reference_check"
      CHECK ("child_program_id" IS NULL OR "child_program_id" <> "program_id");
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_course_catalogue_status_check') THEN
    ALTER TABLE "program_course" ADD CONSTRAINT "program_course_catalogue_status_check"
      CHECK ("catalogue_status" IN ('Active','Retired'));
  END IF;
END $$;

-- The pre-existing program_course_uniq is on (program_id, course_id) and
-- Postgres treats NULLs as distinct, so it no longer guards the programme
-- rows. This is its counterpart.
CREATE UNIQUE INDEX IF NOT EXISTS "program_course_child_program_uniq"
  ON "program_course" ("program_id", "child_program_id") WHERE "child_program_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "program_course_child_program_idx"
  ON "program_course" ("tenant_id", "child_program_id");

DROP TRIGGER IF EXISTS "program_course_updated_at" ON "program_course";
CREATE TRIGGER "program_course_updated_at" BEFORE UPDATE ON "program_course"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 4. cohort: the concrete curriculum version it is teaching ───────────
--
-- CAT-015 again: the batch is where a stable course ID meets a dated
-- syllabus. Two batches of K-C008-PYTH running a term apart may legitimately
-- be on V2026.1 and V2026.2, and a certificate has to name which.
ALTER TABLE "cohort" ADD COLUMN IF NOT EXISTS "curriculum_version" text;

-- ─── 5. Effective-dated catalogue view ──────────────────────────────────
--
-- What is sellable today, flattened one level so a composite pathway lists
-- the courses it inherits from the programmes it references. Written as a
-- view so callers cannot forget the effective-date predicate.
--
-- security_invoker so the view is subject to the CALLER's RLS. Without it the
-- view runs as its owner (decrm_admin, who is not RLS-forced) and would hand
-- decrm_app every tenant's catalogue.

CREATE OR REPLACE VIEW "catalogue_effective_course"
WITH (security_invoker = true) AS
WITH direct AS (
  SELECT
    pc.tenant_id,
    pc.program_id                     AS program_id,
    pc.program_id                     AS via_program_id,
    pc.course_id,
    pc.rank,
    pc.component_role,
    pc.specialisation_group,
    pc.required,
    pc.credit_reuse_allowed,
    false                             AS inherited
  FROM program_course pc
  WHERE pc.component_type = 'course'
    AND pc.catalogue_status = 'Active'
    AND (pc.effective_from IS NULL OR pc.effective_from <= CURRENT_DATE)
    AND (pc.effective_to   IS NULL OR pc.effective_to   >= CURRENT_DATE)
),
referenced AS (
  SELECT
    parent.tenant_id,
    parent.program_id                 AS program_id,
    child.program_id                  AS via_program_id,
    child.course_id,
    parent.rank * 1000 + child.rank   AS rank,
    child.component_role,
    child.specialisation_group,
    child.required,
    child.credit_reuse_allowed,
    true                              AS inherited
  FROM program_course parent
  JOIN direct child ON child.program_id = parent.child_program_id
  WHERE parent.component_type = 'programme'
    AND parent.catalogue_status = 'Active'
    AND (parent.effective_from IS NULL OR parent.effective_from <= CURRENT_DATE)
    AND (parent.effective_to   IS NULL OR parent.effective_to   >= CURRENT_DATE)
)
SELECT * FROM direct
UNION ALL
SELECT * FROM referenced;

GRANT SELECT ON "catalogue_effective_course" TO decrm_app;
