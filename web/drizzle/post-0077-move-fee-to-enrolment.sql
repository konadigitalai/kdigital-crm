-- Move the learner fee ledger from `party` → `enrolment`.
--
-- Rationale: financial information belongs to the enrolment (the "enrolled"
-- stage of party → lead → enrolled → learner → intern), not to the person.
-- A learner has exactly one enrolment, so "one ledger per person" and "one
-- ledger per enrolment" are equivalent here — no behaviour change for users.
--
-- SAFETY: this whole file runs as ONE implicit transaction (node-postgres
-- sends it as a single simple-query, which PostgreSQL wraps atomically). The
-- backfill (step 2) therefore always completes and commits BEFORE the drop
-- (step 3). If anything fails, the entire migration rolls back and the party
-- columns are left intact — no data is lost.
--
-- `lead` fee fields are intentionally left untouched.
--
-- Idempotent: ADD/DROP … IF [NOT] EXISTS + COALESCE backfill make replay safe.

-- ── 1. EXPAND — add the ledger columns enrolment doesn't already have ──────
-- (enrolment already has: price_paid, fee_due, due_date, registered_date,
--  payment_proof_url — so we only add the five below.)
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS fee_quoted     numeric(12,2);
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS fee_paid       numeric(12,2);
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS payment_status text;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS payment_proofs text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS fee_notes      text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enrolment_payment_status_check') THEN
    ALTER TABLE enrolment ADD CONSTRAINT enrolment_payment_status_check
      CHECK (payment_status IS NULL OR payment_status IN ('pending','paid','refund','on_hold'));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON enrolment TO decrm_app;

-- ── 2. BACKFILL — copy each learner's party ledger into their enrolment ────
-- COALESCE guards mean we never clobber a value convert.ts already wrote to
-- the enrolment. Only touch parties that actually carry ledger data.
UPDATE enrolment e SET
  fee_quoted        = COALESCE(e.fee_quoted,        p.fee_quoted),
  fee_paid          = COALESCE(e.fee_paid,          p.fee_paid, e.price_paid),
  due_date          = COALESCE(e.due_date,          p.due_date),
  payment_status    = COALESCE(e.payment_status,    p.payment_status),
  payment_proof_url = COALESCE(e.payment_proof_url, p.payment_proof_url),
  payment_proofs    = CASE
                        WHEN COALESCE(array_length(e.payment_proofs, 1), 0) = 0
                          THEN COALESCE(p.payment_proofs, '{}'::text[])
                        ELSE e.payment_proofs
                      END,
  fee_notes         = COALESCE(e.fee_notes,         p.fee_notes)
FROM party p
WHERE e.party_id = p.id
  AND (
        p.fee_quoted IS NOT NULL OR p.fee_paid IS NOT NULL OR p.due_date IS NOT NULL
     OR p.payment_status IS NOT NULL OR p.payment_proof_url IS NOT NULL
     OR COALESCE(array_length(p.payment_proofs, 1), 0) > 0 OR p.fee_notes IS NOT NULL
  );

-- ── 3. CONTRACT — drop the ledger from party (runs after the backfill) ─────
-- Dropping payment_status also drops party_payment_status_check automatically.
ALTER TABLE party DROP COLUMN IF EXISTS fee_quoted;
ALTER TABLE party DROP COLUMN IF EXISTS fee_paid;
ALTER TABLE party DROP COLUMN IF EXISTS due_date;
ALTER TABLE party DROP COLUMN IF EXISTS payment_status;
ALTER TABLE party DROP COLUMN IF EXISTS payment_proof_url;
ALTER TABLE party DROP COLUMN IF EXISTS payment_proofs;
ALTER TABLE party DROP COLUMN IF EXISTS fee_notes;
