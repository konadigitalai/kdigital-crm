# Deployment runbook

The frontend deploys to **Vercel**, the backend to **Render**, the database stays on **Azure Postgres**.

## TL;DR

```
GitHub repo (this)
  ├── web/   → Vercel project   → https://<your-app>.vercel.app
  └── api/   → Render web service → https://<your-app>.onrender.com
                ↓
         Azure Postgres (de-crm-pg)
```

## Why this split

Vercel turns each request into a serverless function. That's perfect for Next.js Server Components — but bad for our Express API, because each cold start opens a new Postgres connection (slow + risk of exhausting the DB pool). Render gives the API a long-running container with a persistent connection pool. Both have generous free tiers.

If you'd rather host everything on Vercel, the API has to be rewritten as Next.js Route Handlers under `web/src/app/api/*/route.ts` — not done yet.

---

## Pre-flight checklist (do this **before** you push)

Run from the repo root.

```bash
# 1. Both sides typecheck cleanly.
( cd api && npm run build )
( cd web && npx tsc --noEmit )

# 2. The Next.js production build itself succeeds.
( cd web && rm -rf .next && API_URL=http://localhost:4000 NEXT_PUBLIC_API_URL=http://localhost:4000 npx next build )

# 3. No secrets in code. The only place a real key may live is api/.env (gitignored).
grep -rn "sk-[A-Za-z0-9_-]\{15,\}" api/src web/src 2>/dev/null   # → empty

# 4. Migrations are idempotent (safe to re-run on prod):
( cd api && npm run db:migrate && npm run db:migrate )           # both runs succeed
```

If any of those four fail — fix before pushing.

---

## Part A — Backend on Render

### A1. Create the Render service

1. Sign up at https://render.com (free, GitHub login works).
2. **New → Web Service** → connect this repo.
3. Settings:
   - **Name**: `digitaledify-crm-api`
   - **Region**: Singapore (closest to Azure Central India)
   - **Branch**: `main`
   - **Root Directory**: `api`
   - **Runtime**: Node
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm run start`
   - **Plan**: Free (or Starter $7/mo if you want always-on)

### A2. Add environment variables

In Render → your service → **Environment**, set the full list below. Anything marked **(secret)** must be configured via Render's "Secret" toggle, not echoed in plain config.

| Var | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | **critical** — flips session cookie to `SameSite=None; Secure` so cross-site auth works |
| `PORT` | `10000` | Render injects this automatically; leave it |
| `DATABASE_URL` | `postgres://decrm_admin:<pwd>@de-crm-pg.postgres.database.azure.com:5432/postgres?sslmode=require` | **(secret)** admin role — used **only** by the migration runner |
| `APP_DATABASE_URL` | `postgres://decrm_app:<pwd>@de-crm-pg.postgres.database.azure.com:5432/postgres?sslmode=require` | **(secret)** app role — used by every HTTP handler. NOBYPASSRLS, so RLS enforces tenant isolation |
| `DECRM_APP_PASSWORD` | `<same pwd as APP_DATABASE_URL>` | **(secret)** the migrate runner re-asserts this on every deploy |
| `CORS_ORIGIN` | `https://<your-app>.vercel.app` | comma-separate to allow more than one origin (e.g. preview + custom domain) |
| `AI_PROVIDER` | `anthropic` | required for the Claude-backed agents (Outreach / Scoring / NBA / Forecast / Edify) |
| `ANTHROPIC_API_KEY` | `sk-…` | **(secret)** |
| `ANTHROPIC_BASE_URL` | `https://inference-api.nvidia.com/` | NVIDIA-hosted Anthropic endpoint (or `https://api.anthropic.com/` if you switch) |
| `ANTHROPIC_MODEL` | `aws/anthropic/bedrock-claude-sonnet-4-6` | the model ID your key has access to |

> If you don't set the `ANTHROPIC_*` block, the agents pages still load but the agent **runs** will throw — leave them off only if that's intentional for the launch.

### A3. Allow Render's outbound IP through Azure firewall

Render free tier doesn't pin outbound IPs (they rotate). Two options:

- **Easy**: in Azure Portal → `de-crm-pg` → Networking → enable **"Allow public access from any Azure service within Azure to this server"**. This lets every Render container reach the DB. Combined with `decrm_app`'s strong password and `sslmode=require`, it's acceptable for a small project. **Never put admin creds in app config** — only the migration runner uses `DATABASE_URL`.
- **Strict**: pay for Render's Static Outbound IP ($7/mo per service) and whitelist that IP exclusively.

### A4. Deploy

Push `main` → Render auto-builds and deploys. First deploy takes ~3-5 min. Watch the live logs.

Health-check:

```bash
curl https://<your-app>.onrender.com/health
# → {"ok":true,"db":{"now":"…"}}
```

> **Free tier caveat**: services sleep after 15 min idle. First request after sleep takes ~30 s to wake. For demos, ping `/health` from a cron service like https://cron-job.org every 10 min, or upgrade to Starter ($7/mo).

### A5. Apply migrations to the prod DB

Migrations don't run automatically. Pick one path:

**Option 1 — from your machine (recommended for the first deploy)**

```bash
cd api
# point at prod via the same DATABASE_URL you pasted in Render
DATABASE_URL='postgres://decrm_admin:<pwd>@de-crm-pg…?sslmode=require' \
DECRM_APP_PASSWORD='<pwd>' \
  npm run db:migrate
```

The runner is idempotent (every `post-*.sql` uses `IF NOT EXISTS` and constraint guards). Re-running is safe. If the DB is empty, also run `npm run db:seed` once for demo data.

**Option 2 — from Render's Shell tab**

```bash
npm run db:migrate
```

### A6. Seed your real admin user

The seed creates `crmadmin@gmail.com / NewMani!23` as the super-admin. **Change it immediately** after first login (Admin · Users → reset-password), or run the seed against a fresh DB and supply your own credentials.

---

## Part B — Frontend on Vercel

### B1. Create the Vercel project

1. Go to https://vercel.com → **Add New → Project** → import this repo.
2. Vercel auto-detects Next.js. Settings:
   - **Framework**: Next.js (auto-detected)
   - **Root Directory**: `web` ← **important** (otherwise Vercel tries to build `api/`)
   - Leave Build / Output / Install commands at defaults.

### B2. Add environment variables

In Vercel → your project → **Settings → Environment Variables**:

| Var | Value | Scope |
|---|---|---|
| `API_URL` | `https://<your-app>.onrender.com` | **Production** + **Preview** + **Development** — used by Server Components |
| `NEXT_PUBLIC_API_URL` | `https://<your-app>.onrender.com` | **Production** + **Preview** + **Development** — used by client-side fetches |

Both must point at the **same** origin. `NEXT_PUBLIC_*` is baked into the client bundle at build time, so any change requires a redeploy.

### B3. Deploy

Vercel auto-deploys on every push to `main`. PRs get preview URLs.

After the first deploy:
1. Note the production URL (`https://<your-app>.vercel.app`).
2. Go back to **Render → API service → Environment** and set `CORS_ORIGIN` to that exact URL (comma-separated if you also have a custom domain or preview URL pattern).
3. **Manual Deploy → Clear cache and deploy** on Render so the new CORS rule takes effect.

### B4. Smoke test

Visit `https://<your-app>.vercel.app`. You should hit `/login`. Sign in with the seeded credentials, then walk through:

1. **/leads** — list renders, click a lead.
2. **/records/[lead]** — inline-edit a field; activity timeline shows the diff.
3. **/timesheet** — add a block, confirm it appears under the right day.
4. **/admin/users** — create a test user, assign clients, deactivate, re-activate.

If anything fails, the most common issues:

- **"Not authenticated" on every request** → cookie isn't reaching the API. Confirm `NODE_ENV=production` on Render (which switches the cookie to `SameSite=None; Secure`) and that the API is reachable over **HTTPS** (Render's `.onrender.com` is HTTPS by default).
- **CORS error in browser console** → `CORS_ORIGIN` on Render doesn't match the Vercel URL exactly (no trailing slash, must be `https://`). Add the URL, hit Manual Deploy.
- **`fetch failed` / 500 from a page** → `API_URL` env var is wrong, or Render service is asleep (cold start; retry once).
- **DB error in Render logs** → Azure firewall is blocking Render's IPs (see A3).

---

## Part C — Domains (optional)

### Custom domain on Vercel
- Vercel → project → **Settings → Domains** → add `crm.yourdomain.com` → follow DNS instructions.
- Update `CORS_ORIGIN` on Render to include the new domain (comma-separated with the default vercel.app URL during the cutover).

### Custom domain on Render
- Render → service → **Settings → Custom Domains** → add `api.yourdomain.com`.
- Update `API_URL` and `NEXT_PUBLIC_API_URL` on Vercel to the new URL → redeploy.

---

## Day-2 ops

- **Adding a migration**: drop a new `post-NNNN-*.sql` under `api/drizzle/`, ensure it's idempotent (`IF NOT EXISTS`, `DO $$ … pg_constraint check`, etc.). On the next push, run `npm run db:migrate` against prod once.
- **Rotating the AI key**: Render → Environment → update `ANTHROPIC_API_KEY` → Manual Deploy (or wait ~30 s for the rolling restart).
- **Inspecting prod logs**: Render → service → **Logs**. Vercel → project → **Logs** (stream from any deployment).
- **Promoting a preview**: in Vercel, Preview deployments use the same `NEXT_PUBLIC_API_URL` you set above (i.e. **prod API**) — fine for read-only smoke tests, **dangerous for write operations**. If you want a true staging environment, see below.

---

## What this deployment doesn't do

- **No staging environment** — the cleanest way to add it is a `staging` branch + a second Render + Vercel project pointing at a separate database.
- **No GitHub Actions** — pushes go to Vercel/Render directly via their git integrations. Add CI later if you want pre-merge typecheck/build gates.
- **No automated DB backups** — Azure Postgres has automated PITR backups by default; verify retention in the portal under `de-crm-pg` → Backups.
- **No managed observability** — Render has a free `Service Metrics` tab, Vercel has `Analytics` ($). If you outgrow them, Sentry + Vercel Analytics is the usual upgrade.
