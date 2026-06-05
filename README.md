# Digital Edify — Agentic CRM

Two-tier app:

| Layer | Path | Stack | Hosted on |
|---|---|---|---|
| Frontend | `web/` | Next.js 15 · React 19 · Tailwind 3 | Vercel |
| Backend | `api/` | Node 20 · Express · Drizzle ORM | Render (free tier) |
| Database | (external) | Azure Postgres Flexible Server 17 + pgvector | Azure |

See [`instructions.txt`](./instructions.txt) for the day-to-day local dev runbook.

## Quick links

- Architecture: `project docs/01_Application_Architecture.md`
- Data model: `project docs/03_Data_Model.md`
- Build plan: `project docs/05_Build_Plan.md`

## Local development

Three terminals:

```bash
# DB sanity check (one-time)
cd api && npm run db:check

# Backend
cd api && npm run dev      # http://localhost:4000

# Frontend
cd web && npm run dev      # http://localhost:3000
```

`api/.env` and `web/.env.local` are required — see `api/.env.example`.

## Deployment

See [`DEPLOY.md`](./DEPLOY.md).
