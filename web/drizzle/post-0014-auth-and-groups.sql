-- Phase H: Custom auth + permission-bearing user groups.
--   - app_user.password_hash
--   - app_session (server-side, opaque token, sha-256 stored)
--   - user_group + user_group_permission + user_group_member
--   - RLS + grants
-- Idempotent. Safe to re-run.

-- 1. Password hash on app_user (nullable; NULL = "no password set yet").
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'app_user' AND column_name = 'password_hash'
  ) THEN
    ALTER TABLE "app_user" ADD COLUMN "password_hash" text;
  END IF;
END $$;

-- 2. app_session — opaque-token sessions, server-side and revocable.
CREATE TABLE IF NOT EXISTS "app_session" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   uuid NOT NULL,
  "user_id"     uuid NOT NULL,
  "token_hash"  text NOT NULL,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"  timestamp with time zone NOT NULL,
  "revoked_at"  timestamp with time zone
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_session_tenant_fk') THEN
    ALTER TABLE "app_session" ADD CONSTRAINT "app_session_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_session_user_fk') THEN
    ALTER TABLE "app_session" ADD CONSTRAINT "app_session_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "app_session_token_hash_key" ON "app_session" ("token_hash");
CREATE INDEX IF NOT EXISTS "app_session_user_idx"   ON "app_session" ("tenant_id", "user_id");
CREATE INDEX IF NOT EXISTS "app_session_active_idx" ON "app_session" ("expires_at") WHERE revoked_at IS NULL;

-- 3. user_group — admin-created groups carrying a set of permissions.
CREATE TABLE IF NOT EXISTS "user_group" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   uuid NOT NULL,
  "name"        text NOT NULL,
  "description" text,
  "is_system"   boolean NOT NULL DEFAULT false,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_group_tenant_fk') THEN
    ALTER TABLE "user_group" ADD CONSTRAINT "user_group_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "user_group_tenant_name_key" ON "user_group" ("tenant_id", "name");

-- 4. user_group_permission — flat (group, permission) rows.
CREATE TABLE IF NOT EXISTS "user_group_permission" (
  "group_id"   uuid NOT NULL,
  "permission" text NOT NULL,
  PRIMARY KEY ("group_id", "permission")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_group_permission_group_fk') THEN
    ALTER TABLE "user_group_permission" ADD CONSTRAINT "user_group_permission_group_fk"
      FOREIGN KEY ("group_id") REFERENCES "user_group"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- 5. user_group_member — many-to-many user ↔ group.
CREATE TABLE IF NOT EXISTS "user_group_member" (
  "user_id"  uuid NOT NULL,
  "group_id" uuid NOT NULL,
  "added_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "group_id")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_group_member_user_fk') THEN
    ALTER TABLE "user_group_member" ADD CONSTRAINT "user_group_member_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_group_member_group_fk') THEN
    ALTER TABLE "user_group_member" ADD CONSTRAINT "user_group_member_group_fk"
      FOREIGN KEY ("group_id") REFERENCES "user_group"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "user_group_member_group_idx" ON "user_group_member" ("group_id");

-- 6. RLS — tenant isolation for the tables that carry tenant_id directly.
--    user_group_permission and user_group_member don't carry tenant_id;
--    they're isolated transitively via FK joins, and grants prevent direct
--    visibility outside an authenticated session.
DO $$
DECLARE t text;
  tables text[] := ARRAY['app_session','user_group'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',  t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = current_tenant() OR current_tenant() IS NULL) WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL)',
      t, t
    );
  END LOOP;
END $$;

-- user_group_permission and user_group_member: enable RLS but use a permissive
-- policy that defers to the joined user_group's policy. (Postgres won't follow
-- the FK automatically; we trust the route layer to scope queries via JOIN.)
ALTER TABLE "user_group_permission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_group_permission" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_group_permission_isolation" ON "user_group_permission";
CREATE POLICY "user_group_permission_isolation" ON "user_group_permission"
  USING (
    current_tenant() IS NULL OR EXISTS (
      SELECT 1 FROM "user_group" g WHERE g.id = group_id AND g.tenant_id = current_tenant()
    )
  )
  WITH CHECK (
    current_tenant() IS NULL OR EXISTS (
      SELECT 1 FROM "user_group" g WHERE g.id = group_id AND g.tenant_id = current_tenant()
    )
  );

ALTER TABLE "user_group_member" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_group_member" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_group_member_isolation" ON "user_group_member";
CREATE POLICY "user_group_member_isolation" ON "user_group_member"
  USING (
    current_tenant() IS NULL OR EXISTS (
      SELECT 1 FROM "user_group" g WHERE g.id = group_id AND g.tenant_id = current_tenant()
    )
  )
  WITH CHECK (
    current_tenant() IS NULL OR EXISTS (
      SELECT 1 FROM "user_group" g WHERE g.id = group_id AND g.tenant_id = current_tenant()
    )
  );

-- 7. Grants for the app role.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "app_session", "user_group", "user_group_permission", "user_group_member"
TO decrm_app;
