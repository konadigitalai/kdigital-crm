---
marp: true
theme: default
paginate: true
size: 16:9
header: 'Edify CRM · Team walkthrough'
footer: 'Internal · 2026'
style: |
  section { font-family: 'Segoe UI', system-ui, sans-serif; padding: 60px 70px; }
  h1 { font-size: 44px; color: #0E0A14; }
  h2 { font-size: 32px; color: #6B1FB8; margin-top: 0; }
  h3 { font-size: 22px; color: #0E0A14; }
  code, pre { font-size: 18px; background: #F4EFE8; padding: 4px 8px; border-radius: 6px; }
  pre code { background: transparent; padding: 0; }
  table { font-size: 18px; }
  th { background: #6B1FB8; color: white; padding: 8px 12px; }
  td { padding: 8px 12px; border-bottom: 1px solid #E4DDD4; }
  blockquote { border-left: 4px solid #C7197A; padding-left: 16px; color: #4A4255; font-style: italic; }
  .small { font-size: 16px; color: #6E6376; }
  .big   { font-size: 28px; line-height: 1.45; }
---

<!-- _class: lead -->

# Edify CRM
## Team walkthrough

What we built, where it lives, how to use it.

<br>

`crmadmin@gmail.com` · `https://digitaledify-agentic-crm-wpta.vercel.app`

---

## What is this?

**A CRM where AI agents do the work, advisors do the judgment.**

- 6 AI agents handle outreach drafts, lead scoring, next-best-action, forecasting, and Q&A
- Every customer-facing AI output is held until a human approves it
- Multi-tenant, RLS-enforced, full audit trail
- Live in production today

---

## The map

```
   /leads          ──┐                 ┌──   /admin/users
   /pipeline        │                 │     /admin/clients
   /records/[id]    │     EDIFY CRM    │     /admin/timesheets
   /timesheet       │                 │     /admin/reports
   /calendar        │   ┌──────────┐  │     /admin/cohorts
   /agents          ──┤   6 AGENTS  ├──┐
                       └──────────┘  │
                                     │
                       Postgres + RLS

   Advisors (left)                Admins (right)
```

One product. Two surfaces. Permissions decide what each role sees.

---

# Part 1 — The 6 agents

---

## 1. Outreach Agent

**Drafts the next-best touch for a lead.**

- Sees: lead profile, full timeline, last 3 touches, current rating
- Produces: subject + body
- **Always approval-gated** — sits in "Pending approvals" until a human clicks Approve & send

---

## Outreach — example

```
SUBJECT: Quick check-in re: Python · Aug-2026 cohort

Hi Harsha,

Last we spoke you mentioned the Aug 2026 morning batch felt
right for your schedule, and you wanted to clarify the EMI
options before deciding. I dug into our finance terms — 6-month
no-cost EMI is now available for the full ₹1.49L.

Want me to share the link?

— Priya

CITED: Lead activity · Program · Cohort
```

Notice: cited sources, no invented urgency, no fake discounts.

---

## 2. Lead Scoring Agent

**Assigns a 0–100 score to every lead.**

- Re-runs on every meaningful change (rating, demo attended, timeline event)
- Returns: score + ranked positive and negative signals
- Each signal is **explainable** — advisor can disagree

---

## Scoring — example

```
SCORE  88  ·  Hot lead

POSITIVE
  + Visited pricing page in last 24h          +12
  + Replied to last touch within an hour       +9
  + Watched intro lesson 60%+                  +8
  + Demo attended on 2026-06-10                +6

NEGATIVE
  − Hasn't asked about timeline yet            −4
  − No referral in family / friends            −3
```

The score is the output. The signals are the *why*.

---

## 3. Next-Best-Action (NBA)

**Tells the advisor what to do for this lead, right now.**

- One action, with a confidence %, a why, and a one-tap execute
- Action types: Send email · Book demo · Apply EMI · Send payment link · Drip-only · Pause

---

## NBA — example

```
LEAD       Karthik Nair  (LEAD-9788)
ACTION     Send the EMI clarification email Priya drafted
CONFIDENCE 91 %

WHY
  Lead is 'hot', has explicitly asked about EMI, and has not
  been touched in 38 hours. Hot leads not touched in 48h
  convert at 41 % the rate of those touched within 24h.

ONE-TAP   [Approve & send]   [Edit]   [Snooze 1d]
```

Open this every morning. Replaces the "where do I start?" mental scan.

---

## 4. Forecast Agent

**This month's pipeline → enrolment forecast.**

- Numbers from deterministic SQL
- Narrative from Claude
- LLM cannot change the numbers — only how to describe them

---

## Forecast — example

```
AUGUST FORECAST   22 – 28 enrolments

  Confirmed (paid)            14
  High-confidence (hot)        8  ± 2
  Stretch (warm + recent)      4  ± 4

NARRATIVE
  Anchored by 14 paid registrations.
  The 8 'hot' leads have above-average AI-track engagement;
  expect 6 to close before cutoff (2026-08-05).
  4 'warm' demo-attendees haven't replied in 5+ days —
  treat as 50/50 without re-engagement.
```

---

## 5. Edify Chat Agent

**The home-page assistant. Knows your whole tenant. Cites its sources.**

- Reads leads, learners, tickets, batches, users, agent runs
- Persistent sessions (Claude-style sidebar + "New chat")
- Stop generating · edit-and-resend the latest prompt
- Inline citations to the surfaces it pulled from

---

## Edify chat — example

```
You: How many hot leads do we have, and which ones are at risk?

Edify: 8 leads are currently 'hot' or 'superhot'.

Of these, 3 haven't been touched in over 48 hours:

   ◆ Karthik Nair  (LEAD-9788)  · 67h ago
   ◆ Priya Reddy   (LEAD-9601)  · 51h ago
   ◆ Arjun Bose    (LEAD-9512)  · 49h ago

Run the Outreach Agent on all three. NBA already has drafts
for two of them under 'Pending approvals'.

CITED: /pipeline · /leads · /agents/runs · /approvals
```

---

## 6. The Approval Gate

**Not an agent that talks. An agent that listens.**

```
   AGENT proposes  →  APPROVAL  →  HUMAN approves  →  Action fires
                       QUEUE       OR REJECTS         (logged forever)
```

The line we won't cross. AI proposes. **Humans dispose.**
Every approval / rejection is recorded in the activity timeline.

---

# Part 2 — The pages

---

## Advisor surfaces

| Page | What it does |
|---|---|
| `/` | Edify chat home — start here every morning |
| `/leads` | Filterable lead list with date filters |
| `/pipeline` | 7-state kanban with drag-drop |
| `/records/[number]` | Click-to-edit lead record + agent runs |
| `/timesheet` | Free-form blocks, day/week/month viewer |
| `/calendar` | Day/Week/Month with mini-cal popover |
| `/agents` | Run agents on demand · approvals queue |
| `/tickets` | Support spine with categories + assignees |
| `/learners` | Converted leads with batch + course state |

---

## Admin surfaces

| Page | What it does |
|---|---|
| `/admin/users` | Create users, assign groups + clients, reset pw |
| `/admin/groups` | Define permission groups |
| `/admin/clients` | CRUD clients, assign to employees |
| `/admin/cohorts` | Batches with trainer + co-trainer + days/times |
| `/admin/courses`, `/admin/programs` | Catalog management |
| `/admin/timesheets` | Pivot of every user × every day |
| `/admin/reports/timesheets` | User × Client × Day pivot · CSV export |

---

## The 7-state pipeline

```
new lead → attempted → cold → warm → hot → superhot → enrolled
```

- Drag a card across columns → rating updates · Lead Scoring re-runs · NBA regenerates
- Optimistic UI · rolls back on error
- Filters: name, number, program, rating, score, next follow-up, demo attended

Old "stages" (qual / demo / neg) are gone — rating is the single source of truth.

---

## Lead record · the editable spine

Click any field to edit. Every change writes to the activity timeline with a diff.

**LEAD DETAILS**
- Email, Phone CC, Phone, Program, Source, Advisor
- **Price quoted** (₹, numbers-only)
- **Next follow-up date**, **Demo attended date**

**Header strip**: Rating · Lead # · Mode (online/offline/hybrid) · Time zone

**Cards**: Description · Payment trail · Agents on this lead

---

# Part 3 — Two days in the life

---

## Day in the life · Priya (advisor)

```
07:45  Login → home page Edify chat with sidebar of yesterday's chats
08:00  /pipeline → drag two warm leads to hot
       ▶ Scoring re-runs · NBA regenerates · Outreach drafts new email
08:15  /records/LEAD-9788 → tweak the draft → Approve & send
09:30  /timesheet → log the morning's calls
10:00  Demo session for AI Aug-2026 batch (auto-shows on calendar)
12:30  /agents/edify → "Who attended a demo this week, no reply since?"
14:00  Lead replies → Scoring 78→91 · NBA suggests "Send payment link"
17:00  /timesheet review · mark tomorrow PM as half-day leave
```

She did 12 high-judgment actions. The agents handled ~40 in the background.

---

## Day in the life · CRM Admin

```
09:00  Edify chat: "How did the team do this week vs last?"
       ▶ "178h vs 164h. Acme Corp +12h, Globex -4h. 8 new hot leads."
09:30  /admin/reports/timesheets → CSV export for invoicing
10:00  /admin/users → New user Anil, role advisor, clients [Globex, Acme]
       ▶ Anil signs in → /me/clients shows just those two
14:00  /admin/cohorts → New batch
       Trainer: Priya · Co-trainer: Rahul · Days: M/W/F · 9–11am
       ▶ Sessions auto-populate on Priya's AND Rahul's calendars
16:30  /agents/forecast → August forecast 22-28 with narrative
17:00  Screenshot to founder. Done.
```

No spreadsheets. Every number traceable to a database row.

---

# Part 4 — How it's built

---

## The stack

```
Frontend    Next.js 15 (App Router) · React 19 · TypeScript
            Server Components for data, Client for state
            Tailwind for styling
            Anthropic SDK + AbortController for streaming UX

Backend     Express 4 + Drizzle ORM + node-postgres
            bcryptjs · opaque-token sessions in HttpOnly cookies
            RLS-enforced tenant isolation
            24 idempotent SQL migrations

AI          Claude (via NVIDIA-hosted Anthropic endpoint)
            Deterministic-data + generative-narrative pattern
            Snapshot-validated outputs

Database    Azure Postgres (managed · PITR backups)

Deploy      Vercel (web) + Render (api) + Azure (db)
            Both git-watched. Push to main → live in 5 min.
```

---

## The moat (in one slide)

- **RLS-enforced multi-tenancy** — app cannot leak data across tenants, even if there's a bug. Enforced at the DB.
- **Grounded agents** — every agent reads from real data, validates output against a snapshot, cites sources.
- **Real audit trail** — every change writes an activity row with diff + actor + payload.
- **One product, two surfaces** — advisor and admin share data, differ in permissions. Adding a "finance" role tomorrow is a permission change, not a rebuild.
- **Idempotent migrations** — safe to re-run on prod. New environments come up with one command.

---

## What's live today

Auth · multi-tenant RLS · 7-state pipeline · drag-drop kanban · inline-edit lead records · phone CC + number split · time zone · delivery mode · price quoted (₹) · next follow-up + demo attended dates · payment trail · **6 AI agents** · approval queue · activity audit log · tickets · programs/courses/batches · trainer + co-trainer · calendar (D/W/M) · in-app meeting invites · free-form timesheets · self-marked leaves · client management · admin team-timesheet pivot · admin reports with CSV · learner spine.

**24 features, all in production, all typecheck-clean.**

---

## Roadmap

**Next 90 days**
SMTP integration · in-app + email notifications · recurring calendar events · Forecast v2 with confidence intervals based on past accuracy

**Next 6 months**
WhatsApp channel agent · voice-call-summary agent · cohort-fill agent · self-serve tenant onboarding

**Beyond**
Marketplace of agents · cross-tenant analytics (anonymised) · outcome-based pricing

---

# Part 5 — Demo path

---

## 5 tabs · 5 minutes · 5 wow moments

1. **`/pipeline`** — drag a lead from warm to hot. Watch the kanban update.
2. **`/records/[id]`** — click into the lead. Show inline edit + activity timeline.
3. **`/agents/edify`** — "Which leads should I prioritise today?" — citations arrive live.
4. **`/agents/forecast`** — show the August forecast. *"Numbers from SQL. Narrative from Claude."*
5. **`/admin/timesheets`** — pivot of the team's hours.

If you have 30 seconds: just show **#3**. The agent thinking + citing in real time is the demo.

---

# Part 6 — How to use it (for the team)

---

## Logging in

- URL: `https://digitaledify-agentic-crm-wpta.vercel.app`
- Use the email + password your admin gave you
- Forgot? Ping the CRM admin — they reset from `/admin/users`

## Adding a new lead

`/leads` → `+ New lead` → fill name + phone + program → Save.
Lead Scoring runs immediately. NBA suggests a first action.

## Changing a lead's rating

`/pipeline` → drag the card to the new column.
Or `/records/[number]` → click the rating chip in the header.

---

## Logging time

- `/timesheet` → `+ Add block`
- Pick **client** (mandatory), set start + end, add a short note
- Default slot is "the next free hour after your last block"
- Edit anytime — Edit button on each row

If you forget for a few days: switch to Week or Month view, click any day, fill it in.

---

## Marking leave

- `/timesheet` → `+ Mark leave` → date · type · half-day option
- Sick / Personal / Vacation / WFH / Holiday
- Admin sees it on `/admin/timesheets` immediately
- No approval flow yet — just transparency

---

## Calendar + meetings

- `/calendar` → Day / Week / Month tabs
- Click any time slot → schedule a meeting
- Pick invitees (any active user) → they see RSVP buttons (Accept / Decline / Tentative)
- Active batches you teach auto-populate as sessions

---

## Asking Edify

- `/` (home) or `/agents/edify`
- Ask anything in plain English — *"Which warm leads attended a demo this month?"*
- It cites the data sources it used
- Sessions persist; pick up old chats from the sidebar
- Stop a slow answer · edit-and-resend the last question

---

# Part 7 — Operations

---

## Deploy

```
GitHub (push to main)
  ├─→ Vercel  (web/)   automatic, ~3 min
  └─→ Render  (api/)   automatic, ~3 min
        ↓
     Azure Postgres
```

Both watch `main`. Every push = a new deploy. Preview URLs on pull requests.

---

## Adding a migration

1. Drop a `post-NNNN-name.sql` under `api/drizzle/`
2. Make it idempotent: `IF NOT EXISTS`, constraint guards, etc.
3. Push → Render rebuilds, **but doesn't auto-migrate**
4. Run `npm run db:migrate` from your machine or Render's Shell tab

The runner is safe to re-run — it skips what's already applied.

---

## Day-2 ops cheatsheet

| Need to… | Where |
|---|---|
| Reset a user password | `/admin/users` → row → Reset password |
| Deactivate a user | Same row → toggle |
| Add a client | `/admin/clients` → New client |
| Assign a client to a user | `/admin/users` → Edit → Clients section |
| Promote a co-trainer | `/admin/cohorts` → batch → swap |
| Rotate the AI key | Render → Environment → update + Manual Deploy |
| See logs | Render → Logs (api) · Vercel → Logs (web) |

---

## Roles + permissions (today)

| Role | Default permissions |
|---|---|
| Administrators | Everything. Manage users, groups, clients, programs, batches. See all timesheets. |
| Advisors | Their own leads, pipeline, calendar, timesheet, agent runs. |
| Service rep | Tickets + everything advisors get. |
| Read-only | Read leads / reports, no writes. |

Permissions are **not** the role tag. They flow from group membership. New role tomorrow = new group.

---

# Part 8 — Q&A

---

## Common questions

**Q: Will the agents send emails on their own?**
No. Every customer-facing AI output is held in `/approvals`. A human clicks Approve before anything fires.

**Q: Can the agents see other tenants' data?**
No. RLS enforces tenant isolation at the DB layer. The app role (`decrm_app`) cannot bypass it.

**Q: What if Claude is down?**
Agents fail gracefully — the page renders with a "service unavailable" state. The CRM stays usable.

**Q: Is there a mobile app?**
Not yet. The web app is responsive but not mobile-optimised. On the roadmap.

---

## Thanks

Questions? Demos? Feature requests?

`#crm` on Slack · or just open a GitHub issue.

<br>

*Edify CRM · 2026*
