-- Learner fee ledger — lives on the party row (single ledger per learner,
-- independent of how many program enrolments they have).
--
-- Fields:
--   fee_quoted          — set on convert from lead.value ("Price quoted")
--   fee_paid            — cumulative amount received
--   due_date            — when the outstanding fee is due
--   payment_status      — pending | paid | refund | on_hold
--   payment_proof_url   — receipt / bank transfer proof link
--
-- fee_due is NOT stored — the UI computes it as (fee_quoted − fee_paid) so
-- the two can never drift apart.
--
-- Idempotent.

ALTER TABLE "party" ADD COLUMN IF NOT EXISTS "fee_quoted"        numeric(12,2);
ALTER TABLE "party" ADD COLUMN IF NOT EXISTS "fee_paid"          numeric(12,2);
ALTER TABLE "party" ADD COLUMN IF NOT EXISTS "due_date"          date;
ALTER TABLE "party" ADD COLUMN IF NOT EXISTS "payment_status"    text;
ALTER TABLE "party" ADD COLUMN IF NOT EXISTS "payment_proof_url" text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_payment_status_check') THEN
    ALTER TABLE "party" ADD CONSTRAINT "party_payment_status_check"
      CHECK (payment_status IS NULL OR payment_status IN ('pending','paid','refund','on_hold'));
  END IF;
END $$;
