-- Phase G: Time tracking, leaves, calendar, in-app invites.
-- (The client domain originally lived here too; dropped in post-0033. The
-- client section below is gated on the post-0033 marker so re-running the
-- migration set on a dropped DB doesn't resurrect what we just removed.)
--
-- Idempotent — safe to re-run.

-- Marker table for one-time migrations. Owned by post-0026 originally; we
-- ensure-create here so post-0033's marker check works even if the order
-- gets shuffled.
CREATE TABLE IF NOT EXISTS "_decrm_one_time_migration" (
  key text PRIMARY KEY,
  applied_at timestamp with time zone NOT NULL DEFAULT now()
);

-- ── Clients (creates only if post-0033 hasn't dropped them) ──────────────
DO $$
DECLARE clients_dropped boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM "_decrm_one_time_migration" WHERE key = 'clients_dropped'
  ) INTO clients_dropped;
  IF clients_dropped THEN
    -- Nothing to do — post-0033 has run.
    RETURN;
  END IF;

  CREATE TABLE IF NOT EXISTS "client" (
    "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"   uuid NOT NULL,
    "name"        text NOT NULL,
    "code"        text,
    "description" text,
    "active"      boolean NOT NULL DEFAULT true,
    "created_at"  timestamp with time zone NOT NULL DEFAULT now()
  );
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_tenant_fk') THEN
    ALTER TABLE "client" ADD CONSTRAINT "client_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  CREATE UNIQUE INDEX IF NOT EXISTS "client_tenant_name_key"
    ON "client" ("tenant_id", lower("name"));

  CREATE TABLE IF NOT EXISTS "client_assignment" (
    "id"        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "client_id" uuid NOT NULL,
    "user_id"   uuid NOT NULL,
    "added_at"  timestamp with time zone NOT NULL DEFAULT now()
  );
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_assignment_tenant_fk') THEN
    ALTER TABLE "client_assignment" ADD CONSTRAINT "client_assignment_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_assignment_client_fk') THEN
    ALTER TABLE "client_assignment" ADD CONSTRAINT "client_assignment_client_fk"
      FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_assignment_user_fk') THEN
    ALTER TABLE "client_assignment" ADD CONSTRAINT "client_assignment_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE;
  END IF;
  CREATE UNIQUE INDEX IF NOT EXISTS "client_assignment_pk"
    ON "client_assignment" ("client_id", "user_id");
  CREATE INDEX IF NOT EXISTS "client_assignment_user_idx"
    ON "client_assignment" ("tenant_id", "user_id");
END $$;

-- ── Work sessions (clock-in / clock-out) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS "work_session" (
  "id"        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "user_id"   uuid NOT NULL,
  "date"      date NOT NULL,
  "clock_in"  timestamp with time zone NOT NULL,
  "clock_out" timestamp with time zone,
  "notes"     text
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_session_tenant_fk') THEN
    ALTER TABLE "work_session" ADD CONSTRAINT "work_session_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_session_user_fk') THEN
    ALTER TABLE "work_session" ADD CONSTRAINT "work_session_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "work_session_user_date_idx"
  ON "work_session" ("tenant_id", "user_id", "date" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "work_session_open_one_per_user"
  ON "work_session" ("user_id") WHERE clock_out IS NULL;

-- ── Time blocks (the 1-hour grid, editable) ──────────────────────────────
CREATE TABLE IF NOT EXISTS "time_block" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"  uuid NOT NULL,
  "user_id"    uuid NOT NULL,
  "session_id" uuid,
  "date"       date NOT NULL,
  "start_at"   timestamp with time zone NOT NULL,
  "end_at"     timestamp with time zone NOT NULL,
  "client_id"  uuid,
  "note"       text,
  "billable"   boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_block_tenant_fk') THEN
    ALTER TABLE "time_block" ADD CONSTRAINT "time_block_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_block_user_fk') THEN
    ALTER TABLE "time_block" ADD CONSTRAINT "time_block_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_block_session_fk') THEN
    ALTER TABLE "time_block" ADD CONSTRAINT "time_block_session_fk"
      FOREIGN KEY ("session_id") REFERENCES "work_session"("id") ON DELETE CASCADE;
  END IF;
  -- The client domain was removed in post-0033 (column + table). Only add
  -- the FK if both the column and the referenced table still exist; on a
  -- post-0033 DB this branch is skipped so re-running the migration set
  -- doesn't fail with "column does not exist".
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_block_client_fk')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'time_block' AND column_name = 'client_id')
     AND EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_name = 'client') THEN
    ALTER TABLE "time_block" ADD CONSTRAINT "time_block_client_fk"
      FOREIGN KEY ("client_id") REFERENCES "client"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_block_endgtstart') THEN
    ALTER TABLE "time_block" ADD CONSTRAINT "time_block_endgtstart"
      CHECK (end_at > start_at);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "time_block_user_date_idx"
  ON "time_block" ("tenant_id", "user_id", "date");
-- Same client-column guard as the FK above: only create the index if the
-- column still exists. post-0033 drops it, after which this is skipped.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'time_block' AND column_name = 'client_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "time_block_client_idx"
             ON "time_block" ("tenant_id", "client_id", "date")';
  END IF;
END $$;

-- ── Leaves ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "leave_day" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"  uuid NOT NULL,
  "user_id"    uuid NOT NULL,
  "date"       date NOT NULL,
  "kind"       text NOT NULL,
  "half_day"   text DEFAULT 'full',
  "note"       text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_day_tenant_fk') THEN
    ALTER TABLE "leave_day" ADD CONSTRAINT "leave_day_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_day_user_fk') THEN
    ALTER TABLE "leave_day" ADD CONSTRAINT "leave_day_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_day_kind_check') THEN
    ALTER TABLE "leave_day" ADD CONSTRAINT "leave_day_kind_check"
      CHECK (kind IN ('sick','personal','vacation','wfh','holiday'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leave_day_halfday_check') THEN
    ALTER TABLE "leave_day" ADD CONSTRAINT "leave_day_halfday_check"
      CHECK (half_day IS NULL OR half_day IN ('full','am','pm'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "leave_day_user_date_key"
  ON "leave_day" ("user_id", "date");
CREATE INDEX IF NOT EXISTS "leave_day_tenant_date_idx"
  ON "leave_day" ("tenant_id", "date");

-- ── Calendar events ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "calendar_event" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"    uuid NOT NULL,
  "organizer_id" uuid NOT NULL,
  "title"        text NOT NULL,
  "description"  text,
  "location"     text,
  "start_at"     timestamp with time zone NOT NULL,
  "end_at"       timestamp with time zone NOT NULL,
  "all_day"      boolean NOT NULL DEFAULT false,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_event_tenant_fk') THEN
    ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_event_org_fk') THEN
    ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_org_fk"
      FOREIGN KEY ("organizer_id") REFERENCES "app_user"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_event_endgtstart') THEN
    ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_endgtstart"
      CHECK (end_at > start_at);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "calendar_event_org_time_idx"
  ON "calendar_event" ("tenant_id", "organizer_id", "start_at");

-- ── Invitees + RSVP ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "calendar_invitee" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"     uuid NOT NULL,
  "user_id"      uuid NOT NULL,
  "rsvp"         text NOT NULL DEFAULT 'pending',
  "responded_at" timestamp with time zone
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_invitee_event_fk') THEN
    ALTER TABLE "calendar_invitee" ADD CONSTRAINT "calendar_invitee_event_fk"
      FOREIGN KEY ("event_id") REFERENCES "calendar_event"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_invitee_user_fk') THEN
    ALTER TABLE "calendar_invitee" ADD CONSTRAINT "calendar_invitee_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_invitee_rsvp_check') THEN
    ALTER TABLE "calendar_invitee" ADD CONSTRAINT "calendar_invitee_rsvp_check"
      CHECK (rsvp IN ('pending','accepted','declined','tentative'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_invitee_pk"
  ON "calendar_invitee" ("event_id", "user_id");
CREATE INDEX IF NOT EXISTS "calendar_invitee_user_idx"
  ON "calendar_invitee" ("user_id", "rsvp");

-- ── RLS — same pattern as previous migrations ────────────────────────────
-- Skip 'client' / 'client_assignment' if they no longer exist (post-0033).
DO $$
DECLARE t text;
  base text[] := ARRAY[
    'work_session','time_block','leave_day','calendar_event'
  ];
  tables text[];
BEGIN
  tables := base;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'client') THEN
    tables := array_append(tables, 'client');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'client_assignment') THEN
    tables := array_append(tables, 'client_assignment');
  END IF;

  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = current_tenant() OR current_tenant() IS NULL) WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL)',
      t, t
    );
  END LOOP;
END $$;

-- calendar_invitee: no tenant_id; RLS via the parent event's tenant.
ALTER TABLE "calendar_invitee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calendar_invitee" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "calendar_invitee_isolation" ON "calendar_invitee";
CREATE POLICY "calendar_invitee_isolation" ON "calendar_invitee"
  USING (
    current_tenant() IS NULL OR EXISTS (
      SELECT 1 FROM "calendar_event" e WHERE e.id = event_id AND e.tenant_id = current_tenant()
    )
  )
  WITH CHECK (
    current_tenant() IS NULL OR EXISTS (
      SELECT 1 FROM "calendar_event" e WHERE e.id = event_id AND e.tenant_id = current_tenant()
    )
  );

-- ── Grants for the app role ──────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "work_session", "time_block",
  "leave_day", "calendar_event", "calendar_invitee"
TO decrm_app;
-- Client GRANTs only when the tables still exist (pre-0033). The client
-- domain was removed in post-0033; on a dropped DB this skips silently.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'client') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "client" TO decrm_app';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'client_assignment') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "client_assignment" TO decrm_app';
  END IF;
END $$;

-- ── Permission backfill for existing tenants ────────────────────────────
-- Administrators groups get all the new permissions. (clients.manage was
-- dropped in post-0033 — don't reseed it; post-0033's DELETE would just
-- strip it again on re-run.)
INSERT INTO user_group_permission (group_id, permission)
SELECT g.id, p.perm
FROM user_group g
CROSS JOIN (VALUES
  ('timesheets.read.self'),
  ('timesheets.read.all'),
  ('events.manage.self')
) AS p(perm)
WHERE g.name = 'Administrators'
ON CONFLICT DO NOTHING;

-- Advisors get self-timesheet + self-events.
INSERT INTO user_group_permission (group_id, permission)
SELECT g.id, p.perm
FROM user_group g
CROSS JOIN (VALUES
  ('timesheets.read.self'),
  ('events.manage.self')
) AS p(perm)
WHERE g.name = 'Advisors'
ON CONFLICT DO NOTHING;
