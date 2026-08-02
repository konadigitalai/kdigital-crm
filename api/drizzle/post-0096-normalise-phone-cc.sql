-- One canonical shape for party.phone_country_code: "+91", never "91".
--
-- Two producers wrote two formats. The CRM's New Lead dialog validates
-- /^\+\d{1,4}$/ and sends "+91"; the website intake form sends "91". Both
-- reached composeFullE164, which strips non-digits, so the stored E.164 was
-- correct either way and nothing looked broken.
--
-- What it broke was the display. prettyPhone compared the column against
-- "+91", so rows carrying "91" fell through unformatted and the leads list
-- showed the same number two ways on adjacent rows:
--
--     91 9876543210        cc "91"   — no plus, no grouping
--     +91 98765 43210      cc "+91"  — correct
--
-- "+" prefixed wins because it is what the CRM UI already produces and
-- validates, what 8 of the 10 existing rows carry, and self-describing in a
-- way a bare "91" is not.
--
-- Defence in depth, all three needed:
--   here            existing rows normalised, and a CHECK so it cannot drift
--   intake route    normalises on write, so a producer sending "91" is
--                   corrected rather than rejected
--   prettyPhone     reduces to digits before formatting, so the display is
--                   right even if a row somehow escapes the above
--
-- Idempotent.

-- Digits-only values gain the prefix. Anything already correct is untouched,
-- and an empty string becomes NULL rather than a stray "+".
UPDATE party
   SET phone_country_code = '+' || regexp_replace(phone_country_code, '\D', '', 'g')
 WHERE phone_country_code IS NOT NULL
   AND phone_country_code !~ '^\+'
   AND regexp_replace(phone_country_code, '\D', '', 'g') <> '';

UPDATE party
   SET phone_country_code = NULL
 WHERE phone_country_code IS NOT NULL
   AND regexp_replace(phone_country_code, '\D', '', 'g') = '';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'party_phone_cc_check') THEN
    ALTER TABLE "party" ADD CONSTRAINT "party_phone_cc_check"
      CHECK ("phone_country_code" IS NULL OR "phone_country_code" ~ '^\+[0-9]{1,4}$');
  END IF;
END $$;
