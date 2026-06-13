-- Phase G: Time tracking, leaves, clients, calendar, in-app invites.
-- 7 new tables + RLS + grants + permission backfill for existing tenants.
-- Idempotent — safe to re-run.

-- ── Clients ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "client" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   uuid NOT NULL,
  "name"        text NOT NULL,
  "code"        text,
  "description" text,
  "active"      boolean NOT NULL DEFAULT true,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_tenant_fk') THEN
    ALTER TABLE "client" ADD CONSTRAINT "client_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "client_tenant_name_key"
  ON "client" ("tenant_id", lower("name"));

-- ── Client ↔ user assignments ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "client_assignment" (
  "id"        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "client_id" uuid NOT NULL,
  "user_id"   uuid NOT NULL,
  "added_at"  timestamp with time zone NOT NULL DEFAULT now()
);
DO $$ BEGIN
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
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "client_assignment_pk"
  ON "client_assignment" ("client_id", "user_id");
CREATE INDEX IF NOT EXISTS "client_assignment_user_idx"
  ON "client_assignment" ("tenant_id", "user_id");

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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_block_client_fk') THEN
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
CREATE INDEX IF NOT EXISTS "time_block_client_idx"
  ON "time_block" ("tenant_id", "client_id", "date");

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
DO $$
DECLARE t text;
  tables text[] := ARRAY[
    'client','client_assignment','work_session','time_block',
    'leave_day','calendar_event'
  ];
BEGIN
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
  "client", "client_assignment", "work_session", "time_block",
  "leave_day", "calendar_event", "calendar_invitee"
TO decrm_app;

-- ── Permission backfill for existing tenants ────────────────────────────
-- Administrators groups get all 4 new permissions.
INSERT INTO user_group_permission (group_id, permission)
SELECT g.id, p.perm
FROM user_group g
CROSS JOIN (VALUES
  ('timesheets.read.self'),
  ('timesheets.read.all'),
  ('clients.manage'),
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
