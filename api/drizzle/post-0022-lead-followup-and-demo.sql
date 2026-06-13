-- Phase H+: structured "Next follow-up date" and "Demo attended date" on
-- leads. Idempotent.

ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "next_followup_at" date;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "demo_attended_at" date;

-- Followup-due is the workhorse query — index by tenant + due date so the
-- "leads with a follow-up today/this week" filter is cheap.
CREATE INDEX IF NOT EXISTS "lead_next_followup_idx"
  ON "lead" ("tenant_id", "next_followup_at");
CREATE INDEX IF NOT EXISTS "lead_demo_attended_idx"
  ON "lead" ("tenant_id", "demo_attended_at");
