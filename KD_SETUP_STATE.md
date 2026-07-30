# KDigital CRM — replication state & handoff

**Purpose:** hand this to a fresh Claude Code session so it can pick up mid-replication without re-deriving anything.
**Contains no secrets.** Passwords and client secrets live in your own scratch file and in DE's `api/.env`.

---

## What this project is

Replicating the Digital Edify Agentic CRM into an independent stack for the sister company **KDigital**: own GitHub repo, own databases, own Auth0, own Vercel and Render deployments.

- **Source repo:** `konadigitalai/digitaledify-agentic-crm` @ branch `dev`, commit `0cbf0dc`
- **Target repo:** `konadigitalai/kdigital-crm` — this checkout
- **Local paths:** DE working copy at `C:\Users\EswarSaiBandi\Desktop\DE_CRM`, KD at `C:\Users\EswarSaiBandi\Desktop\KDIGITAL_CRM`
- **Reference docs (in the DE checkout, untracked):**
  - `DE_CRM/docs/KD_CRM_Replication_Runbook.md` — the full 8-step runbook
  - `DE_CRM/docs/kd-scrub.sql` — the post-restore data scrub, already applied
  - `DE_CRM/DEPLOY.md` — DE's original deployment runbook (partly out of date; see below)

## Decisions locked

| Decision | Choice |
|---|---|
| Branches | `dev`, `qa`, `main` all identical to DE `dev` |
| Databases | 2, both on DE's existing Azure server `de-crm-pg` — `kdcrm_dev` (dev + qa) and `kdcrm_prod` |
| Initial data | pg_dump of DE dev, restored, then scrubbed — **and the catalog wiped too**, so zero DE data remains |
| Auth0 | **Two tenants** — `kdigital-crm-dev` (local + dev + qa) and `kdigital-crm-prod` |
| Integrations | Twilio / Exotel / Gmail / Slack / Interakt / Blob all **left unset** at launch |

---

## Progress

### ✅ Step 1 — GitHub (done)

`konadigitalai/kdigital-crm` has `dev`, `qa`, `main` all at `0cbf0dc`. Remotes in this checkout:

```
origin    https://github.com/konadigitalai/kdigital-crm.git
upstream  https://github.com/konadigitalai/digitaledify-agentic-crm.git
```

Two commits exist on DE `main` only and were deliberately **not** carried over:
`a3a0513` fix(exotel): GET query-string webhook + Indian phone normalisation, and
`3ce7d02` feat(inbox): promote-to-lead opens the full New Lead dialog.

### ✅ Step 2 — Databases (done)

Both databases live on **`de-crm-pg.postgres.database.azure.com`** (PostgreSQL 17, Central India, Burstable B1ms) alongside DE's own `postgres` (DE dev) and `decrm_prod` (DE prod).

| Database | Used by |
|---|---|
| `kdcrm_dev` | local + Render dev + Render qa |
| `kdcrm_prod` | Render prod |

Roles are **server-level and shared with DE**: `decrm_admin` (migrations) and `decrm_app` (runtime, NOBYPASSRLS, RLS-enforced).

Both databases now contain only:

```
_decrm_post_migrations    81   migration ledger
agent                      7   agent definitions
checkpoint_migrations      5   LangGraph ledger
party_match_rule           4   dedup config
_decrm_one_time_migration  2   one-time markers
tenant                     1   "KDigital"
```

Everything else is 0 across all 75 tables — no people, no leads, no messages, no credentials, and no catalog.

**`DEFAULT_TENANT_ID = 2a33c6b4-f4e6-4f12-b2a9-0ab71433a7b3`** — identical in both databases (same dump).

`npm run db:migrate` reports `✓ no new post-*.sql migrations to apply` against both.

### ✅ Step 3 — Auth0 (dev tenant done)

Two tenants, each with: API `KDigital CRM API` (identifier `https://api.kdigital.com`, RBAC + "Add Permissions in the Access Token" both enabled), 30 permissions, an `Administrators` role, a Regular Web Application, the `Add CRM claims` post-login Action deployed **and attached to the post-login flow**, sign-ups disabled, and one admin user.

Callback / logout / origin URLs:

- **dev tenant** → `http://localhost:3000`, `https://kdigital-crm-dev.vercel.app`, `https://kdigital-crm-qa.vercel.app`
- **prod tenant** → `https://kdigital-crm.vercel.app` only

### 🟡 Step 4 — Local verification (all automated checks pass; browser login outstanding)

Done and verified:

- `api/.env` and `web/.env.local` created. DB creds reused from DE's `api/.env` — the roles are
  server-level and shared, only the database name differs (`kdcrm_dev`). `DECRM_APP_PASSWORD`
  deliberately **not** set (gotcha 1).
- Both roles connect to `kdcrm_dev`: `decrm_admin` and `decrm_app`. Tenant row reads back as
  `2a33c6b4-…` / "KDigital"; `party`/`app_user`/`lead`/`program` all 0, `agent` 7 — scrub confirmed.
- `npm run db:migrate` → `✓ no new post-*.sql migrations to apply` +
  `ℹ DECRM_APP_PASSWORD not set` (correct).
- **Grant defect found and fixed — see gotcha 9.**
- `curl localhost:4000/health` → `{"ok":true,"db":{"now":"…"}}`
- API log clean over 25 s of campaign-worker polling — **zero** `permission denied`. Check 8 passes.
- Build preflight (4.6) all three green: `api npm run build`, `web npx tsc --noEmit`, `web next build`.

Auth0 dev tenant is **`kdigital-crm-dev.au.auth0.com`** (note: `.au.`, not `.us.`). Both env
files are complete. Verified against the live tenant:

- OIDC discovery + JWKS reachable; issuer `https://kdigital-crm-dev.au.auth0.com/`.
- Client ID + secret authenticate (a `client_credentials` probe returns `access_denied`
  "no client-grant for this API" — that is the *correct* answer for a Regular Web App, and it
  proves both the credentials and the `https://api.kdigital.com` resource server exist).
- `http://localhost:3000/auth/callback` is registered — `/authorize` 302s to universal login
  rather than a callback-mismatch error.
- Web chain: `GET /` → 307 `/auth/login` → 307 Auth0 `/authorize` with the right
  `client_id`, `audience` and `redirect_uri`. **Check 2 passes.**
- API token validation: a token with the correct issuer + audience but a foreign signature is
  rejected with `no applicable key found in the JSON Web Key Set` — so the API is fetching and
  checking against this tenant's JWKS. Missing/garbage tokens give a clean `401`, never a `500`.

Both servers currently run locally: API `:4000`, web `:3000`.

**First login attempt got through Auth0 and then failed — two defects, see gotchas 10 and 11.**
Code fix for the crash is applied. **The Auth0 Action still needs fixing before logging in again.**

**Outstanding — requires a human in a browser** (checks 3–7): log in at `http://localhost:3000`
as the step-3.7 admin user, then confirm dashboard loads · lead count zero · Admin ▸ Users shows
the account as `admin` with a **real email, not `…@auth0.local`** · create + inline-edit a lead ·
Admin ▸ Integrations reports *not configured*.

Fresh secrets generated for local (do not reuse in Vercel/Render — mint new ones per env):
`INTAKE_API_KEY` and `AUTH0_SECRET` are already written into the two files.

### ⬜ Step 4.5 — `WORKERS_ENABLED` code change (must land before step 6)

### ⬜ Step 5 — Vercel, 3 projects

### ⬜ Step 6 — Render, 3 services

---

## Target names

| | dev | qa | prod |
|---|---|---|---|
| Branch | `dev` | `qa` | `main` |
| Database | `kdcrm_dev` | `kdcrm_dev` (shared) | `kdcrm_prod` |
| Auth0 tenant | `kdigital-crm-dev` | `kdigital-crm-dev` | `kdigital-crm-prod` |
| Vercel project | `kdigital-crm-dev` | `kdigital-crm-qa` | `kdigital-crm` |
| Render service | `kdigital-crm-api-dev` | `kdigital-crm-api-qa` | `kdigital-crm-api` |

---

## Step 4 — local verification

`api/.env` (create it — gitignored, nothing came across from DE):

```
DATABASE_URL=postgres://decrm_admin:<ADMIN_PWD>@de-crm-pg.postgres.database.azure.com:5432/kdcrm_dev?sslmode=require
APP_DATABASE_URL=postgres://decrm_app:<APP_PWD>@de-crm-pg.postgres.database.azure.com:5432/kdcrm_dev?sslmode=require

PORT=4000
CORS_ORIGIN=http://localhost:3000
WEB_APP_URL=http://localhost:3000
DEFAULT_TENANT_ID=2a33c6b4-f4e6-4f12-b2a9-0ab71433a7b3

AUTH0_DOMAIN=<dev tenant domain>
AUTH0_AUDIENCE=https://api.kdigital.com
AUTH0_PERMISSIONS_CLAIM=https://digitaledify.com/permissions

INTAKE_API_KEY=<fresh 64-hex>

AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=<key>
ANTHROPIC_BASE_URL=https://inference-api.nvidia.com
ANTHROPIC_MODEL=aws/anthropic/bedrock-claude-sonnet-4-6
```

⚠ **Do not put `DECRM_APP_PASSWORD` in this file.** See the shared-server warning below.

`web/.env.local`:

```
API_URL=http://localhost:4000
NEXT_PUBLIC_API_URL=http://localhost:4000

AUTH0_DOMAIN=<dev tenant domain>
AUTH0_ISSUER_BASE_URL=https://<dev tenant domain>
AUTH0_CLIENT_ID=<dev tenant client id>
AUTH0_CLIENT_SECRET=<dev tenant client secret>
AUTH0_AUDIENCE=https://api.kdigital.com
APP_BASE_URL=http://localhost:3000
AUTH0_SECRET=<openssl rand -hex 32>
```

Run:

```powershell
cd api ; npm install ; npm run dev      # :4000
cd web ; npm install ; npm run dev      # :3000
```

Checks: `/health` returns `{"ok":true,...}` · login redirects to Auth0 · dashboard loads with zero leads · Admin → Users shows your account as `admin` · Admin → Integrations reports *not configured* (clean 503) · no `permission denied for table …` in the API log.

**The catalog is empty**, so program/course/stack dropdowns will be blank. Create KDigital's own catalog in Admin before testing the lead flow — an empty dropdown here is expected, not a broken deployment.

---

## Gotchas discovered during this replication

**1. `DECRM_APP_PASSWORD` is server-level and shared with DE.**
`migrate.ts:105` runs `ALTER ROLE decrm_app WITH PASSWORD`. Because KD shares `de-crm-pg` with DE, setting this variable anywhere — local `.env` or any Render service — rewrites the password for DE production too. Never set it. The role already has the right password.

**2. The migration ledger travels in a pg_dump; the grants don't.**
`_decrm_post_migrations` is a normal table, so a restored database thinks `post-0006-app-role.sql` is applied and `db:migrate` skips it — but `pg_dump --no-privileges` stripped its GRANTs. Fix: run `psql -f api/drizzle/post-0006-app-role.sql` by hand. Already done for both KD databases. **This is necessary but not sufficient — see gotcha 9.**

**3. Azure system extensions break `pg_restore`.**
`azure` and `pgaadauth` are auto-installed by Azure and not allow-listed, so the dump's `CREATE EXTENSION` fails. Solution used: `pg_dump --exclude-extension='*'` and pre-create `pgcrypto`, `pg_trgm`, `vector` in the target.

**4. Auth0 JIT-provisions every valid token holder as `role = 'admin'`.**
`auth.ts:199`. Both tenants must keep database sign-ups disabled.

**5. The email claim namespace is hardcoded.**
`AUTH0_PERMISSIONS_CLAIM` is env-driven, but the email claim `https://digitaledify.com/email` is hardcoded at `auth.ts:79`. Both KD Auth0 Actions therefore use the `digitaledify.com` namespace deliberately. Changing it without editing that line provisions everyone with an `…@auth0.local` placeholder.

**6. dev and qa share one database, and the workers have no leader election.**
`startCampaignWorker()` and `startDedupWorker()` are unconditional `setInterval` loops in `api/src/index.ts:287-292`. Two Render services on `kdcrm_dev` means two workers on the same rows — duplicate WhatsApp sends once Twilio is configured. **Step 4.5 adds a `WORKERS_ENABLED` gate; QA must run with `WORKERS_ENABLED=false`.** Not yet implemented.

**7. Connection ceiling on the shared server.**
Each API instance opens two pools of `max: 10` (`db/client.ts:19`, `db/app.ts:17`). Five Render services (DE dev, DE prod, KD dev, KD qa, KD prod) share `de-crm-pg`'s `max_connections`, which is ~50 on B1ms. Check before step 6; scaling to B2s roughly doubles it. DE production is what fails first.

**8. `DEPLOY.md` is out of date.** It describes DE dev and prod sharing one database. They are actually separate: `postgres` and `decrm_prod`.

**9. `post-0006-app-role.sql` only grants 21 of 75 tables — 54 were left with no `decrm_app` privileges at all.** *(Found in step 4; fixed.)*

Gotcha 2 says to re-run `post-0006-app-role.sql` by hand. That was done — and it is not enough. post-0006 grants an explicit list of 21 early tables; **every later migration that adds a table carries its own GRANT**, and the restored ledger marks all 81 as applied, so `db:migrate` skips every one of them. Its `ALTER DEFAULT PRIVILEGES` doesn't help either — that only affects tables created *after* it runs, and these were restored from the dump.

The failure is quiet at first. `/health` uses the **admin** pool, so it returns `ok:true` while the app role is broken. What surfaced it was the API log:

```
[dedup-worker]    tenant 2a33c6b4-… error: permission denied for table party_match_rule
[campaign-worker] tenant 2a33c6b4-… permission denied for table campaign
```

Every route touching one of the 54 tables — campaigns, inbox, media, Slack, Gmail, cases, batches, learners, contact points, saved views — would have 500'd the same way.

Fix applied to **both** `kdcrm_dev` and `kdcrm_prod`: `DE_CRM/docs/kd-grant-fix.sql`. It grants the whole `public` schema, then trims back to match DE's exact shape (`audit_log` keeps INSERT+SELECT only; `seq_enrolment` is the one sequence with SELECT). Idempotent.

Verified by diffing `information_schema.role_table_grants` for `decrm_app` between DE dev and `kdcrm_dev`: **0 missing, 0 extra** across all 75 tables, and sequence grants identical.

Note the restart: GRANTs applied while the API was running did **not** take effect on the live pooled connections — the workers kept erroring until the process was restarted.

**10. The `kdigital-crm-dev` post-login Action is not putting claims on the access token.** *(Open — needs an Auth0 dashboard fix.)*

Step 3 recorded the Action as "deployed **and attached** to the post-login flow". The first real login proved otherwise. The access token reaching the API carries neither `email` nor `name`, and the API logged its own diagnostic:

```
[auth] Provisioning Auth0 user auth0|6a69f49c7f042b4a24602e53 with placeholder email
       auth0_6a69f49c7f042b4a24602e53@auth0.local. Update the Auth0 post-login Action to
       copy event.user.email into a 'https://digitaledify.com/email' claim on the access token.
```

This is gotcha 5 biting for real. Most likely cause is `api.idToken.setCustomClaim` instead of **`api.accessToken.setCustomClaim`** — the API only ever reads the access token. Second candidate: the Action was deployed to the Library but never dragged into the Login flow (deploying alone does nothing).

Note the knock-on: **permissions** ride the same Action. Until it fires, `AUTH0_PERMISSIONS_CLAIM` is empty too, so even a successful login would be authorised for nothing.

Fix the Action *before* logging in again. A login now provisions an `app_user` + `party` keyed off the placeholder `…@auth0.local` address. `app_user` self-heals its email on a later good login, but the **`party` row does not** — you'd be left with a junk party to clean up by hand.

**11. `provisionPartyForInternalUser` passes a null name into `party.name`, which is NOT NULL.** *(Found in step 4; code fix applied.)*

With the Action broken (gotcha 10) the JIT path passed `name = null`, and `party.name` is NOT NULL, so the insert aborted **inside the auth middleware** — meaning every request 500'd and the app was completely unusable:

```
ApiError: GET /agents/recent → 500:
  null value in column "name" of relation "party" violates not-null constraint
```

The helper's own docstring called name "nullable, but strongly recommended" — the schema disagrees. DE never hit this because all ten of its `app_user` rows have parties that already existed from the seed, so its JIT path always takes the *adopt-existing* branch and never inserts. A genuinely empty tenant is the only way to reach the insert, which is exactly what KD is.

Fixed in `api/src/lib/party/provision.ts` — falls back to the email's local part when no name is supplied. **Not yet ported to DE**; carry it forward with the step 4.5 change.

Worth knowing: a `tsx watch` hot-reload raced the port and left an orphan process holding `:4000`, so the old code kept serving after the edit. If a fix doesn't seem to take, kill the PID on 4000 and restart rather than trusting the watcher.

**12. The scrub's `TRUNCATE party … CASCADE` destroyed the post-0047 system sentinel party.** *(Found in step 4; fixed in both databases.)*

post-0047 creates one `is_system=true, kind='org', name='System'` party per tenant. It is the `actor_party_id` for every agent- and system-authored `activity` and `audit_log` row, so the CASCADE in `kd-scrub.sql` took it out along with the DE customer data. The restored ledger lists post-0047 as applied, so `db:migrate` skips the repair.

Surfaced on the first attempt to create a lead:

```
POST /leads → 500: Party Model: no sentinel party found for tenant
              2a33c6b4-f4e6-4f12-b2a9-0ab71433a7b3. Did post-0047-party-sentinel.sql run?
```

Fixed by re-running `api/drizzle/post-0047-party-sentinel.sql` (idempotent) against both databases. Verified — one sentinel each:

| Database | Sentinel party id |
|---|---|
| `kdcrm_dev` | `78fab4bf-cf5b-4074-9947-0c28adde2d8f` |
| `kdcrm_prod` | `3c729665-872b-4027-a64a-906d8bda570a` |

`docs/kd-scrub.sql` now rebuilds the sentinel as its final step, so a future re-run can't repeat this.

I swept every other `post-*.sql` that seeds data to check for the same class of damage. Only the sentinel was a genuine loss. `user_group` / `user_group_permission` don't exist in either database (dropped by a later migration), and the empty `program` / `course` / `stack` / `cohort` / `batch_assignment` tables are the **deliberate** catalog wipe, not breakage.

---

## Step 4.5 — required code change

`api/src/index.ts:287-292`, currently unconditional:

```ts
const workersEnabled = process.env.WORKERS_ENABLED !== "false";
if (workersEnabled) {
  startDedupWorker();
  startCampaignWorker();
  startGmailWorker();
} else {
  console.log("[api] WORKERS_ENABLED=false — background workers not started");
}
```

Default-on so DE is unaffected. Ideally land it in DE `dev` first, then merge forward via `upstream`.

Two optional companions: make the email claim env-driven at `auth.ts:79`, and pull the hardcoded `"Kona OS - Edify"` branding out of `web/src/app/layout.tsx:7-8`.

---

## Steps 5 and 6 — summary

**Vercel:** 3 projects, **Root Directory `web`**, production branch `dev`/`qa`/`main`. Env: `API_URL`, `NEXT_PUBLIC_API_URL` (both → that env's Render URL), the five `AUTH0_*` vars, `APP_BASE_URL`, and a fresh `AUTH0_SECRET` per project.

**Render:** 3 Web Services, **Root Directory `api`**, build `npm install && npm run build`, start `npm run start`, Singapore. Env: `NODE_ENV=production` (required — flips the session cookie to `SameSite=None; Secure`), `DATABASE_URL`, `APP_DATABASE_URL`, `DEFAULT_TENANT_ID`, `CORS_ORIGIN`, `WEB_APP_URL`, the three `AUTH0_*` vars, `INTAKE_API_KEY`, the `ANTHROPIC_*` block, and `WORKERS_ENABLED` (`true`/`false`/`true`). No `DECRM_APP_PASSWORD`.

Full detail in `DE_CRM/docs/KD_CRM_Replication_Runbook.md`.
