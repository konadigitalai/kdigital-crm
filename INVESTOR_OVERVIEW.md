# Digital Edify Agentic CRM
### A CRM where AI agents do the work, advisors do the judgment, and admins see everything.

---

> **The bold claim, in one line.**
> Six purpose-built AI agents handle the parts of sales nobody enjoys —
> drafting outreach, scoring intent, deciding what to do next, forecasting
> the month — while every customer-facing decision still passes through a
> human. Advisors get hours back. Admins get a real-time picture of the
> business. Investors get a system that compounds.

---

## Why this exists

Every coaching / training company in India runs the same playbook:

```
Lead lands  →  Advisor calls  →  Lead is "warm"  →  Advisor forgets
              ↓
              Manual notes in WhatsApp + Excel + Google Sheets
              ↓
              No-one knows what the pipeline actually looks like.
              No-one knows which leads are dying.
              No-one knows what's going to close this month.
```

The status quo isn't broken because advisors are bad. It's broken because
advisors are spending **40-60% of their day on work an AI can do better**
— drafting follow-ups, deciding who to call next, summarising what
happened in the last touch, computing this month's forecast. That work
happens in the advisor's head, in scattered tools, with no audit trail.

We built an agentic CRM that owns that 40-60%. The advisor stays in the
driver's seat — they approve everything that hits a customer — but they
never start from a blank page again.

---

## The product, at a glance

```
                     ┌──────────────────────────────────────┐
                     │                                      │
                     │        EDIFY CRM (multi-tenant)      │
                     │                                      │
   Advisor          ◄─┤  • Lead lifecycle (7-state pipeline) │─►   Admin
   /leads           ◄─┤  • Real-time kanban + drag-drop      │─►   /admin/users
   /pipeline        ◄─┤  • Inline-editable lead records      │─►   /admin/clients
   /records/[id]    ◄─┤  • Contact mgmt (CC + phone split)   │─►   /admin/timesheets
   /timesheet       ◄─┤  • Free-form timesheets + clients    │─►   /admin/reports
   /calendar        ◄─┤  • Calendar (D/W/M, RSVP, sessions)  │─►   /admin/cohorts
   /agents          ◄─┤  • Tickets + Learners + Approvals    │
                     │                                      │
                     │  ┌─────────────────────────────────┐ │
                     │  │     SIX AI AGENTS               │ │
                     │  │  Outreach · Scoring · NBA       │ │
                     │  │  Forecast · Edify chat · Gate   │ │
                     │  └─────────────────────────────────┘ │
                     │                                      │
                     │       Postgres + Row-Level Security  │
                     └──────────────────────────────────────┘
```

Two surfaces, one system. Advisors get a focused workspace. Admins get
an aggregate one. **The agents thread through both.**

---

# Part 1 — Six agents. One mission.

The agents are not a feature. They are the product.

Each agent has a single job, a constrained set of inputs, and a verifiable
output. They never invent customers, never invent prices, never invent
metrics. They're grounded in the tenant's actual data — and we ship a
verification step that *checks* the output against that data before it
reaches the screen.

Here they are.

---

## 1.  Outreach Agent
*Drafts the next-best touch for a lead. Advisor approves and sends.*

| Field | Value |
|---|---|
| **Replaces** | The 8-12 minutes an advisor spends drafting each follow-up |
| **Sees** | Lead profile, full activity timeline, last 3 touches, current rating, program of interest, advisor's prior tone |
| **Produces** | Subject line + email body (or WhatsApp variant), in the lead's language register |
| **Approval gate** | Yes — every draft sits in "Pending approvals" until a human clicks Approve & send |

**A real example:**

```
─────────────────────────────────────────────────────────────────
SUBJECT  Quick check-in re: Python · Aug-2026 cohort

Hi Harsha,

Last we spoke you mentioned the Aug 2026 morning batch felt right
for your schedule, and you wanted to clarify the EMI options before
making a call. I dug into our finance terms — 6-month no-cost EMI
is now available for the full ₹1.49L.

Want me to share the link?

— Priya

─────────────────────────────────────────────────────────────────
CITED
   ◆ Lead activity: "asked re: EMI" (2026-06-08)
   ◆ Program: Full Stack + AI · ₹1.49L
   ◆ Cohort: Python · Aug-2026 · Morning
─────────────────────────────────────────────────────────────────
```

Notice what's *not* here: invented dates, made-up financial terms, a
fictional urgency ("we only have 2 seats left!"). The agent draws from
the tenant's real catalog and the advisor's real notes. That's
intentional.

---

## 2.  Lead Scoring Agent
*Assigns a 0-100 score to every lead. Re-runs on every meaningful change.*

| Field | Value |
|---|---|
| **Replaces** | Gut-feel rating that varies by advisor and by mood |
| **Sees** | Timeline, notes, rating history, behaviour signals (page visits, demo attendance, reply latency) |
| **Produces** | Score 0-100 + ranked list of positive and negative signals + one-line description |
| **Triggers** | New activity on the lead · rating change · advisor edit · demo attended |

**A real example:**

```
─────────────────────────────────────────────────────────────────
SCORE   88  ·  Hot lead

POSITIVE SIGNALS
   + Visited pricing page in last 24h          +12
   + Replied to last touch within an hour       +9
   + Watched intro lesson  60%+                 +8
   + Demo attended on 2026-06-10                +6

NEGATIVE SIGNALS
   − Hasn't asked about timeline yet            −4
   − No referral in family/friends              −3

Why now: behavioural signals match the top-decile converted
leads from the last two cohorts.
─────────────────────────────────────────────────────────────────
```

The score is the **output**. The signals are the **explanation**. An
advisor who disagrees with the score can read the signal list and decide
whether to override. The score is never a black box.

---

## 3.  Next-Best-Action Agent (NBA)
*Tells the advisor what to do for this lead, right now.*

| Field | Value |
|---|---|
| **Replaces** | The "where do I start today?" mental scan that costs 10-15 min/morning |
| **Sees** | Same as Scoring + current pipeline state + advisor workload |
| **Produces** | One action, with a confidence percentage, a why, and a one-tap execute |
| **Action types** | Send email · Book demo · Apply EMI · Send payment link · Drip-only · Pause |

**A real example:**

```
─────────────────────────────────────────────────────────────────
NBA  ·  Karthik Nair  (LEAD-9788)
CONFIDENCE  91%

   Send the EMI clarification email Priya drafted.

WHY
   Lead is in 'hot', has explicitly asked re: EMI, and has not
   been touched in 38h. Drift risk is high — historically, hot
   leads not touched in 48h convert at 41% the rate of those
   touched within 24h.

ONE-TAP
   [Approve & send]   [Edit draft]   [Snooze 1d]
─────────────────────────────────────────────────────────────────
```

NBA is the difference between a CRM that *records* what happened and a
CRM that *tells* the advisor what to do. It's the agent the advisor
opens first every morning.

---

## 4.  Forecast Agent
*This month's pipeline → enrolment forecast. Numbers from SQL, narrative from Claude.*

| Field | Value |
|---|---|
| **Replaces** | The Friday-evening Excel exercise that's wrong by Monday |
| **Sees** | Every lead's rating, score, value, demo state, fee status — pulled by deterministic SQL |
| **Produces** | Numeric range + the qualitative reasoning behind it |
| **Refreshes** | On demand or on every pipeline-rating change |

**A real example:**

```
─────────────────────────────────────────────────────────────────
AUGUST ENROLMENT FORECAST   22 – 28

   Confirmed (paid)            14
   High-confidence (hot)        8  ± 2
   Stretch (warm + recent)      4  ± 4

NARRATIVE
   The number is anchored by 14 paid registrations.

   The 8 'hot' leads have above-average engagement on the AI
   track; based on similar cohorts we expect 6 to close before
   cutoff (2026-08-05).

   The stretch is 4 'warm' leads who attended demos but haven't
   responded in 5+ days. Without a re-engagement touch, treat
   these as 50/50.

ANTI-FABRICATION
   Every number above is derived from SQL. Claude generates
   the prose around them — but cannot change the numbers.
─────────────────────────────────────────────────────────────────
```

The wow here is the architecture: **the numbers are deterministic, the
narrative is generative**. An LLM cannot hallucinate a different
forecast — only a different way of describing the same one.

---

## 5.  Edify Chat Agent
*The home-page assistant. Knows your whole tenant. Cites its sources.*

| Field | Value |
|---|---|
| **Replaces** | The "let me ask the analyst" question that takes 4 hours to come back |
| **Sees** | Full tenant snapshot — leads, learners, tickets, batches, users, agent runs |
| **Produces** | Conversational answer with inline citations + a sidebar of past chats |
| **Persistence** | Sessions stored in DB, Claude-style sidebar, "New chat" button |
| **Stop / edit** | The user can stop generation mid-stream and edit-and-resend the latest prompt |

**A real session:**

```
─────────────────────────────────────────────────────────────────
You
   How many hot leads do we have, and which ones are at risk?

Edify
   8 leads are currently rated 'hot' or 'superhot'.

   Of these, 3 haven't been touched in over 48 hours:

      ◆ Karthik Nair   (LEAD-9788)  · last touched 67h ago
      ◆ Priya Reddy    (LEAD-9601)  · last touched 51h ago
      ◆ Arjun Bose     (LEAD-9512)  · last touched 49h ago

   Suggested action: run the Outreach Agent on all three. The
   NBA Agent has already drafted touches for two of them — you'll
   see them under 'Pending approvals' on your home page.

CITED
   /pipeline · /leads · /agents/runs · /approvals
─────────────────────────────────────────────────────────────────
```

The chat is the **umbrella**. It can read across every other agent's
output, and it can invoke them. It's the closest thing to a "second
employee" we ship.

---

## 6.  The Approval Gate
*Not an agent that talks. An agent that listens.*

The Outreach Agent doesn't send. The NBA Agent doesn't fire actions.
The Forecast Agent doesn't change rating. **Every customer-facing
output is intercepted by the approval layer and held until a human
clicks Approve.**

```
   AGENT proposes  ──►   APPROVAL  ──►   HUMAN reviews  ──►   Action fires
                          QUEUE             OR REJECTS         (logged + audited)
```

This is the line we won't cross. AI proposes. Humans dispose.
Every approval (or rejection) is logged in the activity timeline,
forever.

---

# Part 2 — Two days in the life

The agents are levers. The system is what happens when an actual human
pulls them. Here are two real days, told from inside the product.

---

## Day in the life — Priya, advisor

```
07:45 IST   Logs in. Home page = Edify chat with yesterday's sidebar.
            4 new lead notifications · 2 pending approvals.

08:00 IST   /pipeline. Drags two 'warm' leads to 'hot' after weekend
            WhatsApp chats.
            ▶ Lead Scoring Agent re-runs on each.
              Karthik 71 → 84.  Sneha 64 → 78.
            ▶ NBA Agent regenerates a fresh action card for both.

08:15 IST   /records/LEAD-9788  (Karthik).
            Outreach Agent has a draft waiting in 'Suggested touches'.
            She tweaks one line. Approve & send.
            ▶ Activity timeline logs:
              "AI · Drafted email"  →  "You · Approved & sent"

09:30 IST   /timesheet. Adds blocks for the morning's calls. Each block
            tagged: client (Globex), one-line note. 1.5h logged.

10:00 IST   Demo session for cohort 'AI · Aug-2026 · AM'.
            ▶ Calendar shows the session automatically — she's the trainer
              on that batch. Co-trainer Rahul sees it on his calendar too.

12:30 IST   /agents/edify
              "Which leads attended a demo this week but haven't been
               touched since?"
            ▶ Edify returns 4 names with last-touch deltas. She runs
              the Outreach Agent on all four. Drafts queue up for review.

14:00 IST   Lead Sneha replies. Her record auto-updates.
            ▶ Lead Scoring Agent re-scores: 78 → 91.
            ▶ NBA Agent now suggests: "Send payment link."

15:00 IST   Approves the four Outreach drafts in one go.
            Each goes into the activity log with a 'You · Sent' entry.

17:00 IST   /timesheet. Reviews her day: 6h across 3 clients.
            Marks tomorrow afternoon as half-day leave.
            Admin sees it instantly on /admin/timesheets.

17:15 IST   Logs out. Tomorrow's NBA cards are already pre-computed.
```

She did 12 high-judgment actions. The agents handled ~40 low-judgment ones
in the background.

---

## Day in the life — CRM Admin

```
09:00 IST   Logs in. Home page = Edify chat.

09:01 IST     "How did the team do this week vs. last week?"

            ▶ Edify pulls /admin/reports/timesheets and /pipeline:
              "Team logged 178h vs. 164h last week. Acme Corp gained
               12h, Globex lost 4h. Pipeline added 8 new hot leads,
               lost 3 to attempted-cold."

09:30 IST   /admin/reports/timesheets
            Pivot grid: rows = users, cols = clients, cells = hours.
            Filters: Last 30 days · Globex only.
            Hits Export CSV. Sends to finance for invoicing.

10:00 IST   /admin/users → New user.
              Name: Anil  ·  Role: advisor  ·  Groups: Advisors
              Clients: Globex, Acme Corp
            New advisor signs in → /me/clients shows just those two.
            All other clients invisible to him.

11:00 IST   /admin/clients → marks 'Initech' inactive.
            Existing timesheet entries preserved (audit trail intact).
            'Initech' disappears from new-block dropdowns.

14:00 IST   /admin/cohorts → New batch.
              Name:        AI · Aug-2026 · AM
              Course:      Full Stack + AI
              Trainer:     Priya N.
              Co-trainer:  Rahul
              Days:        Mon, Wed, Fri
              Time:        09:00 – 11:00
              Status:      running
            Hits Save.
            ▶ Calendar entries auto-populate on Priya's AND Rahul's
              calendar for the next 4 weeks. They didn't have to add
              them; the system did.

16:00 IST   /admin/timesheets
            Spots two days where Anirudh's hours look short. Drills
            into his blocks; sees he was on sick leave Tuesday. No
            action needed.

16:30 IST   /agents/forecast
              "What's August looking like?"
            ▶ Forecast Agent: 22-28 enrolments, anchored by 14 paid.
              Narrative explains the 8 hot leads' demographic skew
              and flags 4 warm leads at re-engagement risk.

17:00 IST   Sends the forecast to founder via screenshot. Done.
```

The admin saw the team, the clients, the pipeline, the calendar, and
the forecast — without opening a spreadsheet. Every number is auditable
back to a row in the database.

---

# Part 3 — What's shipped today

A capability matrix. Everything in the **Live** column is in production
and exercised end-to-end (typecheck clean, smoke-tested, multi-tenant).

| Capability | Live | What it does |
|---|---|---|
| **Auth & Permissions** | ✓ | Custom email/password auth, opaque-token sessions, user groups, role-based permissions. Nine system permissions. Admin can create users, assign groups, assign clients, reset passwords. |
| **Multi-tenant isolation** | ✓ | Postgres Row-Level Security. The app role (`decrm_app`) cannot bypass RLS. Every query is automatically tenant-scoped at the DB level. |
| **Lead lifecycle** | ✓ | 7-state pipeline (new lead · attempted · cold · warm · hot · superhot · enrolled). Drag-drop kanban with optimistic update + rollback on error. Inline-editable lead record. |
| **Lead enrichment** | ✓ | Phone (CC + number split), time zone, delivery mode (online / offline / hybrid), city, price quoted (₹, numbers-only), next follow-up date, demo attended date, payment trail. |
| **Outreach Agent** | ✓ | Drafts personalised emails. Approval-gated. Cited. |
| **Lead Scoring Agent** | ✓ | 0-100 score + signals. Auto re-runs on lead changes. |
| **NBA Agent** | ✓ | Next-best-action card with confidence + rationale. |
| **Forecast Agent** | ✓ | Deterministic SQL aggregation + Claude narrative. |
| **Edify Chat Agent** | ✓ | Tenant-wide RAG-style chat. Persistent sessions, sidebar, stop / edit / resend. |
| **Approval queue** | ✓ | Every customer-facing AI action is held until a human approves. |
| **Activity audit log** | ✓ | Every edit, every approval, every agent run is timestamped + logged with diffs. |
| **Tickets** | ✓ | Support ticket spine with categories, priorities, assignees. |
| **Programs / Courses / Batches** | ✓ | Admin manages the catalog. Batches are time-fenced runs of one course. |
| **Batch trainers + co-trainers** | ✓ | Pick from any active user. Days-of-week + start/end time stored structurally. |
| **Calendar (D / W / M)** | ✓ | Outlook-style with date navigation, mini calendar popover, "+ New event" with invitees, RSVP buttons. Active batches auto-populate trainer + co-trainer calendars. |
| **In-app meeting invites** | ✓ | Organizer creates event, picks invitees from the user list, invitees see Accept / Decline / Tentative on their calendar. |
| **Timesheets (free-form)** | ✓ | No clock in/out. Add a block, pick a client (mandatory), add a note. Day / Week / Month viewer with filters. Conflict resolution dialog. |
| **Self-marked leaves** | ✓ | Sick / Personal / Vacation / WFH / Holiday. Half-day support. |
| **Client management** | ✓ | Admin CRUD + activate / deactivate. Clients can be assigned to specific employees. |
| **Admin · Team Timesheets** | ✓ | Pivot grid of every user × every day. Click any cell to drill into blocks. |
| **Admin · Reports** | ✓ | Date range + user multi-select + client multi-select. Pivot (user × client × day). CSV export. |
| **Learners** | ✓ | Converted leads become learners with course assignments + batch enrolments. |
| **Learner course/batch assignment** | ✓ | Per-batch + per-course tracking. Status per assignment. |

### On the roadmap (not yet live)

| Capability | When | Notes |
|---|---|---|
| Email send (SMTP integration) | Next phase | Today, "Approve & send" logs the activity but doesn't actually fire SMTP. Phase A non-goal at user's call; pluggable now. |
| Recurring events on the calendar | Next phase | One-off events only today. |
| Leave approval workflow | Next phase | Self-marked + admin-visible only today. No accruals or balances. |
| Per-session batch overrides | Next phase | Cancel a single Wednesday, swap a single Friday's room. |
| Notifications | Next phase | All in-app today; email / push not wired. |

---

# Part 4 — The moat

A list of things that look easy to copy until you try.

### Multi-tenant from the schema, not from a `tenant_id` column

We didn't bolt tenancy on — we built it into the database. Every
row has a `tenant_id`. Every connection runs as a Postgres role
(`decrm_app`) that has `NOBYPASSRLS`. RLS policies enforce the
isolation; *the app cannot leak data across tenants even if the
application code has a bug*. The query plan literally cannot touch
another tenant's rows.

For a SaaS that wants to onboard real customers, this is the difference
between "we'll fix it before launch" and "it's fixed before we wrote
the rest of the code."

### Agents that are grounded — by construction

The Forecast Agent doesn't ask Claude for the forecast. It asks SQL
for the forecast and asks Claude for the *prose around it*. Same
pattern in every agent: deterministic data, generative wrapper. We
validate the output against the source snapshot before it reaches the
screen.

This is the difference between a "ChatGPT wrapper" and a CRM you
can ship to a serious customer. Hallucinated metrics kill trust on
day one.

### A real audit trail — not a "history" tab

Every meaningful change writes an `activity` row with the diff,
the actor, the verb, and a payload. The agents themselves write to
this table — when the Outreach Agent drafts a message, that's a row.
When the human approves it, that's another row. When the Lead Scoring
Agent updates a score, the diff is recorded. Compliance, debugging,
and trust all flow from this one decision.

### One CRM, two surfaces

We didn't build two products — we built one product with a
permission-aware UI. An advisor sees the leads they own, the clients
they're assigned to, the batches they teach. An admin sees everyone.
The data layer is shared; the access is differentiated. Adding a
finance role or a regional-manager role tomorrow is a permission
update, not a rebuild.

### Idempotent migrations

24 SQL migrations, every one of them safe to re-run. Deployments
don't fear schema drift. New environments come up with one command.

---

# Part 5 — What we measure

This isn't a dashboard. These are signals the system already produces;
we surface them or aggregate them as the customer asks.

| Signal | Source | Surface |
|---|---|---|
| **Lead conversion rate** | rating transitions | /pipeline aggregate, Edify chat |
| **Pipeline velocity** | activity timestamps | Forecast agent, /pipeline |
| **Time-to-first-touch** | first activity vs. created_at | /agents/scoring signals |
| **Drift risk** (hot/superhot leads not touched in 48h) | activity ts vs. now | NBA agent, Edify chat |
| **Advisor utilisation** | timesheet hours / available hours | /admin/timesheets, /admin/reports |
| **Billable hours by client** | timesheet client tag | /admin/reports pivot, CSV export |
| **Forecast accuracy over time** | forecast output vs. actuals | (planned: dashboard) |
| **Agent acceptance rate** | approvals / drafts | /agents grid (per-agent) |
| **Pending approvals SLA** | time spent in the queue | /approvals |

---

# Part 6 — What's next

Six clear phases. The CRM is the platform; each phase doubles the
unit-economic value.

### Next 90 days
- **SMTP integration** so "Approve & send" sends. (One day's work; deferred deliberately so we ship the agent loop first.)
- **Notifications** (in-app + email digests of pending approvals).
- **Recurring calendar events** + per-session overrides on batch sessions.
- **Forecast agent v2** — confidence intervals tied to historical accuracy of past forecasts.

### Next 6 months
- **WhatsApp channel agent** — same approval-gated draft loop, WhatsApp Business API.
- **Voice-call-summary agent** — paste a call transcript → updated lead profile + suggested NBA.
- **Cohort-fill agent** — given a target cohort size, recommend which warm leads to target and in what order, optimising for fill rate × LTV.
- **Self-serve onboarding** — drop a new tenant in via signup, fully isolated, billing-ready.

### 12+ months
- **Marketplace of agents** — third parties write agents against our schema (read-only by default, approval-gated for writes).
- **Cross-tenant analytics** (anonymised) — "leads that look like yours converted at X%."
- **Outcome-based pricing** — % of incremental enrolment closed via approved AI drafts.

---

# Part 7 — Built on

For the technical investor in the room.

```
Frontend:    Next.js 15 (App Router) · React 19 · TypeScript · Tailwind
             Server Components for data, Client Components for state
             Anthropic SDK for AI · AbortController for streaming UX

Backend:     Express 4 + Drizzle ORM + node-postgres
             bcryptjs for passwords · opaque-token sessions in HttpOnly cookies
             RLS-enforced tenant isolation (no app-level leak surface)
             Idempotent SQL migrations (24 and counting)

AI:          Claude (via NVIDIA-hosted Anthropic endpoint)
             Deterministic-data + generative-narrative pattern
             Snapshot validation before output reaches the screen

Database:    Azure Postgres (managed, with PITR backups)
             pgvector for embedding-based search
             RLS policies on every tenant-scoped table

Deploy:      Vercel (web) + Render (api) + Azure (db)
             Both git-watched. Push to main → live in 5 minutes.
             Idempotent deploys, idempotent migrations.

Auth:        Custom — email + password + sessions + groups + permissions
             Bcrypt-hashed passwords. CSRF-safe SameSite cookies.
             Rate-limited login. Group-based RBAC.

Audit:       Every state change writes to an immutable `activity` table
             with actor, verb, diff, and payload. Forever.
```

It's not exotic. It's *boring on purpose* — the parts that need to be
boring (auth, persistence, deploy) are boring. The parts that should
be magical (the agents) are magical.

---

# The thesis, finally.

> The next decade of SaaS isn't about better forms. It's about software
> that *does the work* — proposes, drafts, scores, forecasts — and lets
> humans approve, judge, and override.
>
> A CRM is the perfect proving ground. Sales is half work-no-one-enjoys
> and half judgment-only-humans-can-make. The agent loop separates the
> two.
>
> We built the loop. We built it multi-tenant from day one. We built it
> with an audit trail, an approval gate, and a moat the deeper you look
> the wider it gets.
>
> Now we ship.

---

### The five-minute demo path

If you have the investor for five minutes and a laptop:

1. **`/pipeline`** — drag a lead from warm to hot. Show the kanban.
2. **`/records/[id]`** — click into the lead. Show the inline-edit + the activity timeline of agent runs.
3. **`/agents/edify`** — type *"Which leads should I prioritise today?"* — let them watch the answer arrive with citations.
4. **`/agents/forecast`** — show the August forecast. Point out: "the numbers are SQL, the narrative is Claude."
5. **`/admin/timesheets`** — show team-wide hours.

Five tabs. Five minutes. Five wow moments.

---

*Edify CRM · built in 2026 · India*
