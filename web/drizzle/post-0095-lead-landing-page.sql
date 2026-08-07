-- Where the lead was standing when they submitted the form.
--
-- `source` already says WHICH channel ('web', 'referral'), but not which
-- page. For a marketing site that is the difference between "a web lead" and
-- "a lead from /programs/data-engineering" — the second is what tells you
-- which page is earning its keep.
--
-- The full URL is stored, query string included, so UTM parameters come along
-- for free rather than needing five more columns:
--
--   https://kdigital.ai/programs/data-engineering?utm_source=linkedin
--                                                &utm_campaign=aug-cohort
--
-- Deliberately NOT a foreign key to `campaign`. lead.source_campaign_id
-- (post-0088) is for a campaign the CRM sent; this is the page a stranger
-- happened to be on. Conflating them would make attribution lie.
--
-- Idempotent.

ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "landing_page_url" text;

DO $$ BEGIN
  -- This value arrives from a browser, on a PUBLIC unauthenticated endpoint,
  -- and the CRM renders it as a clickable link. So the scheme is fenced in
  -- the database as well as in the route: a stored 'javascript:...' URL would
  -- otherwise be an XSS delivered to whoever opens the lead.
  --
  -- Length is capped because a URL is not a place to smuggle a payload; real
  -- landing-page URLs with UTMs run to a few hundred characters.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_landing_page_url_check') THEN
    ALTER TABLE "lead" ADD CONSTRAINT "lead_landing_page_url_check"
      CHECK (
        "landing_page_url" IS NULL
        OR ("landing_page_url" ~* '^https?://' AND length("landing_page_url") <= 2048)
      );
  END IF;
END $$;

-- "Which pages produced leads this month" is the question this column exists
-- to answer, so it gets an index rather than a sequential scan over every
-- lead the business has ever taken.
CREATE INDEX IF NOT EXISTS "lead_landing_page_idx"
  ON "lead" ("tenant_id", "landing_page_url")
  WHERE "landing_page_url" IS NOT NULL;
