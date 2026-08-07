-- Track when a campaign recipient was claimed for sending.
--
-- The dispatcher used to run as a 5-second setInterval in a single always-on
-- process, so "reap rows stuck in 'sending'" could safely run once at boot and
-- never again — nothing else was dispatching concurrently.
--
-- Under cron + trigger-on-write there is no boot, and two invocations can
-- overlap. An unqualified reap would move a row that is legitimately in flight
-- back to 'pending' and send it a second time: a duplicate WhatsApp/SMS to a
-- real person, billed twice. sending_at is what lets the reaper tell the two
-- cases apart (see STUCK_SENDING_MS in lib/campaigns/worker.ts).

ALTER TABLE campaign_recipient
  ADD COLUMN IF NOT EXISTS sending_at timestamptz;

-- Partial index: the reaper only ever scans rows currently in 'sending', which
-- is a tiny slice of the table.
CREATE INDEX IF NOT EXISTS campaign_recipient_sending_at_idx
  ON campaign_recipient (sending_at)
  WHERE status = 'sending';

-- Backfill: any row already sitting in 'sending' predates this column and was
-- stranded by the old process. Stamp it in the past so the first reap after
-- deploy picks it up rather than leaving it in limbo forever.
UPDATE campaign_recipient
   SET sending_at = NOW() - INTERVAL '1 hour'
 WHERE status = 'sending' AND sending_at IS NULL;
