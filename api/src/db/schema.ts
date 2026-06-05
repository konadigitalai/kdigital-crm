// Digital Edify Agentic CRM — Drizzle schema (full doc-03 model)
// Skips only: metadata layer (record_type/field_def/state_model) and activity partitioning.
// Tenant-scoped throughout. RLS + sequences are added in 0001_post_drizzle.sql (raw SQL).

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// pgvector — Drizzle has no native vector type yet, declare a custom one.
// Dim 1536 matches OpenAI text-embedding-3-small / Gemini text-embedding-004.
const vector = (name: string, opts: { dimensions: number }) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${opts.dimensions})`;
    },
    toDriver(value: number[]) {
      return `[${value.join(",")}]`;
    },
    fromDriver(value: string) {
      return value
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map(Number);
    },
  })(name);

// ─── Tenancy ──────────────────────────────────────────────────────────────

export const tenant = pgTable("tenant", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  region: text("region").notNull().default("india"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const appUser = pgTable(
  "app_user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    auth0Sub: text("auth0_sub"), // nullable while auth is bypassed
    email: text("email").notNull(),
    name: text("name"),
    role: text("role").notNull().default("advisor"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    roleCheck: check("app_user_role_check", sql`${t.role} IN ('admin','advisor','service_rep','readonly')`),
    auth0SubKey: uniqueIndex("app_user_auth0_sub_key").on(t.auth0Sub).where(sql`${t.auth0Sub} IS NOT NULL`),
    tenantEmailKey: uniqueIndex("app_user_tenant_email_key").on(t.tenantId, t.email),
  }),
);

// ─── Party (people / orgs SoR) ────────────────────────────────────────────

export const party = pgTable(
  "party",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    kind: text("kind").notNull().default("person"),
    name: text("name").notNull(),
    email: text("email"),                    // first-class for queries + indexing
    phone: text("phone"),
    city: text("city"),
    identifiers: jsonb("identifiers").notNull().default(sql`'{}'::jsonb`),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindCheck: check("party_kind_check", sql`${t.kind} IN ('person','org')`),
    tenantIdx: index("party_tenant_idx").on(t.tenantId),
    identifiersGin: index("party_identifiers_gin").using("gin", t.identifiers),
    nameTrgm: index("party_name_trgm").using("gin", sql`${t.name} gin_trgm_ops`),
    emailIdx: index("party_email_idx").on(t.tenantId, t.email),
  }),
);

export const partyRole = pgTable(
  "party_role",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    partyId: uuid("party_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    validFrom: date("valid_from").notNull().defaultNow(),
    validTo: date("valid_to"),
  },
  (t) => ({
    roleCheck: check("party_role_role_check", sql`${t.role} IN ('lead','contact','learner','advisor','alumnus')`),
    lookupIdx: index("party_role_lookup_idx").on(t.tenantId, t.role, t.partyId),
    partyValidKey: uniqueIndex("party_role_party_valid_key").on(t.partyId, t.role, t.validFrom),
  }),
);

// ─── Catalog (referenced by deal + enrolment) ─────────────────────────────

export const program = pgTable("program", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  name: text("name").notNull(),
  track: text("track"),
  price: numeric("price", { precision: 12, scale: 2 }),
  enabled: boolean("enabled").notNull().default(true), // soft "active" flag — never delete
  attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
});

// A course is a named module (Python, SQL, Power BI, etc).
// `programId` is an optional tag used as a label in admin views — it does NOT
// constrain who can be assigned the course. Any learner can be assigned any
// course regardless of which program they enrolled into.
// A course is offered as one or more batches (cohorts).
export const course = pgTable("course", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  programId: uuid("program_id").references(() => program.id),
  name: text("name").notNull(),
  code: text("code"),
  enabled: boolean("enabled").notNull().default(true),
  attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
}, (t) => ({
  programIdx: index("course_program_idx").on(t.tenantId, t.programId),
}));

// "cohort" is the table — UI calls it a Batch. Each batch belongs to a course
// (which belongs to a program). Batches are time-fenced runs of one course.
export const cohort = pgTable(
  "cohort",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    courseId: uuid("course_id").references(() => course.id),  // nullable during migration; will be NOT NULL via SQL
    name: text("name").notNull(),
    code: text("code"),                // batch code, e.g. "PY-Jul-2026-AM"
    slot: text("slot"),                // 'morning' | 'afternoon' | 'evening'
    timeLabel: text("time_label"),     // human-readable, e.g. "9:00 AM – 11:00 AM"
    schedule: text("schedule"),        // optional days, e.g. "Mon/Wed/Fri"
    startDate: date("start_date"),
    endDate: date("end_date"),
    seats: integer("seats"),
    status: text("status").notNull().default("upcoming"),  // upcoming | running | completed | cancelled
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => ({
    courseIdx: index("cohort_course_idx").on(t.tenantId, t.courseId),
    statusCheck: check("cohort_status_check", sql`${t.status} IN ('upcoming','running','completed','cancelled')`),
    slotCheck:   check("cohort_slot_check",   sql`${t.slot} IS NULL OR ${t.slot} IN ('morning','afternoon','evening')`),
  }),
);

// ─── Work item spine ──────────────────────────────────────────────────────

export const workItem = pgTable(
  "work_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    number: text("number").notNull(),
    type: text("type").notNull(),
    partyId: uuid("party_id").references(() => party.id),
    assigneeId: uuid("assignee_id").references(() => appUser.id),
    state: text("state").notNull().default("open"),
    priority: integer("priority").notNull().default(3),
    slaDue: timestamp("sla_due", { withTimezone: true }),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    typeCheck: check("work_item_type_check", sql`${t.type} IN ('lead','deal','service_case','onboarding_task','agent_run')`),
    tenantNumberKey: uniqueIndex("work_item_tenant_number_key").on(t.tenantId, t.number),
    tenantTypeStateIdx: index("wi_tenant_type_state_idx").on(t.tenantId, t.type, t.state),
    assigneeIdx: index("wi_assignee_idx").on(t.tenantId, t.assigneeId),
    partyIdx: index("wi_party_idx").on(t.tenantId, t.partyId),
    slaIdx: index("wi_sla_idx").on(t.tenantId, t.slaDue),
    attributesGin: index("wi_attributes_gin").using("gin", t.attributes),
  }),
);

// ─── Class-table extensions (1:1 with work_item) ──────────────────────────

export const lead = pgTable("lead", {
  workItemId: uuid("work_item_id")
    .primaryKey()
    .references(() => workItem.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  source: text("source"),                       // canonical key: 'instagram_ad' | 'web' | 'referral' …
  sourceLabel: text("source_label"),            // human label: 'Instagram ad', 'Website form'
  score: integer("score"),
  scoreReason: text("score_reason"),
  scoreLabel: text("score_label"),              // 'Hot lead' / 'Warm lead' / 'Cold lead'
  scoreDesc: text("score_desc"),                // sentence describing what to do
  heat: text("heat"),                           // hot | warm | cold
  city: text("city"),
  program: text("program"),                     // denormalized program name; programId is the canonical FK
  programId: uuid("program_id").references(() => program.id),
  value: text("value"),                         // free-form: "₹1.49L" / "verbal yes" / "asked re: EMI"
  description: text("description"),             // long-form description / context the advisor enters
  stage: text("stage"),                         // new | qual | demo | neg | won | lost
  stageLabel: text("stage_label"),
  advisorId: uuid("advisor_id").references(() => appUser.id),  // FK → human advisor
  avatar: text("avatar"),                       // gradient key for UI
  initials: text("initials"),
  // Money / payment trail at lead stage (preserved into enrolment on convert)
  feePaid:           numeric("fee_paid",  { precision: 12, scale: 2 }),
  feeDue:            numeric("fee_due",   { precision: 12, scale: 2 }),
  dueDate:           date("due_date"),
  registeredDate:    date("registered_date"),
  paymentProofUrl:   text("payment_proof_url"),
  // Next-best-action card
  nbaIcon: text("nba_icon"),
  nbaLabel: text("nba_label"),
  nbaGhost: boolean("nba_ghost").default(false),
  nbaConfidence: integer("nba_confidence"),
  nbaHeadline: text("nba_headline"),
  nbaWhy: text("nba_why"),
}, (t) => ({
  advisorIdx: index("lead_advisor_idx").on(t.tenantId, t.advisorId),
  programIdx: index("lead_program_idx").on(t.tenantId, t.programId),
}));

// Each lead's score factors (what the AI score is built from). Rendered as
// the "Signals" list on the record page. Tag this as a real list, not JSONB.
export const leadScoreSignal = pgTable("lead_score_signal", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  workItemId: uuid("work_item_id").notNull().references(() => workItem.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  weight: text("weight").notNull(),             // "+14", "−9", "neutral"
  kind: text("kind").notNull(),                 // pos | neg | neu
  rank: integer("rank").notNull().default(0),   // ordering within the lead
}, (t) => ({
  kindCheck: check("lead_score_signal_kind_check", sql`${t.kind} IN ('pos','neg','neu')`),
  wiIdx: index("lead_score_signal_wi_idx").on(t.tenantId, t.workItemId, t.rank),
}));

// Which agents are actively working a lead (the "Agents on this lead" card).
// Many-to-many: one lead → multiple agents, each with its own status.
export const agentAssignment = pgTable("agent_assignment", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  workItemId: uuid("work_item_id").notNull().references(() => workItem.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agent.id, { onDelete: "cascade" }),
  status: text("status").notNull(),             // free-form 1-line status
  badgeLabel: text("badge_label").notNull(),    // 'queued' | 'done' | 'standby' | 'running'
  badgeKind: text("badge_kind").notNull(),      // 'run' | 'done'
  rank: integer("rank").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  badgeKindCheck: check("agent_assignment_badge_kind_check", sql`${t.badgeKind} IN ('run','done')`),
  uniqAssignment: uniqueIndex("agent_assignment_uniq").on(t.workItemId, t.agentId),
  wiIdx: index("agent_assignment_wi_idx").on(t.tenantId, t.workItemId, t.rank),
}));

export const deal = pgTable("deal", {
  workItemId: uuid("work_item_id")
    .primaryKey()
    .references(() => workItem.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  cohortId: uuid("cohort_id").references(() => cohort.id),
  value: numeric("value", { precision: 12, scale: 2 }),
  probability: integer("probability"),
}, (t) => ({
  probCheck: check("deal_probability_check", sql`${t.probability} BETWEEN 0 AND 100`),
}));

export const serviceCase = pgTable("service_case", {
  workItemId: uuid("work_item_id")
    .primaryKey()
    .references(() => workItem.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  category: text("category"),
  channel: text("channel"),
  csat: integer("csat"),
}, (t) => ({
  csatCheck: check("service_case_csat_check", sql`${t.csat} BETWEEN 1 AND 5`),
}));

// Program-level enrolment (the umbrella). One row per learner per program.
// cohort_id stays for back-compat during migration; new code uses program_id.
export const enrolment = pgTable(
  "enrolment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    partyId: uuid("party_id").notNull().references(() => party.id),
    programId: uuid("program_id").references(() => program.id), // becomes NOT NULL after migration
    cohortId: uuid("cohort_id").references(() => cohort.id),    // legacy — to be dropped post-migration
    dealId: uuid("deal_id").references(() => workItem.id),
    status: text("status").notNull().default("active"),
    pricePaid:       numeric("price_paid", { precision: 12, scale: 2 }),
    feeDue:          numeric("fee_due",    { precision: 12, scale: 2 }),
    dueDate:         date("due_date"),
    registeredDate:  date("registered_date"),
    paymentProofUrl: text("payment_proof_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusCheck: check("enrolment_status_check", sql`${t.status} IN ('active','completed','dropped','deferred')`),
    partyIdx: index("enrolment_party_idx").on(t.tenantId, t.partyId),
    programIdx: index("enrolment_program_idx").on(t.tenantId, t.programId),
  }),
);

// Per-COURSE assignment under a program enrolment. The "gate" between
// enrolment (program-level) and batch_assignment (schedule-level).
// You can't assign a batch unless the parent course_assignment exists.
export const courseAssignment = pgTable(
  "course_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    enrolmentId: uuid("enrolment_id").notNull().references(() => enrolment.id, { onDelete: "cascade" }),
    partyId: uuid("party_id").notNull().references(() => party.id),
    courseId: uuid("course_id").notNull().references(() => course.id),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusCheck: check("course_assignment_status_check", sql`${t.status} IN ('active','completed','dropped','deferred')`),
    enrolmentIdx: index("course_assignment_enrolment_idx").on(t.tenantId, t.enrolmentId),
    partyIdx:     index("course_assignment_party_idx").on(t.tenantId, t.partyId),
    courseIdx:    index("course_assignment_course_idx").on(t.tenantId, t.courseId),
    uniqAssignment: uniqueIndex("course_assignment_uniq").on(t.partyId, t.courseId),
  }),
);

// Per-batch assignment under a course assignment. A batch must belong to a
// course the learner is already assigned to.
export const batchAssignment = pgTable(
  "batch_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    enrolmentId: uuid("enrolment_id").notNull().references(() => enrolment.id, { onDelete: "cascade" }),
    courseAssignmentId: uuid("course_assignment_id").references(() => courseAssignment.id, { onDelete: "cascade" }),
    partyId: uuid("party_id").notNull().references(() => party.id),
    cohortId: uuid("cohort_id").notNull().references(() => cohort.id),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusCheck: check("batch_assignment_status_check", sql`${t.status} IN ('active','completed','dropped','deferred')`),
    enrolmentIdx: index("batch_assignment_enrolment_idx").on(t.tenantId, t.enrolmentId),
    courseAssignmentIdx: index("batch_assignment_course_assignment_idx").on(t.tenantId, t.courseAssignmentId),
    partyIdx:     index("batch_assignment_party_idx").on(t.tenantId, t.partyId),
    cohortIdx:    index("batch_assignment_cohort_idx").on(t.tenantId, t.cohortId),
    uniqAssignment: uniqueIndex("batch_assignment_uniq").on(t.partyId, t.cohortId),
  }),
);

export const onboardingTask = pgTable("onboarding_task", {
  workItemId: uuid("work_item_id")
    .primaryKey()
    .references(() => workItem.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  enrolmentId: uuid("enrolment_id").references(() => enrolment.id),
  step: text("step"),
});

export const agentRun = pgTable(
  "agent_run",
  {
    workItemId: uuid("work_item_id")
      .primaryKey()
      .references(() => workItem.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    agentKey: text("agent_key").notNull(),
    runId: text("run_id").notNull(), // LangGraph/LangSmith run id (synth for now)
    status: text("status").notNull().default("running"),
    target: text("target"), // human-readable target ("9 hot leads")
    metricLabel: text("metric_label"),
    metricValue: text("metric_value"),
    rightPill: text("right_pill"),
    glyph: text("glyph"),
    iconKey: text("icon_key"),
    desc: text("desc"),
    live: boolean("live").default(false),
    steps: jsonb("steps").notNull().default(sql`'[]'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    keyStatusIdx: index("agent_run_key_idx").on(t.agentKey, t.status),
  }),
);

// ─── Agent catalog ────────────────────────────────────────────────────────

export const agent = pgTable(
  "agent",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    domain: text("domain").notNull(),
    operatesOn: text("operates_on").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    domainCheck: check("agent_domain_check", sql`${t.domain} IN ('sales','service')`),
    tenantKeyKey: uniqueIndex("agent_tenant_key_key").on(t.tenantId, t.key),
  }),
);

// ─── Relationship graph ───────────────────────────────────────────────────

export const relationship = pgTable(
  "relationship",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    fromType: text("from_type").notNull(),
    fromId: uuid("from_id").notNull(),
    relType: text("rel_type").notNull(),
    toType: text("to_type").notNull(),
    toId: uuid("to_id").notNull(),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fromIdx: index("rel_from_idx").on(t.tenantId, t.fromType, t.fromId),
    toIdx: index("rel_to_idx").on(t.tenantId, t.toType, t.toId),
    uniqueEdge: uniqueIndex("rel_unique_idx").on(
      t.tenantId, t.fromType, t.fromId, t.relType, t.toType, t.toId,
    ),
  }),
);

// ─── Activity timeline (NOT partitioned yet — single table) ───────────────

export const activity = pgTable(
  "activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    workItemId: uuid("work_item_id"),
    partyId: uuid("party_id"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    channel: text("channel"),
    verb: text("verb").notNull(),
    detail: text("detail"),
    tag: text("tag"),
    iconKey: text("icon_key"),
    iconBg: text("icon_bg"),
    iconStroke: text("icon_stroke"),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    wiIdx: index("activity_wi_idx").on(t.tenantId, t.workItemId, t.ts),
    partyIdx: index("activity_party_idx").on(t.tenantId, t.partyId, t.ts),
    payloadGin: index("activity_gin").using("gin", t.payload),
  }),
);

// ─── HITL approvals ───────────────────────────────────────────────────────

export const approval = pgTable(
  "approval",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    workItemId: uuid("work_item_id").references(() => workItem.id),
    actionType: text("action_type").notNull(),
    mode: text("mode").notNull().default("supervised"),
    status: text("status").notNull().default("pending"),
    proposed: jsonb("proposed").notNull(),
    requestedBy: text("requested_by"),
    decidedBy: uuid("decided_by").references(() => appUser.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    modeCheck: check("approval_mode_check", sql`${t.mode} IN ('auto','supervised','manual')`),
    statusCheck: check("approval_status_check", sql`${t.status} IN ('pending','approved','rejected','expired')`),
    queueIdx: index("approval_queue_idx").on(t.tenantId, t.status, t.createdAt),
  }),
);

export const approvalPolicy = pgTable("approval_policy", {
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  actionType: text("action_type").notNull(),
  mode: text("mode").notNull(),
}, (t) => ({
  modeCheck: check("approval_policy_mode_check", sql`${t.mode} IN ('auto','supervised','manual')`),
  pk: uniqueIndex("approval_policy_pk").on(t.tenantId, t.actionType),
}));

// ─── Audit log (insert-only — enforced via GRANTs in raw SQL) ─────────────

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: uuid("target_id"),
    model: text("model"),
    context: jsonb("context").notNull().default(sql`'{}'::jsonb`),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantTsIdx: index("audit_tenant_ts_idx").on(t.tenantId, t.ts),
  }),
);

// ─── Embeddings (pgvector — empty for now, ready for RAG) ─────────────────

export const embedding = pgTable(
  "embedding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    objectType: text("object_type").notNull(),
    objectId: uuid("object_id"),
    chunk: text("chunk").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeIdx: index("embedding_scope_idx").on(t.tenantId, t.objectType),
  }),
);

// ─── Attachments (Blob metadata) ──────────────────────────────────────────

export const attachment = pgTable(
  "attachment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    workItemId: uuid("work_item_id").references(() => workItem.id),
    partyId: uuid("party_id").references(() => party.id),
    kind: text("kind"),
    blobUrl: text("blob_url").notNull(),
    contentType: text("content_type"),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    wiIdx: index("attachment_wi_idx").on(t.tenantId, t.workItemId),
  }),
);

// Type exports — convenient for routes/seed
export type Tenant = typeof tenant.$inferSelect;
export type Lead = typeof lead.$inferSelect;
export type WorkItem = typeof workItem.$inferSelect;
export type Activity = typeof activity.$inferSelect;
export type AgentRun = typeof agentRun.$inferSelect;
