# Digital Edify Agentic CRM
## Customer Data Foundation — Where We Stand & What It Takes to Catch Up

> **Audience:** Founders, business leadership, product, and engineering management.
> **The question being answered:** Should we move our customer data onto a "Party Model" — the foundation that ServiceNow and Salesforce use? Where are we lacking today, what changes, and what does it cost?
> **One-line answer:** We're already 70% of the way there. The remaining 30% is what causes most of today's data quality, duplicate-lead, and compliance pain. Fixing it takes 6–8 weeks and unlocks four business capabilities we don't have today.

---

## 1. Why This Matters to the Business

Every CRM eventually answers one question: *who is this person, and what is our complete history with them?*

Right now, our system answers that question **partially**. A learner who started as a lead, became a student, and might one day be a referrer is stored as multiple half-connected records. A trainer who also enrolls in an advanced course shows up twice. The same Instagram prospect can fill the form on Monday and again on Friday, and we'll happily call them twice.

These are not theoretical problems. They are the root cause behind:

| Today's pain | Root cause |
|---|---|
| Advisors calling the same lead twice (Gap #5 in our Gaps doc) | No unified person record |
| WhatsApp broadcasts sent to people who never opted in | No consent layer |
| Cannot answer "show me everything about this person" in one screen | Person data lives in 4 places |
| Cannot do B2B sales properly (one buyer, many stakeholders) | No org hierarchy / affiliation |
| Trainer who later becomes a learner = two unrelated rows | Internal users live in a separate world from customers |
| Regulatory exposure (DPDP, GDPR) on every WhatsApp send | No proof-of-consent record |

The "Party Model" is the industry-standard fix. ServiceNow built their entire platform on it. Salesforce uses a partial version (Account + Contact + User). Both are valued at tens of billions of dollars because **their customer data model scales**. Ours doesn't yet.

---

## 2. The Verdict — Where We Stand

| Item | Value |
|---|---|
| Industry-standard pattern adopted? | Partially — about **70%** |
| Biggest single gap | Internal users (employees, trainers, advisors) live in a separate world from customers |
| Second-biggest gap | No way to store multiple emails, phones, or addresses per person |
| Third-biggest gap | No consent records → regulatory risk on every marketing message |
| Time to close the gap | **6–8 weeks** (one engineer, full focus) |
| Overall complexity | **Medium-High** |
| Business risk of not doing it | Compounds with every new lead, every new feature |
| Business risk of doing it badly | Login outage during the cutover (mitigated below) |

---

## 3. What's Lacking — In Business Language

Below are the eight gaps that separate our data model from a ServiceNow/Salesforce-grade one. Severity reflects business impact, not engineering difficulty.

### Gap 1 — Employees and customers live in two separate worlds  · *Severity: Critical*

**What's broken:** An advisor on our team is stored in one table. A customer is stored in another. They are not linked. If a trainer later wants to enrol in our advanced AI course, the system has no way to recognize "this is the same person."

**Why it matters:** Every modern CRM treats employees and customers as the same kind of entity — a *person* — with different *roles*. We don't. This means we cannot do referral programs cleanly, alumni networking cleanly, or "trainer-as-learner" cleanly. It also means our internal team data sits in a corner that AI agents and reports can't fully reach.

**How ServiceNow / Salesforce do it:** Both have *one* person table for everyone; the difference between "employee" and "customer" is a flag, not a separate table.

---

### Gap 2 — One email and one phone per person  · *Severity: High*

**What's broken:** Each customer gets exactly one slot for email, one for phone, one for city. Real people have a work email and a personal email. They have WhatsApp on one number and answer calls on another. They have a billing address and a shipping address.

**Why it matters:**
- We cannot dedupe properly (the same person reaches us from two emails — we treat them as two people).
- WhatsApp campaigns may use the wrong number.
- We cannot mail certificates to a different address than the billing one.
- Salesforce calls this a "Contact Point" model and treats it as table stakes.

---

### Gap 3 — No structured address  · *Severity: Medium*

**What's broken:** We store only a free-text city. No postcode, no state, no country, no street.

**Why it matters:** We cannot filter leads by region for territory-based assignment. We cannot print certificates or invoices. We cannot do GST-compliant addressing for India sales.

---

### Gap 4 — No org structure, no person↔org links  · *Severity: Medium (rising to High as B2B sales begin)*

**What's broken:** We can store an organization as a record, but we cannot say "Jane works at Acme as the decision maker; Bob also works at Acme as the technical evaluator." We cannot store "Acme is a subsidiary of Globex."

**Why it matters:** The moment we start B2B sales (selling to companies, not individuals), this becomes blocking. A B2B deal has 4–7 stakeholders per company. Without affiliation tables, we cannot route, score, or report on B2B deals properly.

**How Salesforce does it:** `Account` + `Contact` + `AccountContactRelation` lets one person work for multiple companies with different roles. We need the same.

---

### Gap 5 — Lead and case records carry copies of person data  · *Severity: Medium*

**What's broken:** A lead record stores its own copy of the person's city. When the person moves, the lead is stale.

**Why it matters:** Reports lie. Lists show wrong data. Engineers fight a constant low-grade war against "which copy is the truth?"

**Note:** Case (support ticket) records *intentionally* snapshot the requester's name/email/phone at create time — this is correct behaviour, because a support ticket should reflect what we knew at the time. The fix here is about the lead record, not the case record.

---

### Gap 6 — No deduplication infrastructure  · *Severity: High*

**What's broken:** No matching rules, no review queue, no merge tool, no merge audit trail.

**Why it matters:** This is **Gap #5 in our existing Gaps document** — advisors waste time calling the same prospect twice. Today the only "dedup" is the advisor's memory. Salesforce ships Duplicate Rules + Matching Rules out of the box; ServiceNow has CI Identification & Reconciliation Engine. We have neither.

**What good looks like:**
- "These two records look like the same person. Merge?" → one click.
- Audit trail of every merge (who, when, what was kept).
- Strong matches (same external system ID) auto-merge; weak matches go to a review queue.

---

### Gap 7 — No consent records  · *Severity: High (regulatory exposure)*

**What's broken:** Nothing in the system records *who opted in to what channel, when, and how*. WhatsApp broadcasts go out today on the basis of "we have their phone number."

**Why it matters:** India's Digital Personal Data Protection Act (DPDP, 2023) and GDPR both require proof of consent for marketing communications. One complaint to TRAI or the DPDP Board, and we have no record to defend ourselves with.

**What good looks like:**
- Per-person, per-channel opt-in record (WhatsApp / email / calls / SMS).
- Every marketing send joins to consent records and excludes opt-outs.
- Audit log of every send referencing the consent that authorised it.
- A "Privacy Centre" page that lets a customer (or a regulator's auditor) see their full consent history.

---

### Gap 8 — Activity / audit trails store actor as plain text  · *Severity: Low–Medium*

**What's broken:** When the audit log records "user X did Y," X is stored as text rather than a proper link to a person record.

**Why it matters:** Mostly internal hygiene. Means reports can't cleanly join "show me everything Jane did across the system" without string-matching. Worth fixing but not urgent.

---

## 4. What the Target Looks Like — Plain English

The target is a single source of truth for **every person and organization the business ever touches**. One row per real-world actor — customer, employee, trainer, vendor, alumnus, referrer — with the right tables hanging off it.

```
                       ┌─────────────────────────────┐
                       │   PERSON OR ORGANIZATION    │
                       │   (one row per real actor)  │
                       └──┬──────────┬──────────┬───┘
                          │          │          │
            ┌─────────────▼──┐  ┌────▼─────┐ ┌──▼──────────┐
            │  Roles over    │  │ Contact  │ │ External    │
            │  time          │  │ methods  │ │ system IDs  │
            │  (lead →       │  │ (emails, │ │ (Instagram, │
            │   learner →    │  │  phones, │ │  Razorpay,  │
            │   alumnus)     │  │  addrs)  │ │  …)         │
            └────────────────┘  └──────────┘ └─────────────┘
                          │
            ┌─────────────▼─────────────┐  ┌──────────────────┐
            │ Org hierarchy &           │  │ Consent records  │
            │ affiliations              │  │ (per channel,    │
            │ (Acme parent of Beta,     │  │  per person)     │
            │  Jane works at Acme)      │  │                  │
            └───────────────────────────┘  └──────────────────┘
```

**Key new capabilities this unlocks:**

| New capability | Business value |
|---|---|
| One screen, full person history | Advisor productivity, faster onboarding of new advisors |
| Multiple contact points per person | Higher WhatsApp deliverability, cleaner outreach |
| Person↔org affiliations | Enables B2B sales motion |
| Dedup queue | Stops the "two advisors called the same lead" problem |
| Consent records | DPDP / GDPR compliance; safer marketing automation |
| Merge audit | Trust in data; reversible mistakes |

---

## 5. ServiceNow vs Salesforce — What We Should Copy From Each

| Design choice | ServiceNow | Salesforce | Our choice |
|---|---|---|---|
| Should employees and customers share one table? | Yes | No (User + Contact, bridged) | **ServiceNow** |
| Lead → Customer transition: destructive or role-based? | Role-based (better) | Destructive (Lead → Convert deletes Lead) | **ServiceNow** |
| Org hierarchy | Self-referencing parent | Self-referencing parent | Either; same shape |
| Person↔org affiliation | Limited | Strong (multi-role) | **Salesforce** |
| Deduplication engine | CI Identification | Duplicate Rules + Matching Rules | **Salesforce** |
| Consent / marketing preferences | Weak in core | Lives in Marketing Cloud | **Build our own to DPDP/GDPR spec** |

**Net guidance:** ServiceNow for *structure*. Salesforce for *affiliation and dedup*. Build our own consent layer to local regulation.

---

## 6. The Migration Plan — 4 Phases, 6 Sprints

Each phase ends with the system in a known-good state. We can stop after any phase if priorities shift.

### Phase 0 — Decide & Freeze · *Trivial · 1 day*

- This document signed off by leadership.
- Internal rule: no new feature is allowed to add yet another email/phone column. New person data goes through the new tables.
- Communication to the engineering team.

**Outcome:** No more bleeding. The hole stops getting deeper.

---

### Phase 1 — Contact Points, External IDs, Affiliations · *Low–Medium · 1 week*

- Add the tables that let one person have many emails, phones, and addresses.
- Add the table that maps external system IDs (Instagram lead ID, Razorpay customer ID, etc.) to our person record.
- Add the table that expresses "Jane works at Acme as a decision maker."
- Nothing in the existing system breaks — these are purely additive.

**Outcome:** New code can use the right tables. Old code keeps working. We start writing to both old and new in parallel.

---

### Phase 2 — Unify Employees and Customers · *High · 2 weeks*

The big one. This is the gap that causes the most ongoing pain, and the one with the most risk during cutover. We link every employee record to a person record.

**The risk:** Login could break during the change. Mitigation: feature flag, staging burn-in, manual smoke test for all four user roles, rollback script ready.

**Outcome:** A trainer who later becomes a learner is *one* person with two roles. Reports unify. AI agents can reason across employees and customers as one population.

---

### Phase 3 — Clean Up Duplicated Person Data · *Medium · 1 week*

- Lead records stop carrying their own copy of the person's city.
- Activity and audit logs reference the proper person record.
- Support tickets keep their immutable snapshot (this is correct behaviour, not a bug).

**Outcome:** One truth per person. Stale data in reports goes away.

---

### Phase 4 — Dedup Engine + Consent Layer · *Medium–High · 1.5–2 weeks*

- Matching rules detect duplicate person records.
- Strong matches auto-merge; weak matches go to a review queue.
- Merge audit trail records every merge (reversible).
- Per-channel consent records (WhatsApp, email, calls, SMS).
- Marketing sends are gated by consent join.
- Privacy Centre page for self-service consent management.

**Outcome:** Advisors stop calling the same lead twice. WhatsApp broadcasts are defensible under DPDP / GDPR.

---

## 7. Investment & Complexity Summary

| Phase | Business Outcome | Complexity | Engineering Effort | Calendar |
|---|---|---|---|---|
| 0 | Stop bleeding; align team | Trivial | 1–2 person-days | 1 day |
| 1 | Multi-channel contact + B2B foundation | Low–Medium | 5–7 person-days | 1 week |
| 2 | Unified person view; AI can see all roles | **High** | 8–12 person-days | 2 weeks |
| 3 | One truth per person; clean reports | Medium | 4–6 person-days | 1 week |
| 4 | Dedup + consent → compliance & efficiency | Medium-High | 8–10 person-days | 1.5–2 weeks |
| | **Total** | | **26–37 person-days** | **6–8 weeks** |

### What can change the timeline

| Condition | Impact on timeline |
|---|---|
| Engineer is new to the codebase | × 1.5 |
| No staging environment that mirrors production | × 1.4 |
| Auth provider (Auth0) is not under our control | × 1.2 |
| Test coverage is thin around affected areas | × 1.3 |

Worst case if all four apply: 3–4 months. This is why **Phase 0's freeze rule matters first** — it stops new debt while we scope honestly.

---

## 8. Risk Register

| # | Risk | Likelihood | Business Impact | Mitigation |
|---|---|---|---|---|
| 1 | Login breaks during Phase 2 cutover | Medium | **Critical** | Feature flag, staging burn-in, rollback script, manual smoke test of all roles |
| 2 | Cross-tenant data leak through a missed security policy on new tables | Low | **Critical** | Mandatory security review per migration; automated cross-tenant test |
| 3 | Dedup wrongly merges two distinct people | Medium | High | Conservative rules; weak matches go to review queue, never auto-merge |
| 4 | We assume opt-in for legacy contacts and get a DPDP complaint | Low | High (regulatory) | Backfill consent as "unknown," re-collect on next touch |
| 5 | Person lookup queries slow down after Phase 1 | Medium | Medium | Add the right database indexes (standard hygiene) |
| 6 | A frontend screen breaks because it reads old field directly | Low | Low | API contract preserved; smoke test list and detail views |

---

## 9. Decisions Needed From Leadership

1. **Do we commit to Phase 2 (unifying employees and customers)?** Without it, Phases 1, 3, 4 still deliver value, but the underlying duplication remains. *Recommendation: yes — it's the largest single source of pain.*
2. **Do we ship Phase 1's affiliation table now, before B2B sales begin?** Cost is one extra table. *Recommendation: yes — avoids retrofitting later.*
3. **Where does the Consent Privacy Centre UI live?** Inside the lead detail page, in settings, or as a standalone page? *Defer to Phase 4 design review.*
4. **Do we keep a denormalized "primary email/phone" on the person record for speed?** Salesforce does. *Recommendation: yes — speeds up list views.*
5. **Are we willing to budget one engineer full-time for 6–8 weeks?** Or stretch it across two engineers part-time over 12 weeks? *Recommendation: full-time, single engineer — fewer handoffs, fewer bugs.*

---

## 10. Recommended Sprint Sequence

| Sprint | Phase | Deliverable |
|---|---|---|
| Sprint 1 | Phase 0 | Document signed, freeze rule in place, team aligned |
| Sprint 2 | Phase 1 | Contact points, external IDs, affiliations live (dual-write) |
| Sprint 3 | Phase 2 | Employees and customers unified; Auth0 updated |
| Sprint 4 | Phase 3 | Lead / activity / audit cleaned up |
| Sprint 5 | Phase 4a | Dedup queue UI live |
| Sprint 6 | Phase 4b | Consent layer + Privacy Centre + WhatsApp gated by consent |

After Sprint 6, the customer data foundation is on par with what a Series B SaaS company would have. From there, every new feature is easier and cheaper to build.

---

## 11. The Cost of Not Doing This

The work compounds with every new lead, every new feature, every new integration. Concretely, if we delay 6 months:

- Approximately **30–40 advisor-hours per month** lost to duplicate-lead waste (today's number, growing with volume).
- **Every new agent feature** (the Service, Finance, Operations agents in our roadmap) is harder to build because each one re-invents "who is this person?" locally.
- **B2B sales motion is delayed** until we add affiliations — typically a 2–3 month detour mid-launch.
- **Regulatory risk grows linearly** with our customer count.

Doing this work now, before the next major capability push, is the cheapest moment in the company's life to do it. It only gets more expensive from here.

---

## Appendix — Glossary

| Term | Plain meaning |
|---|---|
| Party Model | An industry-standard data design where one table stores every person and organization the business deals with, regardless of role. |
| Role | A capacity in which a person participates — lead, learner, advisor, alumnus. A person can hold many roles over time. |
| Contact Point | Any way to reach a person — an email, a phone number, a WhatsApp number, a postal address. |
| Affiliation | A person's membership in (or role at) an organization. |
| Dedup | The process of detecting that two records are the same person and merging them safely. |
| Consent | A recorded permission from a person to be contacted on a specific channel. |
| DPDP | India's Digital Personal Data Protection Act, 2023. |
| GDPR | The EU's General Data Protection Regulation. |
| ServiceNow | An enterprise software platform built on a single-person-record data model. |
| Salesforce | The world's largest CRM, using a partial party model (Account + Contact + User). |
