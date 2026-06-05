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
   - **Plan**: Free

### A2. Add environment variables

In Render → your service → **Environment**:

```
DATABASE_URL          postgres://decrm_admin:<password>@de-crm-pg.postgres.database.azure.com:5432/postgres?sslmode=require
APP_DATABASE_URL      postgres://decrm_app:<password>@de-crm-pg.postgres.database.azure.com:5432/postgres?sslmode=require
DECRM_APP_PASSWORD    <password for decrm_app>
PORT                  10000
CORS_ORIGIN           https://<your-app>.vercel.app
NODE_ENV              production
```

> Render injects `PORT=10000` automatically. Our `api/src/index.ts` already reads `process.env.PORT`, so no code change is needed.

### A3. Allow Render's outbound IP through Azure firewall

Render free tier doesn't pin outbound IPs (they rotate). Two options:

- **Easy**: in Azure Portal → `de-crm-pg` → Networking → enable **"Allow public access from any Azure service within Azure to this server"**. This lets every Render container reach the DB. Combined with `decrm_app`'s strong password and SSL-required, it's acceptable for a small project. (Don't use admin creds in the app config.)
- **Strict**: pay for Render's Static Outbound IP ($7/mo per service) and whitelist that IP exclusively.

### A4. Deploy

Push `main` → Render auto-builds and deploys. First deploy takes ~3-5 min. You'll see logs in real time. Healthcheck:

```
curl https://<your-app>.onrender.com/health
# → {"ok":true,"db":{"now":"…"}}
```

> **Free tier caveat**: services sleep after 15 min idle. First request after sleep takes ~30 s to wake. For demos, ping `/health` from a cron service like https://cron-job.org every 10 min, or upgrade to Starter ($7/mo) for always-on.

### A5. Run migrations against the deployed DB

Migrations don't run automatically. From your local machine, **once**, with the `DATABASE_URL` pointing at Azure:

```bash
cd api
npm run db:migrate    # applies any new SQL files
npm run db:seed       # OPTIONAL — only on a fresh DB you want demo data on
```

Or trigger it from Render: **Shell** tab → `npm run db:migrate`.

---

## Part B — Frontend on Vercel

### B1. Create the Vercel project

1. Go to https://vercel.com → **Add New → Project** → import this repo.
2. Vercel will detect Next.js. Settings:
   - **Framework**: Next.js (auto-detected)
   - **Root Directory**: `web` ← **important** (otherwise Vercel tries to build `api/`)
   - Leave Build / Output / Install commands at defaults.

### B2. Add environment variables

In Vercel → your project → **Settings → Environment Variables**:

```
API_URL                  https://<your-app>.onrender.com    # used by Server Components
NEXT_PUBLIC_API_URL      https://<your-app>.onrender.com    # used by client-side fetches
```

Apply both to **Production**, **Preview**, and **Development**.

### B3. Deploy

Vercel auto-deploys on every push to `main`. PRs get preview URLs.

After the first deploy:
1. Note the production URL (`https://<your-app>.vercel.app`).
2. **Go back to Render → API service → Environment** and set `CORS_ORIGIN` to that exact URL.
3. **Redeploy the API** so the new CORS rule takes effect.

### B4. Smoke-test

Visit `https://<your-app>.vercel.app/leads`. If you see the lead list, you're done.

If it fails, the most common issues:
- **CORS error in browser console** → `CORS_ORIGIN` on Render doesn't match the Vercel URL exactly (no trailing slash, must be `https://`).
- **`fetch failed` / 500 on `/`** → `API_URL` env var is wrong, or Render service is asleep (cold start).
- **DB error in Render logs** → Azure firewall is blocking Render's IPs (see A3).

---

## Part C — Domains (optional)

### Custom domain on Vercel
- Vercel → project → **Settings → Domains** → add `crm.yourdomain.com` → follow DNS instructions.
- Update `CORS_ORIGIN` on Render to match.

### Custom domain on Render
- Render → service → **Settings → Custom Domains** → add `api.yourdomain.com`.
- Update `API_URL` and `NEXT_PUBLIC_API_URL` on Vercel to the new URL → redeploy.

---

## What this deployment doesn't do

- No Auth0 — auth is still bypassed in the app code (`tenantMiddleware` resolves to the single seeded tenant).
- No GitHub Actions — pushes go to Vercel/Render directly via their git integrations.
- No backups — Azure Postgres has automated PITR backups by default; verify retention in the portal.
- No staging environment — the cleanest way to add it is a `staging` branch + a second Render + Vercel project pointing at a separate database.
