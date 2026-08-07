# Deployment runbook

One deployment target: **Vercel**. The database stays on **Azure Postgres**.

## TL;DR

```
GitHub repo (this)
  └── web/   → Vercel project → https://<your-app>.vercel.app
                 ├── Next.js pages + Server Components
                 ├── the whole API at /api/**        (src/app/api/[...path]/route.ts)
                 └── three scheduled jobs            (Vercel Cron → /api/cron/*)
                        ↓
                 Azure Postgres (de-crm-pg)   ← currently Burstable B1ms,
                                                so no PgBouncer. See below.
```

There is no separate backend service. Express was removed and the API now runs as
Next.js route handlers in the same project — see `web/src/server/app.ts` for the
mount table and `web/src/server/http/` for the router that replaced Express.

## The one thing to get right

Render existed for exactly one reason: it gave the API a long-running container with a
**persistent connection pool**, which Vercel's per-request functions cannot.

Every concurrent invocation is its own process with its own pool, so connections
reaching Postgres are `concurrent invocations × DB_POOL_MAX`. `DB_POOL_MAX` therefore
defaults to **2**, not the 20 that was right for a single Express process. Raise it
only once a pooler is in front of Postgres.

### This deployment is on Burstable B1ms — read this before scaling

`de-crm-pg` is **PostgreSQL 17, Burstable B1ms**, and that tier has two properties
that matter here:

- **~35 max_connections total**, shared with your `psql` sessions and the migration runner.
- **No built-in PgBouncer.** Azure only offers it on General Purpose and Memory
  Optimized tiers.

So the pooler that would replace Render's persistent pool is *not currently available
to you*. That doesn't block the migration, but it does mean concurrency is the thing
to watch. Three ways forward, cheapest first:

1. **Keep Burstable, set `DB_POOL_MAX=2`, and leave Vercel Fluid compute on**
   (it is the default). Fluid reuses one instance across concurrent requests instead
   of spinning one per request, so the number of live pools stays small. At this
   CRM's scale this is very likely sufficient — budget ~30 usable connections and
   watch the pool-wait warnings.
2. **Upgrade to General Purpose** if you start seeing `too many connections` or
   sustained pool-wait warnings. That unlocks built-in PgBouncer: enable it under
   `de-crm-pg` → **Server parameters** → `pgbouncer.enabled` = on, then move
   `APP_DATABASE_URL` to port **6432**. Transaction mode is safe — `withTenant`
   scopes tenants with `SET LOCAL`, which is transaction-scoped and survives
   transaction pooling unchanged. Note this is a real cost step up from ~$15/mo.
3. **A self-hosted PgBouncer** would work, but it means running a container again —
   i.e. re-introducing the deployment target this migration removed. Only worth it
   if you outgrow (1) and won't pay for (2).

Signals to watch in the Vercel logs:

```
[db] withTenant: waited 812ms for a pool slot (size 2, 0 idle, 3 queued)
```

That line means requests are queueing on connections — the trigger to move to (2).

---

## Pre-flight checklist (do this **before** you push)

Run from the repo root.

```bash
# 1. Typecheck.
( cd web && npx tsc --noEmit )

# 2. The production build succeeds.
( cd web && rm -rf .next && npx next build )

# 3. No secrets in code. Real keys live only in web/.env.local (gitignored).
grep -rn "sk-[A-Za-z0-9_-]\{15,\}" web/src 2>/dev/null   # → empty

# 4. Migrations are idempotent (safe to re-run on prod):
( cd web && npm run db:migrate && npm run db:migrate )   # both runs succeed
```

The build output should list four API routes. If `/api/cron/*` are missing, something
renamed them back under a `_`-prefixed folder — Next treats those as private and
silently excludes them from routing:

```
├ ƒ /api/[...path]
├ ƒ /api/cron/campaigns
├ ƒ /api/cron/dedup
├ ƒ /api/cron/gmail
```

---

## Part A — The Vercel project

### A1. Create it

1. https://vercel.com → **Add New → Project** → import this repo.
2. Settings:
   - **Framework**: Next.js (auto-detected)
   - **Root Directory**: `web` ← **important**
   - Leave Build / Output / Install commands at defaults.

`web/vercel.json` already pins the region to `bom1` (Mumbai, next to the database)
and declares the three cron schedules.

### A2. Environment variables

**Settings → Environment Variables.** Everything the API needs now lives here — this
is the list that used to be split across Render and Vercel.

| Var | Value | Notes |
|---|---|---|
| `APP_DATABASE_URL` | `postgres://decrm_app:<pwd>@de-crm-pg.postgres.database.azure.com:5432/postgres?sslmode=require` | **(secret)** app role, NOBYPASSRLS — RLS enforces tenant isolation. Port **5432** on Burstable; **6432** once you're on General Purpose with PgBouncer |
| `DATABASE_URL` | `postgres://decrm_admin:<pwd>@…:5432/postgres?sslmode=require` | **(secret)** admin role. Used by the migration runner and the LangGraph checkpointer. Direct port, not the pooler |
| `DECRM_APP_PASSWORD` | `<same pwd as APP_DATABASE_URL>` | **(secret)** the migrate runner re-asserts this |
| `CRON_SECRET` | a long random string | **(secret) NEW.** Vercel Cron sends it as `Authorization: Bearer`. The cron routes **refuse to run without it** — they fail closed, because they spend money on messaging |
| `AUTH0_DOMAIN` | `<tenant>.auth0.com` | API verifies Bearer JWTs against this tenant's JWKS |
| `AUTH0_AUDIENCE` | your API identifier | |
| `AUTH0_PERMISSIONS_CLAIM` | `https://digitaledify.com/permissions` | optional; this is the default |
| `AUTH0_CLIENT_ID` / `AUTH0_CLIENT_SECRET` / `AUTH0_SECRET` | | **(secret)** used by the Next SDK for the browser session |
| `APP_BASE_URL` | `https://<your-app>.vercel.app` | Auth0 SDK callback base |
| `DEFAULT_TENANT_ID` | uuid | pins the tenant instead of "newest row wins" |
| `INTAKE_API_KEY` | `<random>` | **(secret)** guards the public lead-intake endpoint |
| `CORS_ORIGIN` | `https://kdigital.ai,https://<your-app>.vercel.app` | now only matters for the public intake endpoint called cross-origin by marketing pages — everything else is same-origin |
| `AI_PROVIDER` | `anthropic` | required for the Claude-backed agents |
| `ANTHROPIC_API_KEY` | `sk-…` | **(secret)** |
| `ANTHROPIC_BASE_URL` | `https://inference-api.nvidia.com/` | or `https://api.anthropic.com/` |
| `ANTHROPIC_MODEL` | `aws/anthropic/bedrock-claude-sonnet-4-6` | model ID your key can reach |
| `DB_POOL_MAX` | `2` | per-invocation. `2` because this deployment is on Burstable — see above |
| `NEXT_PUBLIC_SITE_URL` | `https://crm.yourdomain.com` | optional. Only needed if you want Server Components to call a canonical domain rather than the per-deployment `VERCEL_URL` |

Deliberately **gone**: `API_URL` and `NEXT_PUBLIC_API_URL` (the API is same-origin now),
and `PORT` (that was Express's listen port).

> If you don't set the `ANTHROPIC_*` block, the agents pages still load but agent
> **runs** will throw. Leave them off only if that's intentional.

### A3. Azure firewall

Vercel functions do not have stable outbound IPs on Pro — the same problem Render's
free tier had. Whatever rule currently admits Render has to be at least as permissive
for Vercel, and note that Azure's *"Allow public access from any Azure service"*
toggle does **not** cover either of them (neither runs in Azure).

- **Pragmatic**: keep public access open at the network layer and rely on the strong
  `decrm_app` password + `sslmode=require`. **Never put admin creds in app config** —
  only the migration runner uses `DATABASE_URL`.
- **Strict**: Vercel **Secure Compute** (Enterprise) gives static egress IPs you can
  whitelist exclusively.

### A4. Apply migrations

Migrations don't run automatically. From your machine, against prod:

```bash
cd web
DATABASE_URL='postgres://decrm_admin:<pwd>@de-crm-pg…:5432/postgres?sslmode=require' \
DECRM_APP_PASSWORD='<pwd>' \
  npm run db:migrate
```

Two migrations are new and **required** before the first request:

- `post-0097-rate-limit-window.sql` — moves the four rate limiters out of process
  memory. Without it they throw on every call (they fail open, so requests still
  succeed, but the log fills and lead intake is effectively unlimited).
- `post-0098-campaign-recipient-sending-at.sql` — adds `sending_at`. Without it the
  campaign dispatcher's claim query errors and **no campaign sends at all**.

The runner is idempotent; re-running is safe.

### A5. Deploy and verify

Push to `main`. Then:

```bash
curl https://<your-app>.vercel.app/api/health
# → {"ok":true,"db":{"now":"…"}}
```

That single call proves the route handler, the mount table, and the database
connection all work. Then check a cron endpoint rejects an unauthenticated caller:

```bash
curl -i https://<your-app>.vercel.app/api/cron/dedup
# → 401  (or 503 if you forgot CRON_SECRET)
```

### A6. Update the provider consoles

The API moved origin, so anything holding a stored callback URL needs updating.

| Provider | Old | New |
|---|---|---|
| Auth0 | Allowed Callback/Logout URLs on Render | `https://<your-app>.vercel.app` |
| Slack | `https://…onrender.com/auth/slack` | `https://<your-app>.vercel.app/api/auth/slack` |
| Google | `https://…onrender.com/auth/google` | `https://<your-app>.vercel.app/api/auth/google` |
| Twilio | `https://…onrender.com/webhooks/twilio` | `https://<your-app>.vercel.app/webhooks/twilio` |
| Exotel | `https://…onrender.com/webhooks/exotel` | `https://<your-app>.vercel.app/webhooks/exotel` |

The two **webhook** paths keep their `/webhooks/...` shape — `next.config.mjs` rewrites
them onto the API mount specifically so a live phone number's configuration doesn't
have to change shape during the cutover. Only the host changes.

Twilio also signs its webhook over the **exact URL**, so `TWILIO_WEBHOOK_URL` (or
whatever `readTwilioConfig().webhookUrl` reads) must match the new URL character for
character, or every inbound message fails signature verification with a 403.

### A7. Smoke test

Sign in, then walk through:

1. **/leads** — list renders, click a lead.
2. **/records/[lead]** — inline-edit a field; the timeline shows the diff.
3. **Send paths** — Twilio, Gmail, Exotel, and a two-recipient campaign.
   These were restructured during the performance work *and* moved during the
   migration. Do not skip them.
4. **Inbound** — reply to the WhatsApp/SMS message and confirm it lands in the inbox
   (this is what proves the webhook signature check survived the URL change).

Common failures:

- **Everything 302s to `/auth/login`** → `web/src/middleware.ts`'s matcher lost its
  `api/` and `webhooks/` exclusions. Those are load-bearing: the API authenticates by
  Bearer token, not by the browser session cookie.
- **`too many connections`** → PgBouncer isn't actually in front. Confirm the port is
  6432 and lower `DB_POOL_MAX`.
- **Campaigns never send** → `post-0098` not applied, or `CRON_SECRET` unset.
- **Inbound webhook 403** → the signing URL doesn't match the new one exactly.

---

## Part B — Decommission Render

Do this **after** A7 passes, not before.

1. Render → the API service → **Settings → Suspend**. Leave it suspended for a few
   days rather than deleting — it is the fastest rollback if something surfaces late.
2. Confirm nothing still points at `*.onrender.com`:
   ```bash
   grep -rn "onrender" --include=*.ts --include=*.json --include=*.md . | grep -v node_modules
   ```
3. Once you're satisfied: **Settings → Delete Service**, and drop the Azure firewall
   rules that existed only for Render.
4. Stale `*.onrender.com` health-check entries linger in `.claude/settings.json` and
   `.claude/settings.local.json`. Harmless, but worth deleting when you next touch them.

---

## Part C — Custom domain (optional)

- Vercel → project → **Settings → Domains** → add `crm.yourdomain.com`.
- Set `APP_BASE_URL` and `NEXT_PUBLIC_SITE_URL` to the new origin, update Auth0's
  allowed callback/logout URLs, and add the domain to `CORS_ORIGIN`.
- Redeploy. There is no second service to keep in sync any more — the API rides along
  on the same domain automatically.

---

## Day-2 ops

- **Adding a migration**: drop a new `post-NNNN-*.sql` under `web/drizzle/`, keep it
  idempotent (`IF NOT EXISTS`, constraint guards), then run `npm run db:migrate`
  against prod once.
- **Rotating a secret**: Vercel → Environment Variables → update → redeploy.
  `NEXT_PUBLIC_*` values are baked into the client bundle at build time, so those
  always need a redeploy; server-only vars take effect on the next deployment too.
- **Logs**: Vercel → project → **Logs**. Slow requests self-report — the API emits a
  `Server-Timing` header splitting Postgres / pool-wait / everything-else, and logs
  anything over `SLOW_REQUEST_MS`.
- **Cron health**: Vercel → project → **Cron Jobs** shows the last run and status of
  all three.

---

## What this deployment doesn't do

- **No staging environment** — the cleanest way to add one is a `staging` branch + a
  second Vercel project pointing at a separate database. Now a single project, not two.
- **No GitHub Actions** — pushes deploy via Vercel's git integration. Add CI later if
  you want pre-merge typecheck/build gates.
- **No automated DB backups** — Azure Postgres has PITR backups by default; verify
  retention under `de-crm-pg` → Backups.
- **No managed observability** — Vercel Analytics ($) or Sentry is the usual upgrade.
