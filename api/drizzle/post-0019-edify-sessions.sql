-- Phase F.1: Edify chat sessions.
-- Adds a session_id to edify_chat_message so the home box and the dedicated
-- chat page can persist conversation state across refreshes and let the user
-- start a New chat. Idempotent.

-- 1. Sessions table.
CREATE TABLE IF NOT EXISTS "edify_chat_session" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   uuid NOT NULL,
  "user_id"     uuid NOT NULL,
  "title"       text,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "last_at"     timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edify_session_tenant_fk') THEN
    ALTER TABLE "edify_chat_session" ADD CONSTRAINT "edify_session_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edify_session_user_fk') THEN
    ALTER TABLE "edify_chat_session" ADD CONSTRAINT "edify_session_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "edify_session_user_time_idx"
  ON "edify_chat_session" ("tenant_id", "user_id", "last_at" DESC);

-- 2. RLS + grants.
ALTER TABLE "edify_chat_session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "edify_chat_session" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "edify_session_tenant_isolation" ON "edify_chat_session";
CREATE POLICY "edify_session_tenant_isolation" ON "edify_chat_session"
  USING (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "edify_chat_session" TO decrm_app;

-- 3. Add session_id to existing messages, with a backfill that groups every
--    pre-session message per (user, day) into one session so old chats stay
--    accessible.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'edify_chat_message' AND column_name = 'session_id'
  ) THEN
    ALTER TABLE "edify_chat_message" ADD COLUMN "session_id" uuid;
  END IF;
END $$;

-- 4. Backfill: one session per (tenant, user, day) for any pre-session messages.
WITH grouped AS (
  SELECT DISTINCT tenant_id, user_id, date_trunc('day', asked_at) AS day
  FROM edify_chat_message
  WHERE session_id IS NULL
),
created AS (
  INSERT INTO edify_chat_session (tenant_id, user_id, title, created_at, last_at)
  SELECT g.tenant_id, g.user_id, 'Session ' || to_char(g.day, 'YYYY-MM-DD'), g.day, g.day
  FROM grouped g
  RETURNING id, tenant_id, user_id, created_at
)
UPDATE edify_chat_message m
SET session_id = c.id
FROM created c
WHERE m.session_id IS NULL
  AND m.tenant_id = c.tenant_id
  AND m.user_id   = c.user_id
  AND date_trunc('day', m.asked_at) = c.created_at;

-- 5. Add the FK + NOT NULL after backfill.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edify_message_session_fk') THEN
    ALTER TABLE "edify_chat_message" ADD CONSTRAINT "edify_message_session_fk"
      FOREIGN KEY ("session_id") REFERENCES "edify_chat_session"("id") ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE "edify_chat_message" ALTER COLUMN "session_id" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "edify_message_session_idx"
  ON "edify_chat_message" ("session_id", "asked_at");
