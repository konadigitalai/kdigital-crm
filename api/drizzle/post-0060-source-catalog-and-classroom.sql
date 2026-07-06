-- post-0060: Source catalog rework + Training Mode "offline" → "classroom".
--
-- Two data-only rewrites plus one CHECK-constraint swap. All idempotent.
--
-- 1. Source dropdown was: web, instagram_ad, referral, webinar, paid
--    Now becomes:         web, email, phone, chat, web_form, referral,
--                         paid, demo, organic_search
--    Any existing lead with source='instagram_ad' or source='webinar'
--    gets rewritten to source='web' / source_label='Web' (per operator
--    decision on 2026-07-06).
--
-- 2. Training Mode CHECK previously accepted (online|offline|hybrid).
--    "Offline" was a misleading label — we're renaming it to "classroom"
--    everywhere. Existing rows with delivery_mode='offline' get rewritten
--    to 'classroom', and the CHECK constraint is dropped and recreated to
--    accept (online|classroom|hybrid).
--
-- Notes:
-- - Neither `lead.source` nor `lead.source_label` has a CHECK constraint,
--   so no constraint work is needed for the source rewrites.
-- - `delivery_mode` needs the CHECK swapped in the same transaction as the
--   data rewrite, otherwise UPDATE 'offline'→'classroom' would violate the
--   old CHECK. Doing them together keeps this migration idempotent even
--   after partial re-runs.

BEGIN;

-- ── Source rewrites ────────────────────────────────────────────────────
UPDATE "lead"
   SET source       = 'web',
       source_label = 'Web'
 WHERE source IN ('instagram_ad', 'webinar');

-- Work items also cache the source on their `attributes` jsonb so the
-- pipeline card doesn't need to join `lead` on every render. Rewrite
-- those in place too.
UPDATE "work_item"
   SET attributes = jsonb_set(
         jsonb_set(attributes, '{source}', '"web"'::jsonb, true),
         '{sourceLabel}', '"Web"'::jsonb, true
       )
 WHERE type = 'lead'
   AND (attributes->>'source') IN ('instagram_ad', 'webinar');

-- ── Training mode rewrite + CHECK constraint swap ──────────────────────
-- Drop old CHECK (safe if already dropped; DROP CONSTRAINT IF EXISTS).
ALTER TABLE "lead" DROP CONSTRAINT IF EXISTS "lead_delivery_mode_check";

-- Rewrite the data.
UPDATE "lead"
   SET delivery_mode = 'classroom'
 WHERE delivery_mode = 'offline';

-- Recreate the CHECK with the new allowlist.
ALTER TABLE "lead"
  ADD CONSTRAINT "lead_delivery_mode_check"
  CHECK (delivery_mode IS NULL OR delivery_mode IN ('online', 'classroom', 'hybrid'));

COMMIT;
