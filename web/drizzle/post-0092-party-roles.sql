-- party_role gains 'worker' and 'candidate'.
--
-- post-0089 and post-0091 introduced two new populations of people. Both are
-- roles a party plays over an interval — someone is a worker from their
-- joining date to their exit date, and a candidate from the day they consent
-- to staffing until they are placed or withdraw. That is exactly what
-- party_role models, and leaving them out would mean the party timeline shows
-- "became a learner" and then goes silent through the half of their life with
-- us that we actually got paid for.
--
-- Without this the worker route had to write role = 'advisor', which is wrong
-- for a trainer and wrong for a recruiter.
--
-- Idempotent.

ALTER TABLE party_role DROP CONSTRAINT IF EXISTS party_role_role_check;
ALTER TABLE party_role ADD CONSTRAINT party_role_role_check
  CHECK (role IN (
    'lead','contact','enrolled','learner','intern','advisor','alumnus',
    'worker','candidate'
  ));

-- Backfill: everyone post-0089 put in the directory gets the role, dated from
-- their joining date where one is known.
INSERT INTO party_role (tenant_id, party_id, role, valid_from)
SELECT w.tenant_id, w.party_id, 'worker', COALESCE(w.date_of_joining, CURRENT_DATE)
  FROM worker w
 WHERE NOT EXISTS (
   SELECT 1 FROM party_role pr
    WHERE pr.party_id = w.party_id AND pr.role = 'worker'
 );

-- End-date the role for anyone already marked as exited, so "current staff"
-- is a query against valid_to rather than a second source of truth.
UPDATE party_role pr
   SET valid_to = COALESCE(w.date_of_exit, CURRENT_DATE)
  FROM worker w
 WHERE pr.party_id = w.party_id
   AND pr.role = 'worker'
   AND pr.valid_to IS NULL
   AND w.status = 'exited';
