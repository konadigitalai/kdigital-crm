-- Multiple payment proofs per learner. `payment_proof_url` (singular, added
-- in post-0055) can only hold one image; this migration adds `payment_proofs`
-- (text[]) so advisors can attach a receipt for each part-payment.
--
-- The old singular column stays for one release: old rows read from it as a
-- fallback, and new writes go into both while any historical callers exist.
-- Order preserved in the array (advisor decides).
--
-- Idempotent.

ALTER TABLE "party" ADD COLUMN IF NOT EXISTS "payment_proofs" text[] NOT NULL DEFAULT '{}';

-- Backfill: pull the existing single URL into the array on the first run.
-- Guarded by array-length so re-runs don't duplicate the value.
UPDATE "party"
SET    "payment_proofs" = ARRAY["payment_proof_url"]
WHERE  "payment_proof_url" IS NOT NULL
  AND  COALESCE(array_length("payment_proofs", 1), 0) = 0;
