# Digital Edify — Agentic CRM

Single Next.js app, one deployment target:

| Layer | Path | Stack | Hosted on |
|---|---|---|---|
| Frontend | `web/src/app`, `web/src/components` | Next.js 15 · React 19 · Tailwind 3 | Vercel |
| API | `web/src/server` | Node 20 · Drizzle ORM | Vercel (route handlers) |
| Scheduled jobs | `web/src/app/api/cron` | campaign dispatch · Gmail poll · party dedup | Vercel Cron |
| Database | (external) | Azure Postgres Flexible Server 17 + pgvector | Azure |

The API used to be a separate Express service on Render. It now runs as Next.js route
handlers in this same project — `web/src/server/app.ts` holds the mount table (and with
it, every permission guard), and `web/src/server/http/` is the small Web-standard router
that replaced Express.

See [`instructions.txt`](./instructions.txt) for the day-to-day local dev runbook.

## Quick links

- Architecture: `project docs/01_Application_Architecture.md`
- Data model: `project docs/03_Data_Model.md`
- Build plan: `project docs/05_Build_Plan.md`

## Local development

One terminal — the API is served by the same dev server as the app:

```bash
cd web

npm run db:check    # DB sanity check (one-time)
npm run dev         # app + API together on http://localhost:3000
                    #   pages     → /
                    #   API       → /api/**
                    #   cron jobs → /api/cron/*  (run by hand; see below)
```

`web/.env.local` is required — see `web/.env.example`. It now needs the API's
variables too (`APP_DATABASE_URL`, `AUTH0_*`, `ANTHROPIC_*`, `INTAKE_API_KEY`,
`CRON_SECRET`, …), since there's no separate `api/.env` any more.

There is no background worker process in dev. The three scheduled jobs are ordinary
endpoints, so trigger them when you need them:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/campaigns
```

Campaign dispatch also fires automatically when you launch or resume a campaign, so
in practice you rarely need to call it by hand.

## Deployment

See [`DEPLOY.md`](./DEPLOY.md).
