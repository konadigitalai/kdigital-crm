# Express → Next.js Migration Plan

> **Status:** Proposal, not approved work. Written 2026-08-04 alongside the
> performance work described in Part 1.
> **Recommendation up front:** ship the performance work, measure for a week,
> and only then decide whether this migration is still worth doing.

---

## Part 1 — Performance work already completed

Context for why this plan opens with "wait." The CRM was reported as slow while
running on paid tiers, so cold starts were not the explanation. Investigation
found two root causes, neither of which was the web framework.

### Root cause 1 — the deployment spanned three continents

No region was pinned anywhere, so Vercel functions defaulted to `iad1`
(Washington DC), while Render ran in Singapore and Azure Postgres in Central
India. Every browser-side call followed the `/api/:path*` rewrite in
`web/next.config.mjs` along this path:

```
Browser (India) → Vercel iad1 (Washington DC) → Render (Singapore) → Azure PG (Central India)
     ~250ms                    ~230ms                   ~60ms
```

That is roughly 540 ms of pure network before a single query executed, and
Server Component fetches still paid the ~230 ms DC→Singapore leg on every call.

### Root cause 2 — external API calls held open database transactions

`withTenant` in `api/src/db/app.ts` holds a pooled connection inside an open
transaction for the whole of its callback. Four code paths were performing
network I/O inside that callback:

| Path | Call held inside the transaction | Typical duration |
|---|---|---|
| `routes/twilio.ts` | `sendMessage` → Twilio API | 300–800 ms |
| `routes/gmail.ts` | OAuth refresh + `sendRaw` → Gmail API | 300 ms – 2 s |
| `routes/exotel.ts` | `initiateCall` → Exotel API | 300–800 ms |
| `agents/runtime.ts` | An entire LangGraph LLM run | seconds to tens of seconds |

With a pool of 10, a handful of concurrent agent runs could occupy every
connection and stall every unrelated request in the process. This presents as
"the whole app got slow" with no single slow endpoint, which is what makes it
hard to diagnose from the outside.

### Changes made

| File | Change |
|---|---|
| `web/vercel.json` *(new)* | Pin Vercel functions to `bom1` (Mumbai) |
| `web/src/app/layout.tsx` | `preferredRegion = ["bom1"]` as a second fence |
| `api/src/db/app.ts` | Pool 10 → 20 via `DB_POOL_MAX`; idle/connect timeouts; pool-wait warning; new `tenantExec()` helper; documented the "no network I/O inside `withTenant`" contract |
| `api/src/routes/twilio.ts` | Both send paths restructured to read → commit → send → record |
| `api/src/routes/gmail.ts` | Same; token refresh now uses `tenantExec` |
| `api/src/routes/exotel.ts` | Same |
| `api/src/agents/runtime.ts` | LLM streaming no longer holds a transaction |
| `api/src/lib/campaigns/worker.ts` | `FOR UPDATE OF cr SKIP LOCKED` claim + sends moved outside the transaction |
| `api/src/lib/timing.ts` *(new)* | Per-request `Server-Timing` header splitting db / pool-wait / other; slow-request logging |
| `api/src/index.ts` | Mounts the timing middleware; exposes `Server-Timing` through CORS |
| `web/src/lib/api.ts` | `timedFetch` slow-fetch logging; tagged cache on catalog/programs/courses |
| `web/src/lib/revalidate.ts` *(new)* | Server Action that busts the reference-data cache tag on write |
| `web/src/app/(app)/staffing/requisitions/[id]/page.tsx` | Two independent fetches now run in parallel |

**Verified:** `api` typechecks clean, `web` typechecks clean, `next build`
succeeds.

### Two bugs fixed along the way

**Agent-run failures were being rolled back.** The failure bookkeeping in
`runWithGraph` ran inside the transaction that then rethrew, so `withTenant`
rolled the status update back. Failed runs were left stuck in `running`
indefinitely. They now persist correctly.

**The campaign worker could double-send.** The claim query selected pending
recipients with no row locking, and the pre-send `UPDATE` had no status guard:

```sql
-- before: two workers select the same rows, both pass the update, both send
SELECT ... WHERE cr.status = 'pending' ORDER BY cr.queued_at LIMIT $2;
UPDATE campaign_recipient SET status = 'sending' WHERE id = $1;
```

```sql
-- after: disjoint batches, and the loser updates zero rows
SELECT ... WHERE cr.status = 'pending' ORDER BY cr.queued_at LIMIT $2
  FOR UPDATE OF cr SKIP LOCKED;
UPDATE campaign_recipient SET status = 'sending'
  WHERE id = $1 AND status = 'pending' RETURNING id;
```

This was latent rather than live — Render runs a single instance — but it meant
the system could never be scaled horizontally without sending duplicate
WhatsApp and SMS messages to real people and being billed twice. That hidden
coupling is now removed.

### Investigated and ruled out — do not re-examine

- **Index coverage** — 257 `CREATE INDEX` statements across migrations, 180 in
  `schema.ts`. Healthy.
- **N+1 query loops** — searched all 46 routers for awaited queries inside
  loops. None found.
- **Frontend fetch waterfalls** — 25 of 51 pages already used `Promise.all`;
  only the staffing requisition page had a meaningful sequential chain, now
  fixed.

### Outstanding before deploy

- [ ] Smoke-test all four send paths — Twilio, Gmail, Exotel, and a
      two-recipient campaign. These were **restructured, not lightly edited**.
- [ ] Nothing is committed yet; all changes sit uncommitted on `dev`.

### Infrastructure changes still required (not code)

1. **Move the API to Central India.** Render has no Indian region, which is why
   it sits in Singapore. Azure Container Apps in Central India would put the API
   next to the database and collapse the last two network hops to sub-5 ms.
2. **Optionally serve the API from `api.<domain>`.** Same registrable domain
   means cookies are first-party, which removes the reason the `/api/*` rewrite
   exists and deletes a Vercel function invocation from every browser call.

---

## Part 2 — The migration plan

### What this actually means

Node remains the runtime in both cases. What changes is the HTTP framework:
Express is replaced by Next.js App Router route handlers.

| Layer | Fate |
|---|---|
| Node 20 runtime | Unchanged |
| **Express** (`app.use`, routers, `req`/`res`) | **Replaced by Next route handlers** |
| Drizzle + `schema.ts` | Moves as-is, untouched |
| `api/src/lib/**` business logic | Moves as-is, untouched |
| `middleware/auth.ts` | Rewritten — same `jose` JWT verify, as a called function not middleware |
| `middleware/require.ts` | Rewritten as a handler wrapper |
| `index.ts` (mounting, CORS, body parsers, `listen`) | Deleted; file-system routing replaces all 341 lines |
| The three `setInterval` workers | Cannot move — no long-running process to host them |

The signature change hits all 18.6k LOC of routes:

```ts
// Express (today)
router.get("/:id", async (req, res) => {
  const lead = await withTenant(req.tenantId!, db => findLead(db, req.params.id));
  res.json(lead);
});

// Next route handler
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const { tenantId } = await requireAuth(req);          // was middleware
  const lead = await withTenant(tenantId, db => findLead(db, params.id));
  return Response.json(lead);                            // Web-standard Response
}
```

Two consequences that surprise people:

**File explosion.** An Express router packs many handlers into one file —
`routes/leads.ts` is 2,023 lines covering a dozen paths. Next needs one
`route.ts` per path segment. The 46 routers become a few hundred files.

**The middleware chain does not survive.** This is the central risk and gets its
own phase below.

---

### Phase 0 — Gate: do not start until this is true

Deploy the Part 1 work and read the numbers for a week. `Server-Timing` now
reports exactly where each request spends its time. **If the region pin
recovered most of the latency, the primary argument for this migration
disappears.**

Also required: **≥60% route test coverage.** This is a rewrite of the HTTP layer
of a live CRM holding lead and learner PII. Without tests it is a
rewrite-and-pray.

---

### Phase 1 — The guard harness (1 week — do this first)

Today, one line protects an entire router:

```ts
app.use("/leads", readWriteDelete("leads.read", "leads.write", "leads.delete"), leadsRouter);
```

Next has no mount point. Every one of the few hundred handlers must invoke its
own guard, and **a forgotten guard is a silently unprotected endpoint** — no
error, no test failure, just an open door. The permission surface is
fine-grained (`permissions.ts` is 522 lines, with gates like `staffing.decide`
controlling hire/reject decisions), so there is a great deal to not drop.

Build, in this order:

1. `withPerm(perm, handler)` returning `(req, ctx) => Response`, wrapping the
   JWT verification currently in `middleware/auth.ts`.
2. **An ESLint rule that fails the build** on any exported `GET`/`POST`/
   `PATCH`/`DELETE` not wrapped in `withPerm`.
3. A test that enumerates every route file and asserts an unauthenticated call
   returns 401.

**Do not port a single route until the lint rule reports violations as errors.**
Everything downstream depends on this being mechanical rather than remembered.

---

### Phase 2 — Infrastructure (1 week, can run parallel with Phase 1)

Three things must exist before any route moves:

- **Connection pooling.** Serverless plus Azure Flexible Server is precisely the
  problem Render currently shields you from. PgBouncer, or Vercel Fluid compute.
  One piece of luck: `withTenant`'s `SET LOCAL` is transaction-scoped and
  survives a transaction-mode pooler unchanged.
- **Redis** (Upstash or Vercel KV) for the four rate limiters in `intake.ts`,
  `exotel.ts`, `exotel-webhook.ts` and `twilio-webhook.ts`. Each serverless
  invocation gets a fresh in-memory `Map`, so they silently become no-ops —
  including the one protecting the public lead-intake endpoint.
- **A scheduler** — QStash, Inngest, or Trigger.dev. Vercel Cron's one-minute
  floor cannot serve the campaign worker's 5-second tick.

---

### Phase 3 — Port in risk order (4–6 weeks)

| Wave | Routes | Rationale |
|---|---|---|
| 1 | `/summary`, `/catalog`, `/programs`, `/courses` | Read-only, low blast radius — proves the harness |
| 2 | `/leads`, `/pipeline`, `/records`, `/cases` | The core, heaviest surface |
| 3 | `/learners`, `/enrollments`, `/lms`, `/staffing`, `/accounts` | Bulk, mechanical by this point |
| 4 | `/twilio`, `/gmail`, `/exotel`, `/campaigns` | Highest risk — real money, real messages |

Run both stacks side by side and shift traffic per-route using the rewrite in
`next.config.mjs`. Every wave is independently revertible: backing one out is a
config change, not a rollback.

---

### Phase 4 — What stays on Express, probably permanently

- `/webhooks/twilio` — needs the raw body for HMAC-SHA1 signature verification
- `/webhooks/exotel` — needs a stable IP for its allowlist
- The three `setInterval` workers — campaign dispatch (5 s), Gmail poll (60 s),
  party dedup (6 h)

A small always-on container for these is the **correct** architecture, not a
failure to finish the migration.

---

## Cost / benefit

**Estimated effort: 8–10 weeks** including Phases 0–2.

**Benefit:** roughly $7/month, one fewer deployment target, and a single
codebase with a single mental model.

**Cost:** two months rewriting the HTTP layer of a working system, carrying the
silent-failure risks in Phase 1 (unguarded endpoints) and Phase 2 (no-op rate
limiters).

### Recommendation

Ship the Part 1 work, measure, and revisit in a month. The system's actual
problem was that it was deployed on the wrong continent, not that it uses
Express.

If the single-codebase benefit is wanted sooner, a defensible reduced scope is
**Phases 1–2 and Wave 1 only** — about three weeks. That delivers the guard
harness and the infrastructure, and leaves the decision to continue or stop
open with no sunk cost either way.
