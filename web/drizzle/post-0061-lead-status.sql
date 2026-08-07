-- post-0061: Add `lead_status` — a free-form-ish workflow tag on each lead.
--
-- Sits alongside (not replacing) `rating` (the sales-heat scale) and
-- `stage` (the pipeline bucket). Values match the operator's spec:
--
--   New, Contacted, Interested, Demo Attended, Visiting,
--   Payment Link Sent, Enrolled, Lost Lead, Visited,
--   Interested in Demo, Advance Talk With Trainer, Unqualified
--
-- Stored as text (not enum) so we can adjust the vocabulary without a
-- schema change; the allowlist lives in the /catalog response and the
-- CHECK constraint here backstops that.
--
-- Idempotent — safe to re-run.

BEGIN;

ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "lead_status" text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_lead_status_check') THEN
    ALTER TABLE "lead" ADD CONSTRAINT "lead_lead_status_check"
      CHECK (lead_status IS NULL OR lead_status IN (
        'new',
        'contacted',
        'interested',
        'demo_attended',
        'visiting',
        'payment_link_sent',
        'enrolled',
        'lost_lead',
        'visited',
        'interested_in_demo',
        'advance_talk_with_trainer',
        'unqualified'
      ));
  END IF;
END $$;

COMMIT;
