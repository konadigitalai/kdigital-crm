-- B2B — accounts, contacts and a real opportunity pipeline.
--
-- The CRM has been B2C-only: a lead is a person who wants to learn something.
-- The workbook models the other half of the business — organisations that buy
-- training and hire graduates — and none of it had a home. `deal` existed with
-- three columns (a cohort, a value, a probability) and no account, no contact,
-- no close date and no stage, which is not a pipeline.
--
-- Two decisions worth stating:
--
--   1. Accounts and contacts are PARTY SATELLITES, not new identity tables.
--      `party` already distinguishes person from organisation via `kind`, and
--      `party_affiliation` already models person↔organisation with a role and
--      a valid interval — which is exactly the workbook's contact.account_id
--      plus affiliation_valid_from/to. Building a separate `account` identity
--      would fork the deduplication, merge and consent machinery that
--      post-0040 through post-0052 exist to provide.
--
--   2. Opportunity EXTENDS `deal` rather than replacing it. deal already sits
--      on the work_item spine, which supplies the number, the owner, the
--      state, the priority and the activity timeline. A parallel
--      `opportunity` table would mean two pipelines and two timelines.
--
-- Idempotent.

CREATE SEQUENCE IF NOT EXISTS seq_account START 1000;
GRANT USAGE, SELECT ON SEQUENCE seq_account TO decrm_app;

-- ─── 1. account — the organisation satellite ─────────────────────────────

CREATE TABLE IF NOT EXISTS "account" (
  party_id   uuid PRIMARY KEY REFERENCES party(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES tenant(id),

  account_number text NOT NULL DEFAULT 'ACC-' || lpad(nextval('seq_account')::text, 5, '0'),

  -- Where this organisation sits relative to us. A 'client' buys training, a
  -- 'hiring_partner' takes our graduates, and plenty are both — hence
  -- account_type being what we sell to them, not a mutually exclusive bucket.
  account_type text NOT NULL DEFAULT 'prospect',
  industry     text,
  ownership    text,         -- 'Public' | 'Private' | 'Government' | …
  website      text,

  -- Annual revenue in rupees, matching every other money column in this
  -- schema. The workbook ships minor units; the importer divides by 100.
  annual_revenue numeric(16,2),
  currency       text NOT NULL DEFAULT 'INR',

  owner_party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  rating         text,
  status         text NOT NULL DEFAULT 'active',
  description    text,

  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT account_type_check CHECK (
    account_type IN ('client','prospect','partner','vendor','hiring_partner')),
  CONSTRAINT account_rating_check CHECK (
    rating IS NULL OR rating IN ('hot','warm','cold')),
  CONSTRAINT account_status_check CHECK (
    status IN ('active','inactive','churned')),
  CONSTRAINT account_revenue_check CHECK (
    annual_revenue IS NULL OR annual_revenue >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "account_number_uniq"
  ON "account" ("tenant_id", "account_number");
CREATE INDEX IF NOT EXISTS "account_tenant_status_idx" ON "account" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "account_owner_idx"         ON "account" ("tenant_id", "owner_party_id");
CREATE INDEX IF NOT EXISTS "account_type_idx"          ON "account" ("tenant_id", "account_type");

DROP TRIGGER IF EXISTS "account_updated_at" ON "account";
CREATE TRIGGER "account_updated_at" BEFORE UPDATE ON "account"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The party behind an account must be an organisation, not a person. Enforced
-- by trigger rather than CHECK because the fact lives on another table.
CREATE OR REPLACE FUNCTION account_party_must_be_org() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  SELECT kind INTO k FROM party WHERE id = NEW.party_id;
  IF k IS DISTINCT FROM 'org' THEN
    RAISE EXCEPTION 'account.party_id must reference a party with kind = org (got %)', COALESCE(k, 'no such party');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "account_party_kind" ON "account";
CREATE TRIGGER "account_party_kind" BEFORE INSERT OR UPDATE OF party_id ON "account"
  FOR EACH ROW EXECUTE FUNCTION account_party_must_be_org();

GRANT SELECT, INSERT, UPDATE, DELETE ON "account" TO decrm_app;
ALTER TABLE "account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "account_tenant_isolation" ON "account";
CREATE POLICY "account_tenant_isolation" ON "account"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

-- ─── 2. contact — the B2B person satellite ───────────────────────────────
--
-- No account_id column. The link to the employer is a party_affiliation row,
-- which already carries is_primary and the valid interval the workbook calls
-- affiliation_valid_from / affiliation_valid_to. Storing it twice would mean
-- one of the two is eventually wrong.

CREATE TABLE IF NOT EXISTS "contact" (
  party_id  uuid PRIMARY KEY REFERENCES party(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenant(id),

  job_title  text,
  department text,
  -- What this person does in a buying decision. Distinct from job_title:
  -- a CTO can be the evaluator on one deal and the sponsor on the next.
  contact_role text,

  preferred_contact_method text,
  preferred_language       text,

  state       text,
  country     text NOT NULL DEFAULT 'India',
  description text,

  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT contact_preferred_method_check CHECK (
    preferred_contact_method IS NULL
    OR preferred_contact_method IN ('email','phone','whatsapp','sms','none')),
  CONSTRAINT contact_role_check CHECK (
    contact_role IS NULL
    OR contact_role IN ('decision_maker','evaluator','sponsor','influencer','user','gatekeeper'))
);

CREATE INDEX IF NOT EXISTS "contact_tenant_idx" ON "contact" ("tenant_id");
CREATE INDEX IF NOT EXISTS "contact_role_idx"   ON "contact" ("tenant_id", "contact_role");

DROP TRIGGER IF EXISTS "contact_updated_at" ON "contact";
CREATE TRIGGER "contact_updated_at" BEFORE UPDATE ON "contact"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON "contact" TO decrm_app;
ALTER TABLE "contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "contact_tenant_isolation" ON "contact";
CREATE POLICY "contact_tenant_isolation" ON "contact"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

-- ─── 3. deal becomes a real opportunity ──────────────────────────────────
--
-- work_item already supplies: number (DEAL-3142), assignee (owner), state,
-- priority, created_at / updated_at and the activity timeline. Everything
-- added here is what work_item cannot know about a B2B sale.

ALTER TABLE "deal" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "deal" ADD COLUMN IF NOT EXISTS "account_party_id"         uuid;
ALTER TABLE "deal" ADD COLUMN IF NOT EXISTS "primary_contact_party_id" uuid;
ALTER TABLE "deal" ADD COLUMN IF NOT EXISTS "opportunity_type" text;
-- Sales stage, separate from work_item.state (open/closed). A deal can be in
-- 'negotiation' while its work_item is simply 'open'.
ALTER TABLE "deal" ADD COLUMN IF NOT EXISTS "stage" text NOT NULL DEFAULT 'qualification';
ALTER TABLE "deal" ADD COLUMN IF NOT EXISTS "stage_updated_at" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "deal" ADD COLUMN IF NOT EXISTS "currency" text NOT NULL DEFAULT 'INR';
-- Weighted pipeline value. Stored rather than computed so a forecast snapshot
-- taken last month keeps the probability it was taken at.
ALTER TABLE "deal" ADD COLUMN IF NOT EXISTS "expected_revenue" numeric(14,2);
ALTER TABLE "deal" ADD COLUMN IF NOT EXISTS "expected_close_date" date;
ALTER TABLE "deal" ADD COLUMN IF NOT EXISTS "actual_close_date"   date;
ALTER TABLE "deal" ADD COLUMN IF NOT EXISTS "next_action"  text;
ALTER TABLE "deal" ADD COLUMN IF NOT EXISTS "description"  text;
ALTER TABLE "deal" ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "deal" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deal_account_fk') THEN
    ALTER TABLE "deal" ADD CONSTRAINT "deal_account_fk"
      FOREIGN KEY ("account_party_id") REFERENCES "account"("party_id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deal_primary_contact_fk') THEN
    ALTER TABLE "deal" ADD CONSTRAINT "deal_primary_contact_fk"
      FOREIGN KEY ("primary_contact_party_id") REFERENCES "contact"("party_id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deal_stage_check') THEN
    ALTER TABLE "deal" ADD CONSTRAINT "deal_stage_check"
      CHECK ("stage" IN ('qualification','discovery','proposal','negotiation','closed_won','closed_lost'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deal_opportunity_type_check') THEN
    ALTER TABLE "deal" ADD CONSTRAINT "deal_opportunity_type_check"
      CHECK ("opportunity_type" IS NULL
             OR "opportunity_type" IN ('corporate_training','hiring','consulting','renewal','upsell'));
  END IF;
  -- A closed deal has a close date; an open one does not. This is the
  -- invariant every pipeline report assumes and nothing was enforcing.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deal_close_date_check') THEN
    ALTER TABLE "deal" ADD CONSTRAINT "deal_close_date_check"
      CHECK (("stage" IN ('closed_won','closed_lost')) = ("actual_close_date" IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "deal_account_idx" ON "deal" ("tenant_id", "account_party_id");
CREATE INDEX IF NOT EXISTS "deal_stage_idx"   ON "deal" ("tenant_id", "stage");
CREATE INDEX IF NOT EXISTS "deal_close_idx"   ON "deal" ("tenant_id", "expected_close_date");

DROP TRIGGER IF EXISTS "deal_updated_at" ON "deal";
CREATE TRIGGER "deal_updated_at" BEFORE UPDATE ON "deal"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Stamp stage_updated_at whenever the stage actually moves, so "days in
-- stage" is a real number rather than something the UI has to guess from the
-- activity feed.
CREATE OR REPLACE FUNCTION deal_stamp_stage_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    NEW.stage_updated_at = now();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "deal_stage_stamp" ON "deal";
CREATE TRIGGER "deal_stage_stamp" BEFORE UPDATE ON "deal"
  FOR EACH ROW EXECUTE FUNCTION deal_stamp_stage_change();

-- Existing deals predate the stage column and got the 'qualification'
-- default. Any that are already closed on the work_item are moved to
-- closed_won so the new CHECK does not describe them incorrectly.
UPDATE deal d
   SET stage = 'closed_won',
       actual_close_date = COALESCE(d.actual_close_date, wi.updated_at::date)
  FROM work_item wi
 WHERE wi.id = d.work_item_id
   AND wi.state IN ('closed','won')
   AND d.stage = 'qualification';

-- ─── 4. account_type on the B2B side of party_affiliation ────────────────
-- party_affiliation.role_at_org was free text with a comment listing the
-- vocabulary. Now that contacts are a real thing, fence it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_affiliation_role_check') THEN
    ALTER TABLE "party_affiliation" ADD CONSTRAINT "party_affiliation_role_check"
      CHECK ("role_at_org" IS NULL
             OR "role_at_org" IN ('decision_maker','evaluator','sponsor','influencer',
                                  'user','gatekeeper','employee','contractor','alumnus'));
  END IF;
END $$;
