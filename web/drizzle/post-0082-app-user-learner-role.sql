-- Allow app_user.role = 'learner'.
--
-- Learners get an app_user row so they can authenticate (auth0_sub lives on
-- app_user, and party has no login concept), but they are NOT staff. The role
-- is what keeps the two populations apart:
--
--   * routes/advisors.ts filters `WHERE u.role IN ('admin','advisor')`, so a
--     correctly-labelled learner drops out of the advisor picker on its own —
--     no query change needed there.
--   * middleware/auth.ts provisions role='learner' when the token's email
--     matches a party that already has a learner_profile.
--
-- Before this, JIT provisioning had no legal value for a learner and fell
-- through to role='admin', which put every student in the advisor roster.
--
-- Idempotent.

ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_role_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_role_check
  CHECK (role IN ('admin','advisor','service_rep','readonly','learner'));
