-- WhatsApp broadcasts.
--
-- Two tables + a trigger:
--   wa_broadcast            — the campaign (template + scheduling + counts)
--   wa_broadcast_recipient  — one row per (broadcast, party); status updates
--                             via webhook callbacks
--   wa_broadcast_recipient_status_trigger
--                           — keeps wa_broadcast.{sent,delivered,read,failed}
--                             counters in sync without N+1 application-side
--                             queries (mirrors wacrm migration 005)
--
-- Idempotent. Safe to re-run.

-- ─── wa_broadcast ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "wa_broadcast" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"            uuid NOT NULL,
  "name"                 text NOT NULL,
  "template_id"          uuid NOT NULL,
  "created_by"           uuid,
  "default_variables"    jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status"               text NOT NULL DEFAULT 'draft',
  "scheduled_at"         timestamp with time zone,
  "started_at"           timestamp with time zone,
  "finished_at"          timestamp with time zone,
  "total_recipients"     integer NOT NULL DEFAULT 0,
  "sent_count"           integer NOT NULL DEFAULT 0,
  "delivered_count"      integer NOT NULL DEFAULT 0,
  "read_count"           integer NOT NULL DEFAULT 0,
  "failed_count"         integer NOT NULL DEFAULT 0,
  "created_at"           timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"           timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_broadcast_tenant_fk') THEN
    ALTER TABLE "wa_broadcast" ADD CONSTRAINT "wa_broadcast_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_broadcast_template_fk') THEN
    ALTER TABLE "wa_broadcast" ADD CONSTRAINT "wa_broadcast_template_fk"
      FOREIGN KEY ("template_id") REFERENCES "wa_template"("id") ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_broadcast_creator_fk') THEN
    ALTER TABLE "wa_broadcast" ADD CONSTRAINT "wa_broadcast_creator_fk"
      FOREIGN KEY ("created_by") REFERENCES "app_user"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_broadcast_status_check') THEN
    ALTER TABLE "wa_broadcast" ADD CONSTRAINT "wa_broadcast_status_check"
      CHECK (status IN ('draft', 'scheduled', 'sending', 'completed', 'cancelled', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_broadcast_name_len_check') THEN
    ALTER TABLE "wa_broadcast" ADD CONSTRAINT "wa_broadcast_name_len_check"
      CHECK (char_length(name) BETWEEN 1 AND 120);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "wa_broadcast_tenant_status_idx"
  ON "wa_broadcast" ("tenant_id", "status", "created_at" DESC);

ALTER TABLE "wa_broadcast" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wa_broadcast" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wa_broadcast_tenant_isolation" ON "wa_broadcast";
CREATE POLICY "wa_broadcast_tenant_isolation" ON "wa_broadcast"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "wa_broadcast" TO decrm_app;

DROP TRIGGER IF EXISTS wa_broadcast_updated_at ON "wa_broadcast";
CREATE TRIGGER wa_broadcast_updated_at BEFORE UPDATE ON "wa_broadcast"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── wa_broadcast_recipient ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "wa_broadcast_recipient" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"            uuid NOT NULL,
  "broadcast_id"         uuid NOT NULL,
  "party_id"             uuid,
  "to_phone"             text NOT NULL,                -- E.164 with leading +
  "variables"            jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status"               text NOT NULL DEFAULT 'pending',
  "provider_message_id"  text,
  "error_code"           text,
  "error_message"        text,
  "queued_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "sent_at"              timestamp with time zone,
  "delivered_at"         timestamp with time zone,
  "read_at"              timestamp with time zone
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_broadcast_recipient_tenant_fk') THEN
    ALTER TABLE "wa_broadcast_recipient" ADD CONSTRAINT "wa_broadcast_recipient_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_broadcast_recipient_broadcast_fk') THEN
    ALTER TABLE "wa_broadcast_recipient" ADD CONSTRAINT "wa_broadcast_recipient_broadcast_fk"
      FOREIGN KEY ("broadcast_id") REFERENCES "wa_broadcast"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_broadcast_recipient_party_fk') THEN
    ALTER TABLE "wa_broadcast_recipient" ADD CONSTRAINT "wa_broadcast_recipient_party_fk"
      FOREIGN KEY ("party_id") REFERENCES "party"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_broadcast_recipient_status_check') THEN
    ALTER TABLE "wa_broadcast_recipient" ADD CONSTRAINT "wa_broadcast_recipient_status_check"
      CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed', 'cancelled'));
  END IF;
END $$;

-- One recipient per party per broadcast — when adding from the UI we
-- want dedup. Also the lookup-by-(broadcast,party) is fast.
CREATE UNIQUE INDEX IF NOT EXISTS "wa_broadcast_recipient_broadcast_party_key"
  ON "wa_broadcast_recipient" ("broadcast_id", "party_id")
  WHERE "party_id" IS NOT NULL;
-- Webhook callback lookup. provider_message_id IS NULL until we send.
CREATE UNIQUE INDEX IF NOT EXISTS "wa_broadcast_recipient_provider_msg_id_unique"
  ON "wa_broadcast_recipient" ("provider_message_id") WHERE "provider_message_id" IS NOT NULL;
-- Worker scan: pending rows for one broadcast.
CREATE INDEX IF NOT EXISTS "wa_broadcast_recipient_pending_idx"
  ON "wa_broadcast_recipient" ("broadcast_id", "queued_at")
  WHERE "status" = 'pending';

ALTER TABLE "wa_broadcast_recipient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wa_broadcast_recipient" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wa_broadcast_recipient_tenant_isolation" ON "wa_broadcast_recipient";
CREATE POLICY "wa_broadcast_recipient_tenant_isolation" ON "wa_broadcast_recipient"
  USING      (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "wa_broadcast_recipient" TO decrm_app;

-- ─── Counter trigger ────────────────────────────────────────────────────
-- Whenever a recipient row's status changes, adjust the parent broadcast's
-- {sent,delivered,read,failed}_count counters. The application doesn't
-- need to do this incrementally — much harder to keep right under
-- concurrent updates than a simple BEFORE/AFTER UPDATE trigger.
--
-- INSERT path increments the bucket the row starts in (pending → no
-- counter); the worker flips status='sent' which fires the UPDATE path.
-- UPDATE path moves the count from old bucket to new bucket.
-- DELETE path decrements (rare — happens on cascade from broadcast delete,
-- which already drops the parent row, so trigger is a no-op there).

CREATE OR REPLACE FUNCTION wa_broadcast_recipient_status_changed()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Brand new rows are usually 'pending' — no counter to bump.
    -- But if a row is inserted directly as 'sent' (we don't currently do
    -- this, but be safe), bump it.
    IF NEW.status = 'sent' THEN
      UPDATE wa_broadcast SET sent_count = sent_count + 1 WHERE id = NEW.broadcast_id;
    ELSIF NEW.status = 'delivered' THEN
      UPDATE wa_broadcast SET delivered_count = delivered_count + 1 WHERE id = NEW.broadcast_id;
    ELSIF NEW.status = 'read' THEN
      UPDATE wa_broadcast SET read_count = read_count + 1 WHERE id = NEW.broadcast_id;
    ELSIF NEW.status = 'failed' THEN
      UPDATE wa_broadcast SET failed_count = failed_count + 1 WHERE id = NEW.broadcast_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
      -- Decrement the OLD bucket (if it was one we count).
      IF OLD.status = 'sent' THEN
        UPDATE wa_broadcast SET sent_count = GREATEST(sent_count - 1, 0) WHERE id = NEW.broadcast_id;
      ELSIF OLD.status = 'delivered' THEN
        UPDATE wa_broadcast SET delivered_count = GREATEST(delivered_count - 1, 0) WHERE id = NEW.broadcast_id;
      ELSIF OLD.status = 'read' THEN
        UPDATE wa_broadcast SET read_count = GREATEST(read_count - 1, 0) WHERE id = NEW.broadcast_id;
      ELSIF OLD.status = 'failed' THEN
        UPDATE wa_broadcast SET failed_count = GREATEST(failed_count - 1, 0) WHERE id = NEW.broadcast_id;
      END IF;
      -- Increment the NEW bucket (if it's one we count).
      IF NEW.status = 'sent' THEN
        UPDATE wa_broadcast SET sent_count = sent_count + 1 WHERE id = NEW.broadcast_id;
      ELSIF NEW.status = 'delivered' THEN
        UPDATE wa_broadcast SET delivered_count = delivered_count + 1 WHERE id = NEW.broadcast_id;
      ELSIF NEW.status = 'read' THEN
        UPDATE wa_broadcast SET read_count = read_count + 1 WHERE id = NEW.broadcast_id;
      ELSIF NEW.status = 'failed' THEN
        UPDATE wa_broadcast SET failed_count = failed_count + 1 WHERE id = NEW.broadcast_id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS wa_broadcast_recipient_status_changed_trg ON "wa_broadcast_recipient";
CREATE TRIGGER wa_broadcast_recipient_status_changed_trg
  AFTER INSERT OR UPDATE ON "wa_broadcast_recipient"
  FOR EACH ROW EXECUTE FUNCTION wa_broadcast_recipient_status_changed();
