-- Phase E1: Forecast Agent snapshots.
-- One row per `Run forecast`; the latest is read by the home card and the
-- agent detail page. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "forecast_snapshot" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"     uuid NOT NULL,
  "generated_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "numbers"       jsonb NOT NULL,
  "narrative"     jsonb NOT NULL,
  "model"         text,
  "tokens_in"     integer,
  "tokens_out"    integer,
  "generated_by"  uuid
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_snapshot_tenant_fk') THEN
    ALTER TABLE "forecast_snapshot" ADD CONSTRAINT "forecast_snapshot_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_snapshot_user_fk') THEN
    ALTER TABLE "forecast_snapshot" ADD CONSTRAINT "forecast_snapshot_user_fk"
      FOREIGN KEY ("generated_by") REFERENCES "app_user"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "forecast_snapshot_tenant_idx"
  ON "forecast_snapshot" ("tenant_id", "generated_at" DESC);

-- RLS — same pattern as post-0014.
ALTER TABLE "forecast_snapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "forecast_snapshot" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "forecast_snapshot_tenant_isolation" ON "forecast_snapshot";
CREATE POLICY "forecast_snapshot_tenant_isolation" ON "forecast_snapshot"
  USING (tenant_id = current_tenant() OR current_tenant() IS NULL)
  WITH CHECK (tenant_id = current_tenant() OR current_tenant() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON "forecast_snapshot" TO decrm_app;
