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

## Twilio (SMS + WhatsApp) — local testing

The `/twilio` outbound and `/webhooks/twilio` inbound routes use these env
vars. All required.

```
TWILIO_ACCOUNT_SID=AC...                 # from Twilio Console → Account Info
TWILIO_AUTH_TOKEN=...                    # secret; keep out of source
TWILIO_SMS_FROM=+15551234567             # a Twilio-owned SMS number
TWILIO_WHATSAPP_FROM=+14155238886        # WhatsApp sandbox or approved WA number (no whatsapp: prefix)
TWILIO_WEBHOOK_URL=https://<ngrok>.ngrok-free.app/webhooks/twilio
                                         # MUST byte-match what Twilio Console has registered;
                                         # used for HMAC signature verification
```

Missing any of these → `POST /twilio/send` returns `503 Twilio not configured` with a clear list.

### End-to-end local flow (Windows, ngrok)

1. **Auth0**: grant `messaging.read` and `messaging.send` to your user (or the "Administrators" role). Otherwise the FE renders read-only.
2. **API + web**: `npm run dev` in `api/` (port 4000) and separately in `web/` (port 3000).
3. **Public URL**: `ngrok http 4000` → copy the HTTPS URL, e.g. `https://abc.ngrok-free.app`.
4. **Env**: paste the five `TWILIO_*` vars into `api/.env` (using the ngrok URL) and **restart the API** — env is only read at boot.
5. **Twilio Console** (`console.twilio.com`):
   - Phone Numbers → your SMS number → *A message comes in* webhook: `https://abc.ngrok-free.app/webhooks/twilio` (HTTP POST).
   - Messaging → WhatsApp Sandbox → *When a message comes in*: the same URL.
   - Join the sandbox from your phone: send `join <sandbox-code>` (Twilio shows the code) to `+1 415 523 8886`.
6. **Outbound test**: open a lead in the CRM → click **Send message** → toggle SMS or WhatsApp → send. Your phone should receive it within a few seconds.
7. **Inbound test**: reply from your phone. `/inbox` shows the thread within ~5 s; the lead's **Messages** tab shows the reply.
8. **Signature check**: change `TWILIO_WEBHOOK_URL` to a wrong value → replay a webhook from Twilio Console → API returns 403 (signature mismatch). Restore the env and try again.

### Gotchas

- **ngrok URL rotates** on free-tier restart — you'll need to update `TWILIO_WEBHOOK_URL` AND Twilio Console AND restart the API each time. Paid ngrok gives a stable subdomain.
- **WhatsApp 24 h window**: Twilio only accepts freeform WA messages within 24 h of the customer's last reply. Outside that, the send fails with error code **63016** — the CRM surfaces the error inline. Templates (which work outside 24 h) are deferred to v2.
- **Idempotency**: `tw_message.provider_message_id` is `UNIQUE`. Twilio retries webhooks on any non-2xx, so we always return 200; duplicate SIDs are dropped by `ON CONFLICT DO NOTHING`.
- **Unknown senders**: an inbound from a phone that doesn't match any party creates a stub `party (name='Unknown +E164')` and a `tw_conversation` with `is_unlinked=true`. The inbox shows a **Promote to lead** button in the thread header (needs `leads.write`).
- **Multi-tenant**: the webhook currently routes to `DEFAULT_TENANT_ID` (or the newest tenant). Real multi-tenant routing needs a `To`-number-to-tenant map — not shipped yet.

## Why RLS uses an "escape hatch"

Policies are `tenant_id = current_tenant() OR current_tenant() IS NULL`. The seed script and migration runner don't set the GUC, so the second clause lets them through. The API will always set `app.tenant_id` per request (via `withTenant()` in `src/db/client.ts`), so the escape never fires for it.
