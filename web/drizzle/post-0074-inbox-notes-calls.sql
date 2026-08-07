-- Inbox: internal notes + manually-logged calls, as first-class thread entries.
--
-- Why these live in tw_message rather than `activity`:
--   - They must render INSIDE the conversation, interleaved with real messages by
--     timestamp. tw_message already has the ordering, indexes and pagination for
--     exactly that; `activity` would need a second stream merged in the route.
--   - `activity` hangs off work_item, so an unlinked conversation (someone who
--     messaged us but isn't a lead yet) could not carry a note at all.
--
-- `kind` is the discriminator:
--   message   — a real inbound/outbound message (the only kind the send pipeline
--               ever inserts, so an internal note can never be transmitted).
--   note      — staff-only. Never sent anywhere. Rendered as a callout.
--   call_log  — a call placed/received outside the system, logged by hand.
--               Structured detail (outcome, duration) goes in `meta`.
--
-- When the conversation IS linked to a lead, the route additionally mirrors a
-- row into `activity` so the record-page timeline shows it — same approach
-- leads.ts uses for notes and lead_task uses for scheduled work.
--
-- from_number / to_number were NOT NULL, which only ever made sense for real
-- messages: a note has no addresses. Relaxed to nullable rather than writing
-- placeholder junk into them.
--
-- Idempotent — safe to replay.

ALTER TABLE tw_message
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'message';

ALTER TABLE tw_message
  ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tw_message_kind_check' AND conrelid = 'tw_message'::regclass
  ) THEN
    ALTER TABLE tw_message
      ADD CONSTRAINT tw_message_kind_check
      CHECK (kind IN ('message', 'note', 'call_log'));
  END IF;
END $$;

-- Notes and call logs carry no addresses.
ALTER TABLE tw_message ALTER COLUMN from_number DROP NOT NULL;
ALTER TABLE tw_message ALTER COLUMN to_number   DROP NOT NULL;

-- The thread renders every kind, but the conversation LIST previews only real
-- messages — a partial index keeps that filter cheap as note volume grows.
CREATE INDEX IF NOT EXISTS tw_message_conversation_kind_idx
  ON tw_message (conversation_id, sent_at)
  WHERE kind <> 'message';
