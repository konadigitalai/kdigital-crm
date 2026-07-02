-- Phase 3 of the Party Model migration — drop lead.city denorm.
--
-- Purpose: lead.city was a denormalized shadow of party.city. Every write
-- in the old codebase double-wrote both (routes/leads.ts:579-581); every
-- read picked one or the other, creating a class of "which copy is right?"
-- bugs. Phase 3 route code reads party.city everywhere, so the column is
-- unused. Drop it.
--
-- Idempotent. Reversible via:
--   ALTER TABLE lead ADD COLUMN city text;
--   UPDATE lead l SET city = p.city
--     FROM work_item wi JOIN party p ON p.id = wi.party_id
--     WHERE wi.id = l.work_item_id;

ALTER TABLE "lead" DROP COLUMN IF EXISTS "city";
