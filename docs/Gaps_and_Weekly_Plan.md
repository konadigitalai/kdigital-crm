# Digital Edify Agentic CRM
## Gaps & 12-Week Shipping Plan

> **Cadence:** one major capability shipped to production every week.
> Each release is something a customer-facing team can see, use, and judge.

---

## Part 1 — The Gaps

What is missing today, measured against the target architecture in the product documents. Grouped so the business audience can see the shape of the work.

### A. Customer-Facing Capability Gaps

| # | Gap | What it means |
|---|---|---|
| 1 | **Daily ranked call list** | Advisors don't have a single morning surface; lead intelligence is spread across screens. |
| 2 | **Outbound WhatsApp send** | Agents draft, but messages aren't actually leaving the system end-to-end. |
| 3 | **Outbound email send** | No SMTP/email path is wired; outreach is WhatsApp-only on paper, neither in practice. |
| 4 | **Auto-send for pre-approved nudges** | Every message — even the 5-minute welcome — currently waits for a human. |
| 5 | **Duplicate lead prevention** | No probabilistic identity resolver; the same prospect can land twice and waste advisor time. |
| 6 | **Support agent** | No auto-triage, root-cause tagging, or KB deflection; tickets are still human-routed. |
| 7 | **Finance agent** | Revenue isn't real numbers in the dashboard; balance, payment status, and history-aware reminders don't exist. |
| 8 | **Operations agent** | No trainer load balancing, no schedule-collision detection, no Zoom/room allocation. |
| 9 | **Career agent** | Placement funnel isn't tracked; mock interviews and certificates are manual. |
| 10 | **Cross-domain supervisor (Edify Assistant)** | Current assistant answers from a snapshot but cannot dispatch actions across domain agents. |

### B. Trust & Safety Gaps

| # | Gap | What it means |
|---|---|---|
| 11 | **Enterprise auth (Auth0)** | Running on a custom bcrypt + role-based system; not enterprise-ready. |
| 12 | **Fine-grained authorization (FGA)** | No relationship-based, on-behalf-of permissions; agents can't be given time-boxed grants. |
| 13 | **Sensitive-action approvals** | Refunds, fee waivers, credential changes, certificates, employer-share don't have explicit human-only gates. |
| 14 | **Token Vault for secrets** | Channel and integration credentials live in environment variables, not a vault. |
| 15 | **Shared Zoom password** | Flagged as a P0 issue in the PRD; still unresolved. |
| 16 | **Prompt-injection defenses** | Inbound message content is treated like trusted data; no test suite proves it isn't. |

### C. Quality & Observability Gaps

| # | Gap | What it means |
|---|---|---|
| 17 | **Automated evals (golden datasets, CI gate)** | No quality bar enforced before a release; agents can silently regress. |
| 18 | **Tracing / observability (OTel-GenAI)** | No end-to-end span view of an agent run; debugging is by eyeballing logs. |
| 19 | **Grounding metric** | No enforced "zero ungrounded fees, dates, or promises" check. |
| 20 | **Production traces feeding back into eval set** | No learning loop from real runs. |

### D. Memory & Knowledge Gaps

| # | Gap | What it means |
|---|---|---|
| 21 | **Episodic memory** | No per-learner rolling summary; every conversation starts from scratch. |
| 22 | **Semantic memory / KB grounding** | Embeddings table exists but isn't used to answer questions or deflect tickets. |
| 23 | **Provenance + decay + right-to-be-forgotten** | Facts have no source, no expiry, no deletion cascade. |

### E. Platform & Multi-Tenant Gaps

| # | Gap | What it means |
|---|---|---|
| 24 | **Core/config split** | Tenant specifics are baked into code; a second customer would need code changes. |
| 25 | **Control plane** | No tenant registry, no provisioning script, no fleet visibility. |
| 26 | **Per-tenant database isolation** | Currently shared DB with row-level security; doc-spec target is separate Postgres per tenant. |
| 27 | **Customer #2 onboarding via config** | The actual product-market gate isn't reachable today. |
| 28 | **Canonical event log** | `audit_log` exists but isn't the spine every consequential action writes through. |
| 29 | **Ontology / Choice Lists** | Status and rating values are hard-coded strings, not a configurable ontology table. |
| 30 | **MCP tool gateway** | No chokepoint where every tool call is authorized, telemetered, and credential-injected. |
| 31 | **Identity resolver review queue** | No human-in-loop UI for ambiguous matches. |

---

## Part 2 — The Planned Order

Each week closes a defined set of gaps. The visible ship is what stakeholders will see in production that week; the hidden work is what we fold in alongside it.

| Wk | Visible Ship | Gaps Closed |
|---:|:--|:--|
| **1** | **Daily Call List** + tracing | #1, #18 |
| **2** | **One-Tap WhatsApp Send** + auto-nudges | #2, #4 |
| **3** | **Email Send + Duplicate Lead Prevention** | #3, #5, #31, #29 (start) |
| **4** | **Quality Guarantee (Eval Harness)** | #17, #19, #20, #16 |
| **5** | **Enterprise Auth (Auth0 + FGA)** | #11, #12, #13, #14, #15 |
| **6** | **Support Agent (live)** | #6, #28 |
| **7** | **Finance Agent (revenue becomes real)** | #7, #13 (refunds/waivers) |
| **8** | **Memory + Knowledge-Grounded Answers** | #21, #22, #23 |
| **9** | **Operations Agent** | #8 |
| **10** | **Career Agent** | #9 |
| **11** | **Edify Assistant (Cross-Domain Supervisor)** | #10, #30 |
| **12** | **Customer #2 from Configuration** | #24, #25, #26, #27 |

---

## How to Read This Order

- **Weeks 1–3 — Visible Value.** Close the gaps the customer feels every day: ranked work, real send, no duplicates.
- **Weeks 4–5 — Trust.** Without quality and authorization in place we cannot responsibly turn on agents that touch money or credentials.
- **Weeks 6–10 — Domain Agents.** One new agent per week, each landing on a foundation that's already safe and observable.
- **Weeks 11–12 — Platform Proof.** A single assistant across the whole business, then a second institute live on configuration alone.

> **Slip rule.** If a week is at risk, internal/platform work moves; the visible ship does not.

---

## Closing Statement

Every week, in production. Every release, visible to a customer. Every twelve weeks, a second institute could go live without us writing new code.

That's the bar.
