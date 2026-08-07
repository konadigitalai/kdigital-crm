-- Phase H+: split phone into country code + local number, and let the lead
-- carry an optional time zone for the record header. Idempotent.

ALTER TABLE "party" ADD COLUMN IF NOT EXISTS "phone_country_code" text;
ALTER TABLE "lead"  ADD COLUMN IF NOT EXISTS "time_zone" text;
