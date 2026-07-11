-- Event-driven campaign triggers.
--
-- Phase 3 of the WhatsApp Templates + Campaign Engine.
--
-- A trigger is a rule: "when event X happens with condition Y, send
-- template Z to the party involved". Firing a trigger creates a
-- single-recipient synthetic campaign_recipient row and the existing
-- campaign worker picks it up on the next tick.
--
-- Cooldown: a trigger fired once for a given party must not fire again
-- within cooldown_hours. We enforce that by consulting campaign_trigger_fire.
--
-- No FK to `campaign` — triggers fire independently and land in a
-- dedicated per-trigger auto-campaign row (created on first fire).

CREATE TABLE IF NOT EXISTS campaign_trigger (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  name                  text NOT NULL,
  content_sid           text NOT NULL,
  variable_bindings     jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_type            text NOT NULL,
  condition             jsonb NOT NULL DEFAULT '{}'::jsonb,
  cooldown_hours        integer NOT NULL DEFAULT 24,
  enabled               boolean NOT NULL DEFAULT false,
  auto_campaign_id      uuid REFERENCES campaign(id) ON DELETE SET NULL,
  created_by            uuid REFERENCES party(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_trigger_event_check
    CHECK (event_type IN ('lead.stage_changed','lead.created','lead.rating_changed'))
);

CREATE INDEX IF NOT EXISTS campaign_trigger_tenant_event_enabled_idx
  ON campaign_trigger (tenant_id, event_type, enabled);

-- Audit + cooldown lookup — one row per (trigger, party, timestamp).
CREATE TABLE IF NOT EXISTS campaign_trigger_fire (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  trigger_id    uuid NOT NULL REFERENCES campaign_trigger(id) ON DELETE CASCADE,
  party_id      uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  work_item_id  uuid REFERENCES work_item(id) ON DELETE SET NULL,
  fired_at      timestamptz NOT NULL DEFAULT now(),
  recipient_id  uuid REFERENCES campaign_recipient(id) ON DELETE SET NULL,
  outcome       text NOT NULL DEFAULT 'queued'
);

CREATE INDEX IF NOT EXISTS campaign_trigger_fire_trigger_party_idx
  ON campaign_trigger_fire (trigger_id, party_id, fired_at DESC);

-- ─── Grants + RLS ────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_trigger, campaign_trigger_fire TO decrm_app;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['campaign_trigger','campaign_trigger_fire'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = current_tenant() OR current_tenant() IS NULL) WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL)',
      t, t
    );
  END LOOP;
END $$;
