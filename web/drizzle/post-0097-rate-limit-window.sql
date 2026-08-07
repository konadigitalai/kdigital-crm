-- Rate limiter state, moved out of per-process memory.
--
-- The four limiters (lead intake, exotel click-to-call, and the exotel/twilio
-- webhooks) used to hold a sliding window in a module-scope Map. Under
-- serverless that Map is empty on most invocations, so the limits stopped
-- firing — including the one in front of the public, unauthenticated lead
-- intake endpoint. This table gives them shared state.

CREATE TABLE IF NOT EXISTS rate_limit_window (
  key          text        PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  hits         integer     NOT NULL DEFAULT 0
);

-- Deliberately NOT tenant-scoped and NOT under RLS. Three of the four callers
-- run before any tenant is resolved: lead intake is public, and the webhooks
-- authenticate by HMAC / IP allowlist rather than by JWT. A tenant_id column
-- would have nothing to put in it.
--
-- The keys are namespaced by caller instead (`intake:<ip>`, `exotel:<userId>`,
-- …) so the limiters cannot collide with each other.
ALTER TABLE rate_limit_window DISABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_window TO decrm_app;

-- Sweep index: rows are only interesting for the length of their window, and
-- an IP that hits intake once and never returns would otherwise live forever.
CREATE INDEX IF NOT EXISTS rate_limit_window_stale_idx
  ON rate_limit_window (window_start);
