// Seed Azure / local DB with the same data the UI mock has been showing.
// Idempotent: clears tenant data first, then inserts. Safe to re-run.
//
// Usage: npm run db:seed

import { sql } from "drizzle-orm";
import { db, pool } from "./client.js";
import {
  activity,
  agent,
  agentAssignment,
  agentRun,
  appUser,
  approval,
  cohort,
  course,
  enrolment,
  lead,
  leadScoreSignal,
  party,
  partyRole,
  program,
  tenant,
  supportCase,
  workItem,
} from "./schema.js";
// Auth is owned by Auth0 now — seeded users have no password hash and
// can't log in via the legacy /auth/login (which no longer exists). The
// only way into the app is Auth0 Universal Login; first sign-in JIT-
// provisions an app_user row keyed by the auth0 sub. The rows seeded
// below exist so that activity timestamps + foreign keys (e.g.
// ticketAgents → support_case.assigned_id) line up with the demo data.

const TENANT_NAME = "Digital Edify";

// ─── helpers ──────────────────────────────────────────────────────────────

async function nextNumber(prefix: string, seq: string): Promise<string> {
  const r = await pool.query<{ n: string }>(`SELECT nextval('${seq}')::text AS n`);
  return `${prefix}-${r.rows[0]!.n}`;
}

function initialsOf(name: string): string {
  return name.split(/\s+/).map((s) => s[0]).slice(0, 2).join("").toUpperCase();
}

// ─── source data (mirrors web/src/lib/mock.ts) ────────────────────────────

interface SeedLead {
  initials: string; name: string; city: string; program: string; cohort: string;
  value: string; stage: "new" | "qual" | "demo" | "neg" | "won"; stageLabel: string;
  score: number; heat: "hot" | "warm" | "cold"; avatar: string;
  source: string; scoreReason: string;
  nbaIcon: string; nbaLabel: string; nbaGhost?: boolean;
  number?: string;
  // Optional rich detail — only set on leads we want to deep-link into.
  email?: string;
  phone?: string;
  advisor?: string;
  scoreLabel?: string;     // "Hot lead" etc.
  scoreDesc?: string;      // "High intent, high fit. Best contacted tonight ~9 PM IST."
  signals?: { text: string; weight: string; kind: "pos" | "neg" | "neu" }[];
  nbaCard?: {
    confidence: number;
    headline: string;
    why: string;
  };
  timeline?: {
    when: string;
    kind: "ai" | "human";
    by: string;
    tag: { label: string; cls: "ai" | "you" };
    text: string;
    quote?: string;
    iconKey?: string;
    iconBg?: string;
    iconStroke?: string;
    minutesAgo?: number;
  }[];
  agentsOnLead?: { name: string; status: string; glyph: string; icon: string; badge: { label: string; kind: "done" | "run" } }[];
}

const SEED_LEADS: SeedLead[] = [
  {
    number: "LEAD-9842", initials: "AM", name: "Aarav Mehta", city: "Bengaluru", program: "AI Engineer · GenAI",
    cohort: "Cohort 026", value: "₹1.49L", stage: "demo", stageLabel: "Demo no-show",
    score: 89, heat: "hot", avatar: "magenta", source: "instagram_ad",
    scoreReason: "Re-opened pricing 2× last night, watched 78% of free lesson, replied to WhatsApp in 6 min",
    nbaIcon: "send", nbaLabel: "Send re-engagement email",
    email: "aarav.m@gmail.com", phone: "+91 98••• ••231", advisor: "Priya N.",
    scoreLabel: "Hot lead", scoreDesc: "High intent, high fit. Best contacted tonight ~9 PM IST.",
    signals: [
      { text: "Re-opened pricing 2× last night", weight: "+14", kind: "pos" },
      { text: "Watched 78% of free lesson", weight: "+11", kind: "pos" },
      { text: "Missed live demo (no-show)", weight: "−9", kind: "neg" },
      { text: "Replied to WhatsApp in 6 min", weight: "+8", kind: "pos" },
    ],
    nbaCard: {
      confidence: 92,
      headline: 'Send the "agentic capstone walkthrough" re-engagement email now — Aarav opens email at ~9 PM IST.',
      why: "He attended 2 of 3 pre-demo touchpoints, watched 78% of the free Module 1 lesson, but missed the live demo on May 14. Re-engagement within 48h of a no-show converts 3.2× better. Draft is ready.",
    },
    timeline: [
      { when: "Today · 9:42 AM", kind: "ai", by: "Outreach Agent", tag: { label: "AI · Draft", cls: "ai" }, text: "Drafted a re-engagement email referencing his interest in the agentic capstone and the May 14 no-show.", quote: '"Hi Aarav — you asked about the multi-agent capstone before the demo. I recorded a 4-min walkthrough of exactly that build. Want me to hold your seat for Cohort 026?"', minutesAgo: 2 },
      { when: "Today · 6:10 AM", kind: "ai", by: "Lead Scoring Agent", tag: { label: "AI · Score", cls: "ai" }, text: "Re-scored Aarav 74 → 89 after he re-opened the pricing page twice last night and replied to a WhatsApp nudge.", minutesAgo: 215 },
      { when: "May 14 · 7:05 PM", kind: "human", by: "You · Priya (advisor)", tag: { label: "Human", cls: "you" }, text: 'Logged a no-show for the live demo. Sent a one-line "sorry we missed you" from mobile.', minutesAgo: 1500 },
      { when: "May 14 · 2:00 PM", kind: "ai", by: "Scheduler Agent", tag: { label: "AI · Booked", cls: "ai" }, text: "Booked the live demo for 7 PM IST and sent calendar + WhatsApp reminders at T-24h and T-1h.", minutesAgo: 1800 },
      { when: "May 14 · 11:20 AM", kind: "human", by: "Aarav Mehta", tag: { label: "Lead", cls: "you" }, text: 'Watched 78% of the free Module 1 lesson, then asked in chat: "does the capstone actually deploy a multi-agent system?"', minutesAgo: 1960 },
    ],
    agentsOnLead: [
      { name: "Outreach Agent", status: "Draft ready · awaiting approval", glyph: "magenta", icon: "spark", badge: { label: "queued", kind: "run" } },
      { name: "Scoring Agent", status: "Re-scored 18 min ago", glyph: "violet", icon: "star", badge: { label: "done", kind: "done" } },
      { name: "Scheduler Agent", status: "Holding a 7 PM slot for tonight", glyph: "blue", icon: "clock", badge: { label: "standby", kind: "run" } },
    ],
  },
  { number: "LEAD-9810", initials: "SR", name: "Sneha Reddy", city: "Hyderabad", program: "Full Stack + AI", cohort: "Cohort 023", value: "₹1.49L", stage: "qual", stageLabel: "Qualified", score: 91, heat: "hot", avatar: "violet", source: "web", scoreReason: "Visited pricing 3× + replied to demo invite in 4 min. 62 → 89.", nbaIcon: "clock", nbaLabel: "Book demo · today 7 PM" },
  { number: "LEAD-9788", initials: "KN", name: "Karthik Nair", city: "Kochi", program: "Salesforce · Agentforce", cohort: "Cohort 015", value: "₹99k", stage: "demo", stageLabel: "Demo booked", score: 84, heat: "hot", avatar: "blue", source: "referral", scoreReason: "Strong intent, demo booked Wed 7 PM IST", nbaIcon: "mail", nbaLabel: "Send prep checklist" },
  { number: "LEAD-9756", initials: "PV", name: "Priya Varma", city: "Pune", program: "AI & Data Science", cohort: "Cohort 08", value: "₹1.19L", stage: "qual", stageLabel: "Qualified", score: 64, heat: "warm", avatar: "ochre", source: "webinar", scoreReason: "Attended Sunday webinar; medium intent", nbaIcon: "star", nbaLabel: "Nurture · send case study" },
  { number: "LEAD-9701", initials: "RT", name: "Rahul Thomas", city: "Chennai", program: "DevOps + AI", cohort: "Cohort 015", value: "₹99k", stage: "new", stageLabel: "New inbound", score: 58, heat: "warm", avatar: "blue", source: "web", scoreReason: "New inbound · cold-warm", nbaIcon: "send", nbaLabel: "Send welcome + syllabus" },
  { number: "LEAD-9655", initials: "MJ", name: "Megha Jain", city: "Delhi", program: "Power BI + AI", cohort: "Cohort 014", value: "₹59k", stage: "won", stageLabel: "Enrolled", score: 96, heat: "hot", avatar: "ok", source: "referral", scoreReason: "Paid · onboarding complete", nbaIcon: "check", nbaLabel: "Ask for referral" },
  { number: "LEAD-9590", initials: "AB", name: "Arjun Bose", city: "Kolkata", program: "Cyber Security + AI", cohort: "Cohort 011", value: "₹1.09L", stage: "new", stageLabel: "New inbound", score: 34, heat: "cold", avatar: "mute", source: "paid", scoreReason: "Low intent · drip only", nbaIcon: "info", nbaLabel: "Low intent · drip only", nbaGhost: true },
  { number: "LEAD-9588", initials: "DN", name: "Divya Nambiar", city: "Online", program: "AI & Data Science", cohort: "Cohort 08", value: "₹1.19L", stage: "new", stageLabel: "New inbound", score: 52, heat: "warm", avatar: "ochre", source: "web", scoreReason: "Inbound · needs qualification", nbaIcon: "mail", nbaLabel: "Qualify via 3 questions" },
  { number: "LEAD-9720", initials: "VG", name: "Vikram Gowda", city: "Mysuru", program: "Salesforce · Agentforce", cohort: "Cohort 015", value: "₹99k", stage: "qual", stageLabel: "Qualified", score: 66, heat: "warm", avatar: "blue", source: "webinar", scoreReason: "Asking about cohort outcomes", nbaIcon: "mail", nbaLabel: "Share alumni outcomes" },
  { number: "LEAD-9540", initials: "IS", name: "Isha Sharma", city: "Noida", program: "AI Engineer · GenAI", cohort: "Cohort 026", value: "asked re: EMI", stage: "neg", stageLabel: "Negotiation", score: 82, heat: "hot", avatar: "vm", source: "web", scoreReason: "Asked about EMI + scholarship", nbaIcon: "money", nbaLabel: "Send EMI + scholarship offer" },
  { number: "LEAD-9512", initials: "HG", name: "Harsha Gupta", city: "Online", program: "Full Stack + AI", cohort: "Cohort 023", value: "verbal yes", stage: "neg", stageLabel: "Negotiation", score: 88, heat: "hot", avatar: "ok", source: "referral", scoreReason: "Verbal yes — payment pending", nbaIcon: "check", nbaLabel: "Send payment link" },
  { number: "LEAD-9601", initials: "NK", name: "Nikhil Kumar", city: "Hyderabad", program: "AI & Data Science", cohort: "Cohort 08 · paid", value: "₹1.19L", stage: "won", stageLabel: "Enrolled", score: 93, heat: "hot", avatar: "magenta", source: "web", scoreReason: "Paid · onboarding complete", nbaIcon: "check", nbaLabel: "Onboarding complete", nbaGhost: true },
];

const AGENT_CATALOG = [
  { key: "outreach",   name: "Outreach Agent",       domain: "sales", operatesOn: "lead" },
  { key: "scoring",    name: "Lead Scoring Agent",   domain: "sales", operatesOn: "lead" },
  { key: "nba",        name: "Next-Best-Action Agent", domain: "sales", operatesOn: "lead" },
  { key: "scheduler",  name: "Scheduler Agent",      domain: "sales", operatesOn: "lead" },
  { key: "forecast",   name: "Forecast Agent",       domain: "sales", operatesOn: "deal" },
  { key: "triage",     name: "Service Triage",       domain: "service", operatesOn: "service_case" },
  { key: "onboarding", name: "Onboarding Agent",     domain: "service", operatesOn: "onboarding_task" },
];

const AGENT_RUN_CARDS = [
  { agentKey: "outreach",  status: "running", live: true,  target: "drafting 9 emails",  metricLabel: "sent this week", metricValue: "142", rightPill: "68% reply rate", glyph: "magenta", iconKey: "spark", desc: "Writes personalised follow-ups from each lead's demo notes & program interest, then queues for your approval.", steps: [{ label: "plan", state: "done" }, { label: "retrieve_context", state: "done" }, { label: "draft", state: "done" }, { label: "approval_gate", state: "active" }, { label: "execute", state: "queued" }] },
  { agentKey: "scoring",   status: "running", live: true,  target: "38 leads queued",   metricLabel: "leads scored",   metricValue: "248", rightPill: "live",           glyph: "violet",  iconKey: "star",  desc: "Scores every inbound lead on intent, fit and urgency using site activity, demo attendance and reply sentiment.", steps: [{ label: "plan", state: "done" }, { label: "retrieve_context", state: "done" }, { label: "score", state: "active" }, { label: "write_back", state: "queued" }] },
  { agentKey: "scheduler", status: "completed", live: false, target: "next run 2:00 PM",  metricLabel: "demos booked",   metricValue: "31",  rightPill: "idle",           glyph: "blue",    iconKey: "clock", desc: "Finds demo slots that fit each lead's timezone, books them, and sends calendar invites with the right advisor.", steps: [{ label: "plan", state: "done" }, { label: "book_meeting", state: "done" }, { label: "send_whatsapp", state: "done" }, { label: "write_back", state: "done" }] },
  { agentKey: "forecast",  status: "completed", live: false, target: "last run 8:00 AM",  metricLabel: "pipeline",       metricValue: "₹2.4Cr", rightPill: "86% to target",  glyph: "ochre",   iconKey: "chart", desc: "Projects cohort fill, revenue and at-risk enrolments — and flags which leads to prioritise to hit target.", steps: [{ label: "plan", state: "done" }, { label: "retrieve_context", state: "done" }, { label: "forecast", state: "done" }, { label: "write_back", state: "done" }] },
];

const FEED = [
  { iconBg: "rgba(199,25,122,.1)", iconStroke: "#C7197A", iconKey: "spark", actorType: "agent", actorName: "Outreach Agent", verb: "drafted a re-engagement email for", subject: "Aarav Mehta", detail: '"You asked about the agentic capstone on May 14 — here\'s a 4-min walkthrough." Ready for your approval.', tag: "need", offsetMin: 2, leadNumber: "LEAD-9842", approve: true },
  { iconBg: "rgba(107,31,184,.1)", iconStroke: "#6B1FB8", iconKey: "star", actorType: "agent", actorName: "Lead Scoring Agent", verb: "moved", subject: "Sneha Reddy", verbAfter: "from Warm → Hot", detail: "Visited pricing 3× + replied to demo invite in 4 min. Score jumped 62 → 89.", tag: "auto", offsetMin: 18, leadNumber: "LEAD-9810" },
  { iconBg: "rgba(31,63,207,.08)", iconStroke: "#1F3FCF", iconKey: "clock", actorType: "agent", actorName: "Scheduler Agent", verb: "booked a demo for", subject: "Karthik Nair", detail: "Wed 31 May · 7:00 PM IST with advisor Priya. Calendar invite sent + WhatsApp confirmation.", tag: "sent", offsetMin: 60, leadNumber: "LEAD-9788" },
  { iconBg: "rgba(46,158,106,.1)", iconStroke: "#2E9E6A", iconKey: "mail", actorType: "agent", actorName: "Outreach Agent", verb: "sent 9 approved follow-ups to the", subject: "Agentforce cohort", detail: '3 opened within the hour · 1 replied "ready to enrol".', tag: "sent", offsetMin: 180 },
];

// ─── main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("→ resetting tenant data (CASCADE)…");
  // Delete in dependency order. RLS escape (current_tenant() IS NULL) lets this run.
  await pool.query(`SET LOCAL app.tenant_id = ''`);
  // audit_log is intentionally insert-only (post-0004 trigger). Skip it.
  // Order: child rows first, then parents.
  for (const t of [
    "agent_assignment", "lead_score_signal",
    "approval", "approval_policy", "activity", "relationship",
    "attachment", "embedding", "agent_run", "agent",
    "support_case",
    "onboarding_task", "service_case", "deal", "lead",
    "batch_assignment", "enrolment",
    "work_item", "cohort", "course", "program",
    // user_group_member / user_group_permission / user_group / app_session
    // tables no longer exist post-Auth0 cutover (see post-0039 migration).
    "party_role", "party", "app_user", "tenant",
  ]) {
    await pool.query(`DELETE FROM ${t}`);
  }

  // ── Tenant + admin user
  console.log("→ creating tenant + users…");
  const [t] = await db.insert(tenant).values({ name: TENANT_NAME, region: "india" }).returning();
  const tenantId = t!.id;
  console.log("  tenant:", tenantId);

  const [admin] = await db.insert(appUser).values({
    tenantId, email: "manikanta@edify.io", name: "Manikanta", role: "admin",
  }).returning();
  const [advisorPriya] = await db.insert(appUser).values({
    tenantId, email: "priya@edify.io", name: "Priya N.", role: "advisor",
  }).returning();
  const [advisorRahul] = await db.insert(appUser).values({
    tenantId, email: "rahul@edify.io", name: "Rahul", role: "advisor",
  }).returning();
  void advisorRahul;

  // Service-rep employees who own cases. Manikanta is already the admin
  // above and is also the first case-handling employee.
  const ticketAgentSpecs = [
    { name: "Anirudh", email: "anirudh@edify.io", role: "service_rep" as const },
    { name: "Sheshi",  email: "sheshi@edify.io",  role: "service_rep" as const },
    { name: "Venki",   email: "venki@edify.io",   role: "service_rep" as const },
    { name: "Akhil",   email: "akhil@edify.io",   role: "service_rep" as const },
    { name: "Roshni",  email: "roshni@edify.io",  role: "service_rep" as const },
  ];
  const ticketAgents: Record<string, string> = { Manikanta: admin!.id };
  for (const e of ticketAgentSpecs) {
    const [u] = await db.insert(appUser).values({ tenantId, ...e }).returning();
    ticketAgents[e.name] = u!.id;
  }

  // ── Super-user (crmadmin) — kept as a placeholder row so legacy data
  // that references this email still resolves. Real login is via Auth0;
  // this row will be backfilled with an auth0_sub the first time someone
  // signs in with the matching email (or operators can manually set it).
  console.log("→ creating super-user crmadmin@gmail.com…");
  const [crmAdmin] = await db.insert(appUser).values({
    tenantId,
    email: "crmadmin@gmail.com",
    name: "CRM Admin",
    role: "admin",
  }).returning();

  // Group seeding is gone — Auth0 owns Roles + Permissions now. The
  // crmAdmin / admin / advisor users are only referenced for FK display
  // (activity actor names, support_case assignees). Real permissions
  // ride on the Auth0 JWT.
  void crmAdmin;
  void advisorPriya;

  // ── Programs (with price) + courses + batches per course
  console.log("→ catalog (programs + courses + batches)…");

  // Each program has a price + a course list. Some programs are single-course
  // (DevOps + AI = one course), others are multi-course (AI & Data Science = 5 courses).
  // Each course gets 2 batches (one running, one upcoming) across morning/evening slots.
  const PROGRAM_CATALOG: Record<string, { price: number; courses: string[] }> = {
    "AI Engineer · GenAI":     { price: 149000, courses: ["GenAI Foundations", "Agentic Systems", "Capstone"] },
    "AI & Data Science":       { price: 119000, courses: ["Python", "SQL", "Power BI", "Data Science", "AI"] },
    "Full Stack + AI":         { price: 149000, courses: ["JavaScript", "React", "Node.js", "Databases", "AI Tooling"] },
    "Salesforce · Agentforce": { price:  99000, courses: ["Salesforce Admin", "Apex", "Agentforce"] },
    "Power BI + AI":           { price:  59000, courses: ["Power BI Foundations", "DAX", "AI Insights"] },
    "DevOps + AI":             { price:  99000, courses: ["Linux & Shell", "Docker & K8s", "CI/CD", "AIOps"] },
    "Cyber Security + AI":     { price: 109000, courses: ["Network Security", "Threat Intel", "AI for SecOps"] },
  };

  const programNames = [...new Set(SEED_LEADS.map((l) => l.program))];
  const programIds: Record<string, string> = {};
  for (const name of programNames) {
    const meta = PROGRAM_CATALOG[name] ?? { price: 99000, courses: ["General"] };
    const [p] = await db.insert(program).values({
      tenantId, name, price: meta.price.toString(),
    }).returning();
    programIds[name] = p!.id;
  }

  // courses
  const courseIds: Record<string, string> = {}; // key = `${programName}|${courseName}`
  for (const [progName, progId] of Object.entries(programIds)) {
    const meta = PROGRAM_CATALOG[progName] ?? { courses: ["General"] };
    for (const courseName of meta.courses) {
      const code = abbr(progName) + "-" + abbr(courseName);
      const [c] = await db.insert(course).values({
        tenantId, programId: progId, name: courseName, code, enabled: true,
      }).returning();
      courseIds[`${progName}|${courseName}`] = c!.id;
    }
  }

  // batches: each course gets 2 batches (running + upcoming, alternating slots)
  const cohortIds: Record<string, string> = {}; // key = `${programName}|${courseName}|${batchSuffix}`
  const SLOTS: { slot: "morning" | "evening"; time: string }[] = [
    { slot: "morning", time: "9:00 AM – 11:00 AM" },
    { slot: "evening", time: "7:00 PM – 9:00 PM" },
  ];
  const STATUS_ROLL: ("running" | "upcoming")[] = ["running", "upcoming"];

  for (const [progName, _progId] of Object.entries(programIds)) {
    void _progId;
    const meta = PROGRAM_CATALOG[progName] ?? { courses: ["General"] };
    for (const courseName of meta.courses) {
      const cId = courseIds[`${progName}|${courseName}`]!;
      let i = 0;
      for (const plan of SLOTS) {
        i += 1;
        const status = STATUS_ROLL[(i - 1) % STATUS_ROLL.length]!;
        const offsetDays = status === "running" ? -30 : 60;
        const start = new Date(Date.UTC(2026, 5, 1) + offsetDays * 86400_000);
        const end   = new Date(start.getTime() + 90 * 86400_000);
        const monthCode = start.toLocaleDateString("en-IN", { month: "short", year: "numeric" }).replace(" ", "-");
        const code = `${abbr(courseName)}-${monthCode}-${plan.slot[0]!.toUpperCase()}`;
        const name = `${courseName} · ${monthCode} · ${cap(plan.slot)}`;
        const [c] = await db.insert(cohort).values({
          tenantId,
          courseId: cId,
          name,
          code,
          slot: plan.slot,
          timeLabel: plan.time,
          schedule: plan.slot === "morning" ? "Mon · Wed · Fri" : "Tue · Thu · Sat",
          startDate: start.toISOString().slice(0, 10),
          endDate:   end.toISOString().slice(0, 10),
          seats: 30,
          status,
          enabled: true,
        }).returning();
        cohortIds[`${progName}|${courseName}|${name}`] = c!.id;
      }
    }
  }

  function abbr(s: string): string {
    return s.split(/\s+/).map((w) => w[0]).join("").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();
  }
  function cap(s: string): string { return s[0]!.toUpperCase() + s.slice(1); }

  // ── Agent catalog (must be before leads — agent_assignment FKs to agent.id)
  console.log("→ agent catalog…");
  const agentIds: Record<string, string> = {};
  for (const a of AGENT_CATALOG) {
    const [row] = await db.insert(agent).values({ tenantId, ...a }).returning();
    agentIds[a.key] = row!.id;
  }

  // ── Leads (party + work_item + lead extension + signals + agent_assignment)
  console.log("→ leads…");
  const leadByNumber: Record<string, { workItemId: string; partyId: string }> = {};

  const SOURCE_LABEL: Record<string, string> = {
    instagram_ad: "Instagram ad",
    web: "Website form",
    referral: "Referral",
    webinar: "Webinar",
    paid: "Paid search",
  };

  // Heat-driven lead score description (shown next to the big ring)
  const HEAT_LABEL = { hot: "Hot lead", warm: "Warm lead", cold: "Cold lead" } as const;
  const HEAT_DESC = {
    hot:  "High intent, high fit. Move fast — agents flag this lead as a priority for outreach today.",
    warm: "Engaged but not yet decisive. Keep nurturing — share outcomes and case studies.",
    cold: "Low signal so far. Drip content automatically; revisit only if intent rises.",
  } as const;

  // Build a deterministic signals list per lead from its score/stage/source.
  function deriveSignals(score: number, stage: string, source: string): { text: string; weight: string; kind: "pos" | "neg" | "neu" }[] {
    const out: { text: string; weight: string; kind: "pos" | "neg" | "neu" }[] = [];
    if (score >= 85) {
      out.push({ text: "Visited pricing page in last 24h", weight: "+12", kind: "pos" });
      out.push({ text: "Replied to last touch within an hour", weight: "+9", kind: "pos" });
    } else if (score >= 60) {
      out.push({ text: "Watched intro lesson · 60%+", weight: "+8", kind: "pos" });
      out.push({ text: "Opened last 2 emails", weight: "+5", kind: "pos" });
    } else if (score >= 40) {
      out.push({ text: "Attended free webinar", weight: "+6", kind: "pos" });
      out.push({ text: "Slow email open rate", weight: "−4", kind: "neg" });
    } else {
      out.push({ text: "Limited site activity", weight: "−6", kind: "neg" });
      out.push({ text: "No reply in 7 days", weight: "−5", kind: "neg" });
    }
    if (stage === "demo")  out.push({ text: "Booked a live demo", weight: "+11", kind: "pos" });
    if (stage === "neg")   out.push({ text: "Asked about pricing / EMI", weight: "+10", kind: "pos" });
    if (stage === "won")   out.push({ text: "Enrolment payment confirmed", weight: "+15", kind: "pos" });
    if (stage === "new")   out.push({ text: "First-touch · cold start", weight: "neutral", kind: "neu" });
    if (source === "referral") out.push({ text: "Came in via referral · pre-qualified", weight: "+7", kind: "pos" });
    return out.slice(0, 4);
  }

  // Build a Next-best-action card row per lead.
  function deriveNba(name: string, heat: "hot" | "warm" | "cold", stage: string, score: number, nbaLabel: string, programName: string) {
    const firstName = name.split(" ")[0]!;
    const confidence = Math.min(95, Math.max(55, score - 5));
    if (stage === "won") {
      return { confidence, headline: `${firstName} is enrolled — ask for a referral within the next 7 days.`,
        why: `Recent enrollees in ${programName} convert into referrals at 31% when asked in the first onboarding week.` };
    }
    if (stage === "neg") {
      return { confidence, headline: `Send the next step: ${nbaLabel.toLowerCase()}.`,
        why: `${firstName} has signalled buying intent — agent has prepared the relevant offer. Approve to send within the hour.` };
    }
    if (stage === "demo") {
      return { confidence, headline: `${firstName} is in the demo flow — ${nbaLabel.toLowerCase()}.`,
        why: `Action keeps momentum going while ${firstName} is still warm. Conversion drops 3.2× after 48h of silence post-demo.` };
    }
    if (heat === "warm") {
      return { confidence, headline: `${firstName} is warming up — share an alumni outcome from ${programName}.`,
        why: `Mid-funnel leads convert 1.8× better when shown a peer outcome before the discovery call.` };
    }
    if (heat === "cold") {
      return { confidence, headline: `Don't disturb yet — keep ${firstName} on the drip sequence.`,
        why: `Score is too low for direct outreach. The drip will deliver one weekly nudge until intent rises above 50.` };
    }
    return { confidence, headline: nbaLabel,
      why: `Agent flagged this as the highest-leverage move based on the current signals.` };
  }

  // Per-lead agent assignment list (which agents are working this lead)
  function deriveAgentAssignments(stage: string, score: number) {
    type Row = { agentKey: string; status: string; badgeLabel: string; badgeKind: "run" | "done"; rank: number };
    const rows: Row[] = [];
    rows.push({
      agentKey: "scoring",
      status: `Last scored at ${score} · ${score >= 80 ? "hot" : score >= 50 ? "warm" : "cold"}`,
      badgeLabel: "done", badgeKind: "done", rank: 10,
    });
    if (stage === "demo" || stage === "qual") {
      rows.push({ agentKey: "outreach",  status: "Drafted next message · awaiting approval", badgeLabel: "queued",  badgeKind: "run",  rank: 0 });
      rows.push({ agentKey: "scheduler", status: "Watching calendar for the next demo slot",  badgeLabel: "standby", badgeKind: "run",  rank: 20 });
    } else if (stage === "neg") {
      rows.push({ agentKey: "outreach",  status: "Prepared offer · pending advisor sign-off", badgeLabel: "queued",  badgeKind: "run",  rank: 0 });
    } else if (stage === "won") {
      rows.push({ agentKey: "onboarding",status: "Tracking onboarding milestones",             badgeLabel: "running", badgeKind: "run",  rank: 0 });
    } else if (stage === "new") {
      rows.push({ agentKey: "outreach",  status: "Welcome + syllabus auto-sent",               badgeLabel: "done",    badgeKind: "done", rank: 0 });
    }
    return rows;
  }

  // 3 timeline activity entries per lead, anchored to the work_item creation time.
  function deriveTimeline(name: string, stage: string, score: number, createdAtIso: Date) {
    const firstName = name.split(" ")[0]!;
    const fmt = (d: Date) =>
      d.toLocaleDateString("en-IN", { month: "short", day: "numeric" }) +
      " · " +
      d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
    // All offsets are NEGATIVE — these things happened in the past, before
    // createdAt. The lead first showed up (-180m), then was scored (-120m),
    // then the agent drafted a touch (-45m).
    const out = [
      {
        offsetMin: -180,
        kind: "human" as const, by: firstName, tagLabel: "Lead",
        text: stage === "new"   ? "Submitted the inbound form."
            : stage === "demo"  ? "Booked a demo slot."
            : stage === "won"   ? "Completed payment."
            :                     "Engaged with the most recent agent message.",
      },
      {
        offsetMin: -120,
        kind: "ai" as const, by: "Lead Scoring Agent", tagLabel: "AI · Score",
        text: `Initial score: ${score}. Stage routed to "${stage}".`,
      },
      {
        offsetMin: -45,
        kind: "ai" as const, by: "Outreach Agent", tagLabel: "AI · Draft",
        text: stage === "won"
          ? `Confirmation email sent. ${firstName} is now in the onboarding flow.`
          : `Drafted the next-best touch for ${firstName}.`,
      },
    ].map((e) => ({
      ...e,
      when: fmt(new Date(createdAtIso.getTime() + e.offsetMin * 60_000)),
    }));
    return out;
  }

  for (const L of SEED_LEADS) {
    const email = L.email   ?? `${L.name.toLowerCase().replace(/\s+/g, ".")}@gmail.com`;
    const phone = L.phone   ?? `+91 ${L.initials.charCodeAt(0) % 10}${L.initials.charCodeAt(1) % 10}••• ••${L.score.toString().padStart(3, "0")}`;
    const advisorName = L.advisor ?? (L.score >= 80 ? "Priya N." : L.score >= 50 ? "Rahul" : "Manikanta");
    const sourceLabel = SOURCE_LABEL[L.source] ?? L.source;

    // Map advisor name → app_user.id
    const advisorId =
      advisorName === "Priya N."   ? advisorPriya!.id :
      advisorName === "Rahul"      ? advisorRahul!.id :
                                     admin!.id;

    // Party — email/phone/city as real columns now
    const [partyRow] = await db.insert(party).values({
      tenantId, kind: "person", name: L.name,
      email, phone, city: L.city,
      identifiers: sql`${JSON.stringify({ source: L.source })}::jsonb`,
      attributes: sql`${JSON.stringify({ initials: L.initials || initialsOf(L.name) })}::jsonb`,
    }).returning();

    await db.insert(partyRole).values({ tenantId, partyId: partyRow!.id, role: "lead" });

    const number = L.number ?? await nextNumber("LEAD", "seq_lead");
    const [wi] = await db.insert(workItem).values({
      tenantId, number, type: "lead", partyId: partyRow!.id,
      assigneeId: advisorId,
      state: L.stage === "won" ? "closed_won" : (L.stage === "neg" ? "in_progress" : "open"),
    }).returning();

    // Lead row — every column populated
    const nba = L.nbaCard ?? deriveNba(L.name, L.heat, L.stage, L.score, L.nbaLabel, L.program);
    await db.insert(lead).values({
      workItemId: wi!.id, tenantId,
      source: L.source, sourceLabel,
      score: L.score, scoreReason: L.scoreReason,
      scoreLabel: L.scoreLabel ?? HEAT_LABEL[L.heat],
      scoreDesc:  L.scoreDesc  ?? HEAT_DESC[L.heat],
      heat: L.heat, city: L.city,
      program: L.program,                       // text (denormalized)
      programId: programIds[L.program] ?? null, // FK
      value: L.value,
      stage: L.stage, stageLabel: L.stageLabel,
      advisorId,
      avatar: L.avatar, initials: L.initials,
      nbaIcon: L.nbaIcon, nbaLabel: L.nbaLabel, nbaGhost: !!L.nbaGhost,
      nbaConfidence: nba.confidence,
      nbaHeadline: nba.headline,
      nbaWhy: nba.why,
    });

    // Score signals — real rows
    const signals = L.signals ?? deriveSignals(L.score, L.stage, L.source);
    for (let i = 0; i < signals.length; i++) {
      const s = signals[i]!;
      await db.insert(leadScoreSignal).values({
        tenantId, workItemId: wi!.id,
        text: s.text, weight: s.weight, kind: s.kind, rank: i,
      });
    }

    // Agent assignments — real rows tying lead to agent catalog
    const assignments = L.agentsOnLead
      ? L.agentsOnLead.map((a, i) => {
          const keyMap: Record<string, string> = {
            "Outreach Agent": "outreach", "Scoring Agent": "scoring",
            "Lead Scoring Agent": "scoring", "Scheduler Agent": "scheduler",
            "Onboarding Agent": "onboarding",
          };
          return {
            agentKey: keyMap[a.name] ?? "outreach",
            status: a.status,
            badgeLabel: a.badge.label,
            badgeKind: a.badge.kind,
            rank: i,
          };
        })
      : deriveAgentAssignments(L.stage, L.score);
    for (const a of assignments) {
      const aid = agentIds[a.agentKey];
      if (!aid) continue;
      await db.insert(agentAssignment).values({
        tenantId, workItemId: wi!.id, agentId: aid,
        status: a.status, badgeLabel: a.badgeLabel, badgeKind: a.badgeKind, rank: a.rank,
      }).onConflictDoNothing();
    }

    // Timeline — real activity rows. If lead has hand-seeded entries, use those;
    // otherwise generate a 3-row default tied to work_item.created_at.
    const wiCreatedRow = await db.execute(sql`SELECT created_at FROM work_item WHERE id = ${wi!.id}`);
    const wiCreated = new Date((wiCreatedRow.rows[0] as { created_at: string }).created_at);

    const timeline = L.timeline
      ? L.timeline.map((e) => ({
          when: e.when,
          kind: e.kind,
          by: e.by,
          tagLabel: e.tag.label,
          text: e.text,
          quote: e.quote ?? null,
          ts: e.minutesAgo ? new Date(Date.now() - e.minutesAgo * 60_000) : new Date(),
        }))
      : deriveTimeline(L.name, L.stage, L.score, wiCreated).map((e) => ({
          when: e.when, kind: e.kind, by: e.by, tagLabel: e.tagLabel, text: e.text, quote: null,
          ts: new Date(wiCreated.getTime() + e.offsetMin * 60_000),
        }));

    for (const e of timeline) {
      await db.insert(activity).values({
        tenantId, workItemId: wi!.id, partyId: partyRow!.id,
        actorType: e.kind === "ai" ? "agent" : "user",
        actorName: e.by,
        verb: e.tagLabel,
        detail: e.text,
        tag: e.kind === "ai" ? "ai" : "you",
        payload: sql`${JSON.stringify({ when: e.when, quote: e.quote })}::jsonb`,
        ts: e.ts,
      });
    }

    leadByNumber[number] = { workItemId: wi!.id, partyId: partyRow!.id };
  }

  // ── Agent run cards (each is a work_item type=agent_run + agent_run row)
  console.log("→ agent runs…");
  for (const card of AGENT_RUN_CARDS) {
    const number = await nextNumber("RUN", "seq_run");
    const [wi] = await db.insert(workItem).values({
      tenantId, number, type: "agent_run", state: card.status,
    }).returning();
    await db.insert(agentRun).values({
      workItemId: wi!.id, tenantId,
      agentKey: card.agentKey, runId: `synth-${number}`, status: card.status,
      target: card.target, metricLabel: card.metricLabel, metricValue: card.metricValue,
      rightPill: card.rightPill, glyph: card.glyph, iconKey: card.iconKey, desc: card.desc,
      live: card.live, steps: sql`${JSON.stringify(card.steps)}::jsonb`,
    });
  }

  // ── Activity feed
  console.log("→ activity feed…");
  const now = new Date();
  for (const f of FEED) {
    const ts = new Date(now.getTime() - f.offsetMin * 60_000);
    const wiId = f.leadNumber ? leadByNumber[f.leadNumber]?.workItemId : undefined;
    const partyId = f.leadNumber ? leadByNumber[f.leadNumber]?.partyId : undefined;
    await db.insert(activity).values({
      tenantId, workItemId: wiId, partyId,
      actorType: f.actorType, actorName: f.actorName,
      verb: f.verb, detail: f.detail,
      tag: f.tag, iconKey: f.iconKey, iconBg: f.iconBg, iconStroke: f.iconStroke,
      payload: sql`${JSON.stringify({ subject: f.subject, verbAfter: (f as any).verbAfter ?? null })}::jsonb`,
      ts,
    });
  }

  // ── Approval (the live "needs approval" one for Aarav)
  console.log("→ approvals…");
  const aaravWi = leadByNumber["LEAD-9842"]!.workItemId;
  const [seededApproval] = await db.insert(approval).values({
    tenantId, workItemId: aaravWi,
    actionType: "send_email", mode: "supervised", status: "pending",
    proposed: sql`${JSON.stringify({
      channel: "email",
      subject: "About your agentic capstone walkthrough",
      body: "Hi Aarav — you asked about the multi-agent capstone before the demo. I recorded a 4-min walkthrough of exactly that build. Want me to hold your seat for Cohort 026?",
    })}::jsonb`,
    requestedBy: "outreach",
  }).returning();

  // Link the "needs approval" feed item for Aarav to this approval id so the
  // home-page Approve / Reject buttons render. The first FEED entry is the
  // outreach draft for Aarav (tag: 'need').
  if (seededApproval) {
    await pool.query(`
      UPDATE activity SET payload = payload || $1::jsonb
      WHERE work_item_id = $2 AND tag = 'need' AND actor_name = 'Outreach Agent'
    `, [JSON.stringify({ approvalId: seededApproval.id }), aaravWi]);
  }

  // ── Convert "won" leads to learners (so /learners page has real rows)
  console.log("→ converting 'won' leads to learners…");
  const wonLeads = await pool.query<{ work_item_id: string; party_id: string; program_id: string; name: string }>(`
    SELECT l.work_item_id, wi.party_id, l.program_id, p.name
    FROM lead l
    JOIN work_item wi ON wi.id = l.work_item_id
    JOIN party p      ON p.id  = wi.party_id
    WHERE l.stage = 'won' AND l.program_id IS NOT NULL
  `);

  for (const row of wonLeads.rows) {
    // End-date the lead role
    await pool.query(`
      UPDATE party_role SET valid_to = current_date - 1
      WHERE party_id = $1 AND role = 'lead' AND valid_to IS NULL
    `, [row.party_id]);
    // Add the learner role
    await pool.query(`
      INSERT INTO party_role (tenant_id, party_id, role, valid_from)
      VALUES ($1, $2, 'learner', current_date)
      ON CONFLICT (party_id, role, valid_from) DO NOTHING
    `, [tenantId, row.party_id]);

    // Program enrolment (umbrella). Pull program price for `pricePaid`.
    // Courses + batches are NOT auto-assigned — they're added on the learner
    // record by hand, depending on what the advisor sold.
    const priceR = await pool.query<{ price: string | null }>(
      `SELECT price FROM program WHERE id = $1`, [row.program_id],
    );
    await db.insert(enrolment).values({
      tenantId,
      partyId: row.party_id,
      programId: row.program_id,
      dealId: row.work_item_id,
      status: "active",
      pricePaid: priceR.rows[0]?.price ?? null,
    }).returning();
  }
  console.log(`  ${wonLeads.rows.length} learners enrolled (no courses/batches yet — assign on the learner page)`);

  // ── Cases — sample data for the dashboard
  console.log("→ cases…");
  // Pick a couple of seeded leads + a converted learner so the cross-link demo works.
  const aaravWiId   = leadByNumber["LEAD-9842"]!.workItemId; void aaravWiId;
  const aaravParty  = leadByNumber["LEAD-9842"]!.partyId;
  const sneha       = leadByNumber["LEAD-9810"]!;
  const meghaParty  = leadByNumber["LEAD-9655"]!.partyId; // converted to learner above

  // Pull party email/phone/name for each linked party so we can snapshot them.
  async function partySnapshot(pid: string): Promise<{ name: string; email: string; phone: string }> {
    const r = await pool.query<{ name: string; email: string | null; phone: string | null }>(
      `SELECT name, email, phone FROM party WHERE id = $1`, [pid],
    );
    const row = r.rows[0]!;
    return {
      name: row.name,
      email: row.email ?? `${row.name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
      phone: row.phone ?? "+91 90000 00000",
    };
  }

  const aaravSnap = await partySnapshot(aaravParty);
  const snehaSnap = await partySnapshot(sneha.partyId);
  const meghaSnap = await partySnapshot(meghaParty);

  type SeedCase = {
    subject: string;
    description: string;
    requesterName: string;
    requesterEmail: string;
    requesterPhone: string;
    requesterKind: "lead" | "learner" | "external";
    partyId: string | null;
    category: string;
    priority: number;
    status: "open" | "in_progress" | "pending" | "resolved" | "closed";
    assigneeName: string;
    dueOffsetHours: number;       // hours from "now"; negative = overdue
    remindOffsetHours: number | null;
    resolution?: string;
    resolutionCode?: string;
  };

  const NOW = Date.now();
  const cases: SeedCase[] = [
    {
      subject: "Cohort 026 onboarding link not working",
      description: "Aarav says he is unable to access the onboarding portal — the link in the welcome email returns 404.",
      requesterName: aaravSnap.name, requesterEmail: aaravSnap.email, requesterPhone: aaravSnap.phone,
      requesterKind: "lead", partyId: aaravParty,
      category: "onboarding", priority: 1, status: "in_progress",
      assigneeName: "Anirudh", dueOffsetHours: 6, remindOffsetHours: 2,
    },
    {
      subject: "Refund requested — Salesforce program",
      description: "Sneha wants to switch from the Salesforce track to AI Engineer · GenAI before the cohort starts. Asking about refund + transfer.",
      requesterName: snehaSnap.name, requesterEmail: snehaSnap.email, requesterPhone: snehaSnap.phone,
      requesterKind: "lead", partyId: sneha.partyId,
      category: "refund", priority: 2, status: "open",
      assigneeName: "Sheshi", dueOffsetHours: 24, remindOffsetHours: 8,
    },
    {
      subject: "Payment receipt not received",
      description: "Megha completed payment last week but has not received the official receipt. Needs it for company reimbursement.",
      requesterName: meghaSnap.name, requesterEmail: meghaSnap.email, requesterPhone: meghaSnap.phone,
      requesterKind: "learner", partyId: meghaParty,
      category: "billing", priority: 3, status: "pending",
      assigneeName: "Venki", dueOffsetHours: 48, remindOffsetHours: 24,
    },
    {
      subject: "Demo session crashed midway — need recording",
      description: "External prospect attended yesterday's demo. Zoom dropped at 27 min. Asking for the recording so they can finish watching.",
      requesterName: "Karan Joshi", requesterEmail: "karan.j@hotmail.com", requesterPhone: "+91 99876 11234",
      requesterKind: "external", partyId: null,
      category: "technical", priority: 2, status: "open",
      assigneeName: "Akhil", dueOffsetHours: -3, remindOffsetHours: null,   // OVERDUE
    },
    {
      subject: "Course material — Power BI module 4 missing",
      description: "Learner reports module 4 of the Power BI course shows '0 lessons'. Likely an LMS publish error.",
      requesterName: "Sanjay Pillai", requesterEmail: "sanjay.pillai@gmail.com", requesterPhone: "+91 98421 55432",
      requesterKind: "external", partyId: null,
      category: "content_lms", priority: 3, status: "in_progress",
      assigneeName: "Roshni", dueOffsetHours: 72, remindOffsetHours: 48,
    },
    {
      subject: "Certificate name spelling correction",
      description: "Name printed as 'Vikram G' instead of 'Vikram Gowda' on the completion certificate.",
      requesterName: "Vikram Gowda", requesterEmail: "vikram.gowda@gmail.com", requesterPhone: "+91 90123 44556",
      requesterKind: "external", partyId: null,
      category: "certificate", priority: 4, status: "closed",
      assigneeName: "Manikanta", dueOffsetHours: -120, remindOffsetHours: null,
      resolution: "Reissued certificate with correct full name. Emailed PDF + LinkedIn share link to Vikram. Confirmed receipt.",
      resolutionCode: "fixed",
    },
    {
      subject: "Request to defer cohort by one month",
      description: "Hospital admission in family — needs to push cohort start by 4 weeks.",
      requesterName: "Anita Rao", requesterEmail: "anita.rao@gmail.com", requesterPhone: "+91 98765 22110",
      requesterKind: "external", partyId: null,
      category: "cohort_batch", priority: 3, status: "resolved",
      assigneeName: "Sheshi", dueOffsetHours: -36, remindOffsetHours: null,
      resolution: "Moved Anita to Cohort 027 (next month evening batch). Updated her welcome pack and notified the academic team.",
      resolutionCode: "fixed",
    },
  ];

  for (let i = 0; i < cases.length; i++) {
    const T = cases[i]!;
    const numR = await pool.query<{ n: string }>(`SELECT nextval('seq_support_case')::text AS n`);
    const number = `CSE-${numR.rows[0]!.n}`;

    const dueAt    = new Date(NOW + T.dueOffsetHours * 3600_000);
    const remindAt = T.remindOffsetHours == null ? null : new Date(NOW + T.remindOffsetHours * 3600_000);
    const wiState  = T.status === "closed" || T.status === "resolved"
      ? "closed_won"
      : T.status === "in_progress"
        ? "in_progress"
        : "open";

    const assigneeId = ticketAgents[T.assigneeName] ?? admin!.id;

    const [wi] = await db.insert(workItem).values({
      tenantId,
      number,
      type: "support_case",
      partyId: T.partyId ?? undefined,
      assigneeId,
      state: wiState,
    }).returning();

    const isClosed = T.status === "closed";
    const isResolved = T.status === "resolved" || T.status === "closed";

    await db.insert(supportCase).values({
      workItemId: wi!.id,
      tenantId,
      requesterName: T.requesterName,
      requesterEmail: T.requesterEmail,
      requesterPhone: T.requesterPhone,
      requesterKind: T.requesterKind,
      partyId: T.partyId ?? undefined,
      subject: T.subject,
      description: T.description,
      category: T.category,
      priority: T.priority,
      status: T.status,
      dueAt,
      remindAt: remindAt ?? undefined,
      resolution: T.resolution ?? undefined,
      resolutionCode: T.resolutionCode ?? undefined,
      resolvedAt: isResolved ? new Date(NOW + T.dueOffsetHours * 3600_000 - 1800_000) : undefined,
      closedAt:   isClosed   ? new Date(NOW + T.dueOffsetHours * 3600_000 - 1500_000) : undefined,
      createdById: admin!.id,
    });

    // Activity row — case created
    await db.insert(activity).values({
      tenantId,
      workItemId: wi!.id,
      partyId: T.partyId ?? undefined,
      actorType: "user",
      actorName: "Manikanta",
      verb: "Case created",
      detail: T.subject,
      tag: "you",
      payload: sql`${JSON.stringify({ when: "Earlier today", kind: "create" })}::jsonb`,
      ts: new Date(NOW - (i + 1) * 3600_000),
    });

    // Activity row — assigned
    await db.insert(activity).values({
      tenantId,
      workItemId: wi!.id,
      partyId: T.partyId ?? undefined,
      actorType: "user",
      actorName: "Manikanta",
      verb: "Assigned",
      detail: `Assignee: unassigned → ${T.assigneeName}`,
      tag: "you",
      payload: sql`${JSON.stringify({ when: "Earlier today", kind: "assign" })}::jsonb`,
      ts: new Date(NOW - (i + 1) * 3600_000 + 60_000),
    });

    if (T.status === "in_progress") {
      await db.insert(activity).values({
        tenantId,
        workItemId: wi!.id,
        partyId: T.partyId ?? undefined,
        actorType: "user",
        actorName: T.assigneeName,
        verb: "Status",
        detail: "Status: open → in_progress",
        tag: "you",
        payload: sql`${JSON.stringify({ when: "Just now", kind: "status" })}::jsonb`,
        ts: new Date(NOW - (i + 1) * 3600_000 + 600_000),
      });
    }

    if (isResolved) {
      await db.insert(activity).values({
        tenantId,
        workItemId: wi!.id,
        partyId: T.partyId ?? undefined,
        actorType: "user",
        actorName: T.assigneeName,
        verb: isClosed ? "Closed" : "Resolved",
        detail: T.resolution ?? "",
        tag: "you",
        payload: sql`${JSON.stringify({ when: "Earlier", kind: isClosed ? "close" : "resolve", resolutionCode: T.resolutionCode })}::jsonb`,
        ts: new Date(NOW + T.dueOffsetHours * 3600_000 - 1500_000),
      });
    }
  }
  console.log(`  ${cases.length} cases seeded across ${Object.keys(ticketAgents).length} employees`);

  console.log("✓ seed complete");
  await pool.end();
}

main().catch((err) => {
  console.error("✗ seed failed:", err);
  process.exit(1);
});
