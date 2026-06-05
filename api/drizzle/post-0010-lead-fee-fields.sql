-- Phase E: lead carries provisional payment data; enrolment carries it forward post-convert.
-- Idempotent.

ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "description"        text;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "fee_paid"            numeric(12,2);
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "fee_due"             numeric(12,2);
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "due_date"            date;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "registered_date"     date;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "payment_proof_url"   text;

-- Backfill registered_date from work_item.created_at where missing
UPDATE "lead" l
SET registered_date = wi.created_at::date
FROM "work_item" wi
WHERE l.work_item_id = wi.id AND l.registered_date IS NULL;

ALTER TABLE "enrolment" ADD COLUMN IF NOT EXISTS "fee_due"             numeric(12,2);
ALTER TABLE "enrolment" ADD COLUMN IF NOT EXISTS "due_date"             date;
ALTER TABLE "enrolment" ADD COLUMN IF NOT EXISTS "registered_date"     date;
ALTER TABLE "enrolment" ADD COLUMN IF NOT EXISTS "payment_proof_url"   text;
