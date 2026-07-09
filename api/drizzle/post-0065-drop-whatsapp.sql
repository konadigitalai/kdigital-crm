-- Drop the WhatsApp-via-Meta integration.
--
-- Companion to commit `chore(whatsapp): remove Meta WhatsApp integration`.
-- The application code no longer references any of these tables. See
-- post-0034-whatsapp.sql / post-0035-whatsapp-broadcasts.sql /
-- post-0036-whatsapp-automations.sql for the original definitions.
--
-- SAFETY: verify these tables are empty (or backed up) before applying to
-- any environment that ran the Meta integration in production. The nav
-- item was disabled in dev but a webhook could still have inserted rows.
--
--   SELECT
--     (SELECT count(*) FROM wa_message)              AS msg,
--     (SELECT count(*) FROM wa_conversation)         AS conv,
--     (SELECT count(*) FROM wa_broadcast)            AS bcast,
--     (SELECT count(*) FROM wa_broadcast_recipient)  AS bcast_r,
--     (SELECT count(*) FROM wa_automation_run)       AS auto_r;
--
-- The follow-up commit adds tw_conversation / tw_message for Twilio-based
-- SMS + WhatsApp. The `contact_point.kind = 'whatsapp'` and
-- `party_consent.channel = 'whatsapp'` channel literals are provider-agnostic
-- and stay.

-- Child tables first for clearer failure output if a dependency is unexpected;
-- CASCADE would make ordering unnecessary but explicit is friendlier.
DROP TABLE IF EXISTS wa_message CASCADE;
DROP TABLE IF EXISTS wa_broadcast_recipient CASCADE;
DROP TABLE IF EXISTS wa_automation_run CASCADE;
DROP TABLE IF EXISTS wa_party_tag CASCADE;
DROP TABLE IF EXISTS wa_broadcast CASCADE;
DROP TABLE IF EXISTS wa_conversation CASCADE;
DROP TABLE IF EXISTS wa_automation CASCADE;
DROP TABLE IF EXISTS wa_tag CASCADE;
DROP TABLE IF EXISTS wa_template CASCADE;
DROP TABLE IF EXISTS wa_config CASCADE;
