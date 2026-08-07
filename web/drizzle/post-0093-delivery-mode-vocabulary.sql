-- Correct post-0088: enrolment and cohort delivery_mode use 'classroom',
-- not 'offline'.
--
-- post-0088 added delivery_mode to enrolment and cohort with the vocabulary
-- ('online','offline','hybrid'), taken from the comment at the top of
-- post-0024. That comment was stale: post-0060 had already renamed the value
-- to 'classroom' across `lead`, explicitly because "'Offline' was a
-- misleading label". So 0088 reintroduced a spelling this schema had
-- deliberately retired, and left the CRM holding two vocabularies for one
-- concept — lead saying 'classroom' and its own enrolment saying 'offline'.
--
-- Fixing it here rather than editing 0088 in place, because 0088 has already
-- been applied and an applied migration is a historical record.
--
-- Safe: both columns were introduced by 0088 and nothing has written to them
-- yet, so this is a constraint swap with no data to migrate. The UPDATE is
-- kept anyway so the migration is correct on any database where something
-- did.
--
-- Net effect: one vocabulary everywhere — online | classroom | hybrid — which
-- is also the registry's (Online | Classroom | Hybrid) in lower case, so the
-- CRM and the catalogue finally agree and the translation layer collapses to
-- a case change.
--
-- Idempotent.

-- ─── enrolment ───────────────────────────────────────────────────────────

ALTER TABLE "enrolment" DROP CONSTRAINT IF EXISTS "enrolment_delivery_mode_check";

UPDATE "enrolment" SET "delivery_mode" = 'classroom' WHERE "delivery_mode" = 'offline';

ALTER TABLE "enrolment" ADD CONSTRAINT "enrolment_delivery_mode_check"
  CHECK ("delivery_mode" IS NULL OR "delivery_mode" IN ('online','classroom','hybrid'));

-- ─── cohort ──────────────────────────────────────────────────────────────

ALTER TABLE "cohort" DROP CONSTRAINT IF EXISTS "cohort_delivery_mode_check";

UPDATE "cohort" SET "delivery_mode" = 'classroom' WHERE "delivery_mode" = 'offline';

ALTER TABLE "cohort" ADD CONSTRAINT "cohort_delivery_mode_check"
  CHECK ("delivery_mode" IS NULL OR "delivery_mode" IN ('online','classroom','hybrid'));
