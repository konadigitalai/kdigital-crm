# DE CRM — Backend (api/)

Node 20 · TypeScript · Express · Drizzle ORM · PostgreSQL 16 (Azure Flexible Server / pgvector locally).

Schema follows `project docs/03_Data_Model.md` — full doc-03 model: tenant, party, work_item spine + class-table extensions, relationship graph, activity timeline, HITL approvals, audit log, embeddings (pgvector). Skips only the metadata layer and activity partitioning (earn each later per the build plan).

## One-time setup

### 1. Drop the password into `.env`

```
cp .env.example .env
# edit .env, replace YOUR_PASSWORD_HERE with the Azure admin password
```

### 2. Make sure your IP is allowed and extensions are enabled

In Azure Portal → server `de-crm-pg`:
- **Networking** → Firewall → "Add current client IP"
- **Server parameters** → search `azure.extensions` → set value to `PGCRYPTO,PG_TRGM,VECTOR` → Save (server restarts ~30s)

### 3. Verify connectivity

```
npm run db:check
```

Expects to print:

```
✓ connected: PostgreSQL 16.x
✓ extension pgcrypto
✓ extension pg_trgm
✓ extension vector
✓ database: postgres
```

If any extension is `MISSING`, fix step 2 and re-run.

### 4. Apply schema + seed

```
npm run db:migrate    # creates 21 tables + 5 post-migration scripts (extensions, sequences, RLS, audit immutability, updated_at triggers)
npm run db:seed       # tenant, 3 users, 12 leads, 6 agents, 4 agent runs, 4 activity items, 1 pending approval
```

Re-running `db:seed` is safe — it deletes all tenant data first.

### 5. Start the API

```
npm run dev
```

API listens on `http://localhost:4000`. Try `curl localhost:4000/health`.

## Switching to local Postgres (offline dev)

```
docker compose up -d        # from repo root — same pg16 + pgvector image
# in api/.env, change DATABASE_URL to:
#   postgres://decrm:decrm@localhost:5433/decrm
npm run db:check
npm run db:migrate
npm run db:seed
```

## Useful

- **Reset everything**: `npm run db:reset` (drops public schema). Then `db:migrate` + `db:seed` again.
- **Schema diff**: edit `src/db/schema.ts`, run `npm run drizzle:generate` — it produces a new SQL file under `drizzle/`.
- **Inspect DB**: `npx drizzle-kit studio` (opens a web UI at https://local.drizzle.studio).

## Why RLS uses an "escape hatch"

Policies are `tenant_id = current_tenant() OR current_tenant() IS NULL`. The seed script and migration runner don't set the GUC, so the second clause lets them through. The API will always set `app.tenant_id` per request (via `withTenant()` in `src/db/client.ts`), so the escape never fires for it.
