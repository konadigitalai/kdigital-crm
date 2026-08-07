-- Phase H+: delivery mode the lead is interested in (online | offline | hybrid).
-- Optional; pre-existing leads have no value until an advisor sets one.
-- Idempotent.

ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "delivery_mode" text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_delivery_mode_check') THEN
    ALTER TABLE "lead" ADD CONSTRAINT "lead_delivery_mode_check"
      CHECK (delivery_mode IS NULL OR delivery_mode IN ('online','offline','hybrid'));
  END IF;
END $$;
