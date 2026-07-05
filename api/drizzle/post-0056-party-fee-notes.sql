-- Add a free-form notes column to the learner fee ledger. Advisors use it to
-- record context around the payment ("paid via UPS, will send GST invoice
-- later", "waiting on chargeback confirmation", …) that doesn't fit the
-- structured status field.
--
-- Idempotent.

ALTER TABLE "party" ADD COLUMN IF NOT EXISTS "fee_notes" text;
