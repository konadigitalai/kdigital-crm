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
  time,
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
    // Auth0 subject ("auth0|abc123", "google-oauth2|123…"). Populated by
    // JIT provisioning on first authenticated request. Nullable so seed
    // rows can exist before any human signs in.
    auth0Sub: text("auth0_sub"),
    // Phase 2 Party Model — every internal user is also a party row. FK +
    // UNIQUE + NOT NULL are enforced in post-0044-app-user-party-fk.sql.
    // .references() intentionally omitted here — referenced FK is created
    // by SQL because Drizzle would try to add it in the wrong order when
    // regenerating from schema.ts.
    partyId: uuid("party_id").notNull(),
    // Retained as read-only redundancy for one release; canonical is
    // party.email / party.name. Do not write via schema.ts inserts —
    // route/seed code writes both party + app_user in a transaction.
    email: text("email").notNull(),
    name: text("name"),
    // Optional contact number for admins/advisors. Added in post-0059 for the
    // Manage Advisors admin page; free-text (no country-code split).
    phone: text("phone"),
    role: text("role").notNull().default("advisor"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    roleCheck: check("app_user_role_check", sql`${t.role} IN ('admin','advisor','service_rep','readonly')`),
    auth0SubKey: uniqueIndex("app_user_auth0_sub_key").on(t.auth0Sub).where(sql`${t.auth0Sub} IS NOT NULL`),
    tenantEmailKey: uniqueIndex("app_user_tenant_email_key").on(t.tenantId, t.email),
    partyUnique: uniqueIndex("app_user_party_unique").on(t.partyId),
  }),
);

// ─── Auth: legacy cookie sessions + group tables ─────────────────────────
// Dropped at the Auth0 cutover (see post-0039-drop-cookie-auth.sql).
// Permissions now ride on the Auth0 access token; user roles are managed
// in Auth0 Dashboard → User Management → Roles.

// ─── Party (people / orgs SoR) ────────────────────────────────────────────

export const party = pgTable(
  "party",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    kind: text("kind").notNull().default("person"),
    name: text("name").notNull(),
    email: text("email"),                    // first-class for queries + indexing
    phone: text("phone"),                    // local subscriber number (no country code)
    phoneCountryCode: text("phone_country_code"),  // e.g. "+91", "+1" — separate so we can normalise / dial
    city: text("city"),
    identifiers: jsonb("identifiers").notNull().default(sql`'{}'::jsonb`),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    // Phase 1 Party Model — org hierarchy self-FK. Nullable. FK + CHECK
    // (parent_party_id <> id) are added in post-0043-party-parent-fk.sql;
    // Drizzle can't express a self-reference inline in the same pgTable call,
    // so the column lives here without .references() and the constraint is SQL-side.
    parentPartyId: uuid("parent_party_id"),
    // Phase 2 Party Model — true when this party is an internal user (employee,
    // advisor, trainer, service_rep). Every app_user has a party where this is
    // true. Added in post-0044-app-user-party-fk.sql.
    isInternal: boolean("is_internal").notNull().default(false),
    // Phase 3 Party Model — sentinel party used as the actor_party_id for
    // agent/system-initiated activity and audit_log rows. Exactly one per tenant
    // (enforced by a partial unique index in post-0047-party-sentinel.sql).
    isSystem: boolean("is_system").notNull().default(false),
    // Phase 4 Party Model — soft-delete flags for merged parties. When two
    // parties are merged, the loser gets is_merged=true and points at the
    // winner via merged_into_party_id. See post-0051-party-merge-log.sql.
    // Self-FK for merged_into_party_id — Drizzle can't inline; SQL-side.
    isMerged: boolean("is_merged").notNull().default(false),
    mergedIntoPartyId: uuid("merged_into_party_id"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    // Fee ledger — single per learner. fee_due is not stored, it is computed
    // as (fee_quoted - fee_paid) at read time. See post-0055-party-fee-ledger.sql.
    // paymentProofs is an ordered list of receipts — each entry is either a
    // data: URL (base64 inline image) or an https link. paymentProofUrl (the
    // singular column) is legacy; readers should prefer paymentProofs.
    // feeNotes was added by post-0056-party-fee-notes.sql.
    // paymentProofs was added by post-0057-party-payment-proofs.sql.
    feeQuoted:       numeric("fee_quoted", { precision: 12, scale: 2 }),
    feePaid:         numeric("fee_paid",   { precision: 12, scale: 2 }),
    dueDate:         date("due_date"),
    paymentStatus:   text("payment_status"),
    paymentProofUrl: text("payment_proof_url"),
    paymentProofs:   text("payment_proofs").array().notNull().default(sql`'{}'::text[]`),
    feeNotes:        text("fee_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindCheck: check("party_kind_check", sql`${t.kind} IN ('person','org')`),
    paymentStatusCheck: check("party_payment_status_check",
      sql`${t.paymentStatus} IS NULL OR ${t.paymentStatus} IN ('pending','paid','refund','on_hold')`),
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

// ─── Phase 1 Party Model — contact points, external IDs, affiliations ─────
//
// These three tables extend the Party model additively:
//   contact_point       — one row per email/phone/whatsapp/address a party has
//   party_external_id   — external system IDs (Instagram, Razorpay, Auth0 sub, …)
//   party_affiliation   — person↔org links with role + temporal validity
//
// See post-0040/0041/0042-*.sql. During Phase 1 the existing party.email
// and party.phone columns remain canonical; writers dual-write into
// contact_point in the same transaction (see routes/leads.ts, lib/whatsapp/inbox.ts,
// db/seed.ts). Read paths migrate in Phase 3.

export const contactPoint = pgTable(
  "contact_point",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    partyId: uuid("party_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),                              // 'email' | 'phone' | 'whatsapp' | 'address' | 'social'
    value: text("value").notNull(),                            // the actual email/number/handle/street
    label: text("label"),                                      // 'work' | 'personal' | 'billing' | 'shipping' | 'primary'
    isPrimary: boolean("is_primary").notNull().default(false), // one primary per (party, kind) — see partial unique index
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    consent: jsonb("consent").notNull().default(sql`'{}'::jsonb`), // {marketing:bool, calls:bool, source:'…', ts:'…'}
    validFrom: date("valid_from").notNull().defaultNow(),
    validTo: date("valid_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindCheck: check("contact_point_kind_check", sql`${t.kind} IN ('email','phone','whatsapp','address','social')`),
    partyKindIdx: index("contact_point_party_kind_idx").on(t.tenantId, t.partyId, t.kind),
    // Fast "who has this value?" — only currently-valid rows.
    valueIdx: index("contact_point_value_idx").on(t.tenantId, t.kind, t.value)
      .where(sql`${t.validTo} IS NULL`),
    // One primary per (party, kind). Partial UNIQUE — matches post-0040.
    primaryUniq: uniqueIndex("contact_point_primary_uniq").on(t.tenantId, t.partyId, t.kind)
      .where(sql`${t.isPrimary} = true`),
  }),
);

export const partyExternalId = pgTable(
  "party_external_id",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    partyId: uuid("party_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    system: text("system").notNull(),               // 'instagram_lead' | 'razorpay_customer' | 'auth0_sub' | 'seed_source' | …
    externalId: text("external_id").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    systemKey: uniqueIndex("party_external_id_system_key").on(t.tenantId, t.system, t.externalId),
    partyIdx: index("party_external_id_party_idx").on(t.tenantId, t.partyId),
  }),
);

export const partyAffiliation = pgTable(
  "party_affiliation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    personPartyId: uuid("person_party_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    orgPartyId: uuid("org_party_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    roleAtOrg: text("role_at_org"),                          // 'decision_maker' | 'evaluator' | 'sponsor' | 'employee' | …
    isPrimary: boolean("is_primary").notNull().default(false),
    validFrom: date("valid_from").notNull().defaultNow(),
    validTo: date("valid_to"),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    notSelf: check("party_affiliation_not_self", sql`${t.personPartyId} <> ${t.orgPartyId}`),
    // One primary org per person, currently-valid. Partial UNIQUE — matches post-0042.
    primaryUniq: uniqueIndex("party_affiliation_primary_uniq").on(t.tenantId, t.personPartyId)
      .where(sql`${t.isPrimary} = true AND ${t.validTo} IS NULL`),
    personIdx: index("party_affiliation_person_idx").on(t.tenantId, t.personPartyId),
    orgIdx: index("party_affiliation_org_idx").on(t.tenantId, t.orgPartyId),
  }),
);

// ─── Phase 4 Party Model — consent + dedup ────────────────────────────────
//
// party_consent             per-channel opt-in records (DPDP/GDPR)
// party_merge_log           audit trail when two parties are merged
// party_match_rule          per-tenant rules the dedup scanner runs
// party_duplicate_candidate scanner output queue

export const partyConsent = pgTable(
  "party_consent",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    partyId: uuid("party_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),                    // whatsapp | email | sms | calls
    optIn: boolean("opt_in").notNull(),
    source: text("source"),                                // 'signup' | 'unsubscribe' | 'legal_dsr' | …
    evidenceUrl: text("evidence_url"),
    validFrom: date("valid_from").notNull().defaultNow(),
    validTo: date("valid_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    channelCheck: check("party_consent_channel_check", sql`${t.channel} IN ('whatsapp','email','sms','calls')`),
    // One current row per (party, channel). Partial UNIQUE — SQL-side (post-0050).
    currentUniq: uniqueIndex("party_consent_current_uniq").on(t.tenantId, t.partyId, t.channel)
      .where(sql`${t.validTo} IS NULL`),
    channelOptinIdx: index("party_consent_channel_optin_idx").on(t.tenantId, t.channel, t.optIn)
      .where(sql`${t.validTo} IS NULL`),
    partyHistoryIdx: index("party_consent_party_idx").on(t.tenantId, t.partyId, t.channel, t.validFrom),
  }),
);

export const partyMergeLog = pgTable(
  "party_merge_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    winnerPartyId: uuid("winner_party_id").notNull().references(() => party.id),
    loserPartyId: uuid("loser_party_id").notNull().references(() => party.id),
    mergedByPartyId: uuid("merged_by_party_id").references(() => party.id, { onDelete: "set null" }),
    mergedAt: timestamp("merged_at", { withTimezone: true }).notNull().defaultNow(),
    snapshot: jsonb("snapshot").notNull(),
    note: text("note"),
  },
  (t) => ({
    tenantIdx: index("party_merge_log_tenant_idx").on(t.tenantId, t.mergedAt),
    winnerIdx: index("party_merge_log_winner_idx").on(t.tenantId, t.winnerPartyId),
    loserIdx:  index("party_merge_log_loser_idx").on(t.tenantId, t.loserPartyId),
  }),
);

export const partyMatchRule = pgTable(
  "party_match_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    name: text("name").notNull(),
    kind: text("kind").notNull(),                          // exact_external_id | exact_email | e164_phone | fuzzy_name_city
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    enabled: boolean("enabled").notNull().default(true),
    weight: integer("weight").notNull().default(100),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindCheck: check("party_match_rule_kind_check",
      sql`${t.kind} IN ('exact_external_id','exact_email','e164_phone','fuzzy_name_city')`),
    tenantEnabledIdx: index("party_match_rule_tenant_enabled_idx").on(t.tenantId, t.enabled),
  }),
);

export const partyDuplicateCandidate = pgTable(
  "party_duplicate_candidate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    partyAId: uuid("party_a_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    partyBId: uuid("party_b_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    matchedByRuleId: uuid("matched_by_rule_id").references(() => partyMatchRule.id, { onDelete: "set null" }),
    score: numeric("score", { precision: 5, scale: 2 }),
    evidence: jsonb("evidence").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("pending"),   // pending | confirmed | dismissed | merged
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByPartyId: uuid("resolved_by_party_id").references(() => party.id, { onDelete: "set null" }),
  },
  (t) => ({
    statusCheck: check("party_dup_status_check", sql`${t.status} IN ('pending','confirmed','dismissed','merged')`),
    // Canonical ordering — matches post-0052.
    abOrder: check("party_dup_ab_order", sql`${t.partyAId} < ${t.partyBId}`),
    // One pending candidate per (a, b). Partial UNIQUE — SQL-side.
    pendingUniq: uniqueIndex("party_dup_pending_uniq").on(t.tenantId, t.partyAId, t.partyBId)
      .where(sql`${t.status} = 'pending'`),
    statusIdx: index("party_dup_status_idx").on(t.tenantId, t.status, t.detectedAt),
  }),
);

// ─── Catalog (referenced by deal + enrolment) ─────────────────────────────
//
// Three-level catalog: Stack → Program → Course (many-to-many).
//   stack           top-level bucket (e.g. "AI Stack") — every program lives here
//   program         has price + duration + description; picks 1..N courses
//   course          reusable building block (name + description only)
//   program_course  junction; unique on (program_id, course_id)
// See post-0054-catalog-stacks.sql for the schema-reset migration.

export const stack = pgTable(
  "stack",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    name: text("name").notNull(),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Case-insensitive name uniqueness per tenant — SQL-side index in
    // post-0054 uses lower(name); we can't express that in Drizzle inline.
  }),
);

export const program = pgTable("program", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  stackId: uuid("stack_id").notNull().references(() => stack.id),
  name: text("name").notNull(),
  description: text("description"),
  price: numeric("price", { precision: 12, scale: 2 }),
  // Duration is stored as a number + unit so it stays sortable/filterable.
  // Unit is constrained to weeks|months in SQL (post-0054).
  durationValue: integer("duration_value"),
  durationUnit: text("duration_unit"),
  enabled: boolean("enabled").notNull().default(true), // soft "active" flag — never delete
  attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
}, (t) => ({
  stackIdx: index("program_stack_idx").on(t.tenantId, t.stackId),
  durationValueCheck: check("program_duration_value_check",
    sql`${t.durationValue} IS NULL OR ${t.durationValue} > 0`),
  durationUnitCheck: check("program_duration_unit_check",
    sql`${t.durationUnit} IS NULL OR ${t.durationUnit} IN ('weeks','months')`),
}));

// A course is a reusable module (Python, SQL, Power BI, etc). No program FK —
// programs pick their courses via the program_course junction. A course is
// offered as one or more batches (cohorts).
export const course = pgTable("course", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  name: text("name").notNull(),
  description: text("description"),
  enabled: boolean("enabled").notNull().default(true),
  attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
});

export const programCourse = pgTable(
  "program_course",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    programId: uuid("program_id").notNull().references(() => program.id, { onDelete: "cascade" }),
    courseId: uuid("course_id").notNull().references(() => course.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("program_course_uniq").on(t.programId, t.courseId),
    programIdx: index("program_course_program_idx").on(t.tenantId, t.programId),
    courseIdx:  index("program_course_course_idx").on(t.tenantId, t.courseId),
  }),
);

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
    // Phase H — structured trainer assignment + cadence (powers the calendar).
    trainerId:    uuid("trainer_id").references(() => party.id, { onDelete: "set null" }),
    coTrainerId:  uuid("co_trainer_id").references(() => party.id, { onDelete: "set null" }),
    daysOfWeek:   text("days_of_week").array(),  // 'mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun'
    startTime:    time("start_time"),            // 24h, IST
    endTime:      time("end_time"),
  },
  (t) => ({
    courseIdx: index("cohort_course_idx").on(t.tenantId, t.courseId),
    trainerIdx:   index("cohort_trainer_idx").on(t.tenantId, t.trainerId),
    coTrainerIdx: index("cohort_co_trainer_idx").on(t.tenantId, t.coTrainerId),
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
    assigneeId: uuid("assignee_id").references(() => party.id),
    state: text("state").notNull().default("open"),
    priority: integer("priority").notNull().default(3),
    slaDue: timestamp("sla_due", { withTimezone: true }),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    typeCheck: check("work_item_type_check", sql`${t.type} IN ('lead','deal','service_case','onboarding_task','agent_run','support_case')`),
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
  heat: text("heat"),                           // legacy; auto-derived from rating via trigger
  rating: text("rating").notNull().default("inbound"),  // inbound|cold|warm|hot|superhot|enrolled — human-set
  // Phase 3 Party Model — lead.city was a denormalized shadow of party.city.
  // Dropped in post-0049-drop-lead-city.sql. Reads now come from party.city.
  program: text("program"),                     // denormalized program name; programId is the canonical FK
  programId: uuid("program_id").references(() => program.id),
  value: text("value"),                         // free-form: "₹1.49L" / "verbal yes" / "asked re: EMI"
  description: text("description"),             // long-form description / context the advisor enters
  stage: text("stage"),                         // new | qual | demo | neg | won | lost
  stageLabel: text("stage_label"),
  advisorId: uuid("advisor_id").references(() => party.id),  // FK → human advisor
  avatar: text("avatar"),                       // gradient key for UI
  initials: text("initials"),
  // Money / payment trail at lead stage (preserved into enrolment on convert)
  feePaid:           numeric("fee_paid",  { precision: 12, scale: 2 }),
  feeDue:            numeric("fee_due",   { precision: 12, scale: 2 }),
  dueDate:           date("due_date"),
  registeredDate:    date("registered_date"),
  paymentProofUrl:   text("payment_proof_url"),
  // Phase H+: pipeline cadence dates the advisor sets manually.
  nextFollowupAt:    date("next_followup_at"),
  demoAttendedAt:    date("demo_attended_at"),
  // Visit cadence — advisor-set. `visited_date` is when the lead already came
  // in; `visiting_date` is when they're scheduled to. See post-0058.
  visitedDate:       date("visited_date"),
  visitingDate:      date("visiting_date"),
  // Display tz on the record header. IANA name; "Asia/Kolkata" by convention
  // for legacy rows that have no value.
  timeZone:          text("time_zone"),
  // How the lead wants the program delivered: 'online' | 'classroom' | 'hybrid'.
  deliveryMode:      text("delivery_mode"),
  // Workflow status — separate from `rating` (heat) and `stage` (pipeline
  // bucket). CHECK constraint lives in post-0061; canonical values in the
  // /catalog `leadStatuses` list.
  leadStatus:        text("lead_status"),
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

// ─── Support case (ServiceNow-style) ──────────────────────────────────────
// 1:1 with work_item.type = 'support_case'. The "stakeholder" of a case is
// a person — they may be an existing lead/learner (linked via party_id) or
// fully external (no party row). Either way, name + email + phone are
// captured on the case itself so external requesters can be tracked.
//
// (We literally use "support_case" as the SQL identifier because plain
//  "case" is a reserved word in PostgreSQL.)
export const supportCase = pgTable(
  "support_case",
  {
    workItemId: uuid("work_item_id")
      .primaryKey()
      .references(() => workItem.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),

    // Stakeholder identity — REQUIRED, even when partyId is set (snapshot at create time)
    requesterName:  text("requester_name").notNull(),
    requesterEmail: text("requester_email").notNull(),
    requesterPhone: text("requester_phone").notNull(),
    requesterKind:  text("requester_kind").notNull(), // 'lead' | 'learner' | 'external'
    partyId:        uuid("party_id").references(() => party.id), // nullable; set when stakeholder is in CRM

    // Body
    subject:     text("subject").notNull(),
    description: text("description"),
    category:    text("category").notNull().default("other"),
    priority:    integer("priority").notNull().default(3),     // 1=urgent, 2=high, 3=medium, 4=low
    status:      text("status").notNull().default("open"),     // open|in_progress|pending|resolved|closed|cancelled

    // SLA / reminders
    dueAt:    timestamp("due_at",    { withTimezone: true }),
    remindAt: timestamp("remind_at", { withTimezone: true }),

    // Resolution — `resolution` becomes mandatory at close (enforced both
    // by the route and by the closedRequiresResolution check below).
    resolvedAt:     timestamp("resolved_at", { withTimezone: true }),
    closedAt:       timestamp("closed_at",   { withTimezone: true }),
    resolution:     text("resolution"),
    resolutionCode: text("resolution_code"), // 'fixed' | 'duplicate' | 'wont_fix' | 'no_action'

    createdById: uuid("created_by_id").references(() => party.id),
    createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    requesterKindCheck: check(
      "support_case_requester_kind_check",
      sql`${t.requesterKind} IN ('lead','learner','external')`,
    ),
    statusCheck: check(
      "support_case_status_check",
      sql`${t.status} IN ('open','in_progress','pending','resolved','closed','cancelled')`,
    ),
    categoryCheck: check(
      "support_case_category_check",
      sql`${t.category} IN ('billing','technical','content_lms','onboarding','cohort_batch','refund','certificate','other')`,
    ),
    priorityCheck: check("support_case_priority_check", sql`${t.priority} BETWEEN 1 AND 4`),
    resolutionCodeCheck: check(
      "support_case_resolution_code_check",
      sql`${t.resolutionCode} IS NULL OR ${t.resolutionCode} IN ('fixed','duplicate','wont_fix','no_action')`,
    ),
    closedRequiresResolution: check(
      "support_case_closed_has_resolution",
      sql`${t.status} <> 'closed' OR (${t.resolution} IS NOT NULL AND length(trim(${t.resolution})) > 0)`,
    ),
    partyIdx:    index("support_case_party_idx").on(t.tenantId, t.partyId),
    statusIdx:   index("support_case_status_idx").on(t.tenantId, t.status),
    assigneeIdx: index("support_case_assignee_via_wi_idx").on(t.tenantId, t.workItemId),
    dueIdx:      index("support_case_due_idx").on(t.tenantId, t.dueAt),
    remindIdx:   index("support_case_remind_idx").on(t.tenantId, t.remindAt),
  }),
);

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
    actorId: text("actor_id"),         // legacy text — unused; retained for one release
    actorName: text("actor_name"),
    // Phase 3 Party Model — real FK to the actor's party. Nullable for
    // legacy rows. See post-0048-activity-audit-actor-party.sql.
    // System / agent writes point at the tenant's sentinel party (is_system=true).
    actorPartyId: uuid("actor_party_id").references(() => party.id, { onDelete: "set null" }),
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
    actorPartyIdx: index("activity_actor_party_idx").on(t.tenantId, t.actorPartyId, t.ts)
      .where(sql`${t.actorPartyId} IS NOT NULL`),
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
    decidedBy: uuid("decided_by").references(() => party.id),
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

// ─── Forecast snapshots (Phase E1 — Forecast Agent) ──────────────────────

export const forecastSnapshot = pgTable(
  "forecast_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    numbers: jsonb("numbers").notNull(),
    narrative: jsonb("narrative").notNull(),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    generatedBy: uuid("generated_by").references(() => party.id),
  },
  (t) => ({
    tenantIdx: index("forecast_snapshot_tenant_idx").on(t.tenantId, t.generatedAt),
  }),
);

// ─── Edify chat sessions + messages (Phase F.1) ───────────────────────────

export const edifyChatSession = pgTable(
  "edify_chat_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    userId: uuid("user_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userTimeIdx: index("edify_session_user_time_idx").on(t.tenantId, t.userId, t.lastAt),
  }),
);

export const edifyChatMessage = pgTable(
  "edify_chat_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    userId: uuid("user_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => edifyChatSession.id, { onDelete: "cascade" }),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    citations: jsonb("citations"),
    suggested: jsonb("suggested"),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
  },
  (t) => ({
    userTimeIdx: index("edify_chat_user_time_idx").on(t.tenantId, t.userId, t.askedAt),
    sessionIdx: index("edify_message_session_idx").on(t.sessionId, t.askedAt),
  }),
);

// ─── Phase G — Leaves + calendar (timesheets dropped in post-0037) ───────

export const leaveDay = pgTable(
  "leave_day",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    userId: uuid("user_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    kind: text("kind").notNull(),
    halfDay: text("half_day").default("full"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userDateKey: uniqueIndex("leave_day_user_date_key").on(t.userId, t.date),
    tenantDateIdx: index("leave_day_tenant_date_idx").on(t.tenantId, t.date),
    kindCheck: check("leave_day_kind_check", sql`${t.kind} IN ('sick','personal','vacation','wfh','holiday')`),
    halfDayCheck: check("leave_day_halfday_check", sql`${t.halfDay} IS NULL OR ${t.halfDay} IN ('full','am','pm')`),
  }),
);

export const calendarEvent = pgTable(
  "calendar_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    organizerId: uuid("organizer_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    allDay: boolean("all_day").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgTimeIdx: index("calendar_event_org_time_idx").on(t.tenantId, t.organizerId, t.startAt),
    endGtStart: check("calendar_event_endgtstart", sql`${t.endAt} > ${t.startAt}`),
  }),
);

export const calendarInvitee = pgTable(
  "calendar_invitee",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").notNull().references(() => calendarEvent.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    rsvp: text("rsvp").notNull().default("pending"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
  },
  (t) => ({
    pk: uniqueIndex("calendar_invitee_pk").on(t.eventId, t.userId),
    userIdx: index("calendar_invitee_user_idx").on(t.userId, t.rsvp),
    rsvpCheck: check("calendar_invitee_rsvp_check", sql`${t.rsvp} IN ('pending','accepted','declined','tentative')`),
  }),
);

// ─── Audit log (insert-only — enforced via GRANTs in raw SQL) ─────────────

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),         // legacy text — unused; retained for one release
    // Phase 3 Party Model — real FK to the actor's party. Nullable for
    // legacy rows. See post-0048-activity-audit-actor-party.sql.
    actorPartyId: uuid("actor_party_id").references(() => party.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: uuid("target_id"),
    model: text("model"),
    context: jsonb("context").notNull().default(sql`'{}'::jsonb`),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantTsIdx: index("audit_tenant_ts_idx").on(t.tenantId, t.ts),
    actorPartyIdx: index("audit_log_actor_party_idx").on(t.tenantId, t.actorPartyId, t.ts)
      .where(sql`${t.actorPartyId} IS NOT NULL`),
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

// ─── Saved view ───────────────────────────────────────────────────────────
// Per-user (or tenant-shared) snapshot of a list-view's filter rules + which
// columns to show. Scoped by surface (`pipeline_list`, etc.) so we can use
// the same table for different lists later.
export const savedView = pgTable(
  "saved_view",
  {
    id:         uuid("id").primaryKey().defaultRandom(),
    tenantId:   uuid("tenant_id").notNull().references(() => tenant.id),
    ownerId:    uuid("owner_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    scope:      text("scope").notNull(),                 // 'pipeline_list' | future surfaces
    name:       text("name").notNull(),
    visibility: text("visibility").notNull().default("personal"),
    filter:     jsonb("filter").notNull().default(sql`'{}'::jsonb`),
    columns:    text("columns").array(),
    createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    visibilityCheck: check(
      "saved_view_visibility_check",
      sql`${t.visibility} IN ('personal','shared')`,
    ),
    ownerScopeIdx:  index("saved_view_owner_scope_idx").on(t.tenantId, t.ownerId, t.scope),
    sharedScopeIdx: index("saved_view_shared_scope_idx").on(t.tenantId, t.scope),
  }),
);

// Per-user preferences for saved-view tabs. See post-0064.
export const userViewPreference = pgTable(
  "user_view_preference",
  {
    id:        uuid("id").primaryKey().defaultRandom(),
    tenantId:  uuid("tenant_id").notNull().references(() => tenant.id),
    userId:    uuid("user_id").notNull(),
    // NULL viewId represents the implicit "All leads" tab. No FK to
    // saved_view — pref rows can outlive a deleted view; they become
    // inert and are reaped later.
    viewId:    uuid("view_id"),
    scope:     text("scope").notNull(),
    hidden:    boolean("hidden").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeIdx: index("user_view_preference_scope_idx").on(t.tenantId, t.userId, t.scope),
  }),
);

// ─── Slack integration ────────────────────────────────────────────────────
// Outbound notification rules + delivery log + a placeholder workspace
// table reserved for the v2 bot-token flow. v1 ships with `webhookUrl`
// populated; v2 will populate `slack_workspace.bot_token` per tenant.
export const slackRule = pgTable(
  "slack_rule",
  {
    id:          uuid("id").primaryKey().defaultRandom(),
    tenantId:    uuid("tenant_id").notNull().references(() => tenant.id),
    name:        text("name").notNull(),
    eventType:   text("event_type").notNull(),
    enabled:     boolean("enabled").notNull().default(true),
    filter:      jsonb("filter").notNull().default(sql`'{}'::jsonb`),
    webhookUrl:  text("webhook_url"),
    channel:     text("channel"),
    template:    text("template"),
    createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    eventTypeCheck: check(
      "slack_rule_event_type_check",
      sql`${t.eventType} IN ('lead.created','case.opened','case.closed')`,
    ),
    tenantEventIdx: index("slack_rule_tenant_event_idx").on(t.tenantId, t.eventType, t.enabled),
  }),
);

export const slackDeliveryLog = pgTable(
  "slack_delivery_log",
  {
    id:          uuid("id").primaryKey().defaultRandom(),
    tenantId:    uuid("tenant_id").notNull().references(() => tenant.id),
    ruleId:      uuid("rule_id").references(() => slackRule.id, { onDelete: "set null" }),
    eventType:   text("event_type").notNull(),
    status:      text("status").notNull(),
    httpStatus:  integer("http_status"),
    response:    text("response"),
    context:     jsonb("context").notNull().default(sql`'{}'::jsonb`),
    sentAt:      timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusCheck: check("slack_delivery_log_status_check", sql`${t.status} IN ('ok','error')`),
    tenantSentIdx: index("slack_delivery_log_tenant_sent_idx").on(t.tenantId, t.sentAt),
  }),
);

// Slack manual-share configuration — one row per (tenant, surface). Drives
// the "Share to Slack" button on lead / learner / case record pages.
export const slackShareTarget = pgTable(
  "slack_share_target",
  {
    id:              uuid("id").primaryKey().defaultRandom(),
    tenantId:        uuid("tenant_id").notNull().references(() => tenant.id),
    surface:         text("surface").notNull(),
    enabled:         boolean("enabled").notNull().default(true),
    channel:         text("channel"),
    webhookUrl:      text("webhook_url"),
    fieldKeys:       text("field_keys").array().notNull().default(sql`'{}'::text[]`),
    headerTemplate:  text("header_template"),
    createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    surfaceCheck: check(
      "slack_share_target_surface_check",
      sql`${t.surface} IN ('leads','learners','cases')`,
    ),
    tenantSurfaceKey: uniqueIndex("slack_share_target_tenant_surface_key").on(t.tenantId, t.surface),
  }),
);

export const slackWorkspace = pgTable(
  "slack_workspace",
  {
    id:           uuid("id").primaryKey().defaultRandom(),
    tenantId:     uuid("tenant_id").notNull().references(() => tenant.id),
    teamId:       text("team_id"),
    teamName:     text("team_name"),
    botToken:     text("bot_token"),
    installedAt:  timestamp("installed_at", { withTimezone: true }),
    createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantUnique: uniqueIndex("slack_workspace_tenant_unique").on(t.tenantId),
  }),
);

// Cached Slack directory — populated by the /integrations/slack/directory/
// refresh endpoint (or a scheduled job). Everything here is fetch-and-store
// from Slack's Web API. Never authoritative on its own — refresh nightly.
export const slackChannelCache = pgTable(
  "slack_channel_cache",
  {
    id:          uuid("id").primaryKey().defaultRandom(),
    tenantId:    uuid("tenant_id").notNull().references(() => tenant.id),
    slackId:     text("slack_id").notNull(),
    name:        text("name").notNull(),
    isPrivate:   boolean("is_private").notNull().default(false),
    isArchived:  boolean("is_archived").notNull().default(false),
    isMember:    boolean("is_member").notNull().default(false),
    topic:       text("topic"),
    syncedAt:    timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantSlackIdKey: uniqueIndex("slack_channel_cache_tenant_slack_id_key").on(t.tenantId, t.slackId),
    tenantNameIdx: index("slack_channel_cache_tenant_name_idx").on(t.tenantId, t.name),
  }),
);

// Per-CRM-user Slack link (OAuth v2 user flow). Written when someone
// clicks "Connect Slack" on a record page. See post-0063.
export const slackUserLink = pgTable(
  "slack_user_link",
  {
    id:            uuid("id").primaryKey().defaultRandom(),
    tenantId:      uuid("tenant_id").notNull().references(() => tenant.id),
    appUserId:     uuid("app_user_id").notNull(),
    slackUserId:   text("slack_user_id").notNull(),
    slackTeamId:   text("slack_team_id"),
    userToken:     text("user_token").notNull(),
    scopes:        text("scopes"),
    connectedAt:   timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt:     timestamp("revoked_at", { withTimezone: true }),
    createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    appUserKey: uniqueIndex("slack_user_link_app_user_key").on(t.appUserId),
    tenantIdx: index("slack_user_link_tenant_idx").on(t.tenantId),
  }),
);

export const slackUserCache = pgTable(
  "slack_user_cache",
  {
    id:            uuid("id").primaryKey().defaultRandom(),
    tenantId:      uuid("tenant_id").notNull().references(() => tenant.id),
    slackId:       text("slack_id").notNull(),
    name:          text("name").notNull(),
    realName:      text("real_name"),
    displayName:   text("display_name"),
    email:         text("email"),
    isBot:         boolean("is_bot").notNull().default(false),
    isDeleted:     boolean("is_deleted").notNull().default(false),
    imageUrl:      text("image_url"),
    syncedAt:      timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantSlackIdKey: uniqueIndex("slack_user_cache_tenant_slack_id_key").on(t.tenantId, t.slackId),
    tenantNameIdx: index("slack_user_cache_tenant_name_idx").on(t.tenantId, t.name),
  }),
);

// ─── WhatsApp (Meta Cloud API direct) ────────────────────────────────────
// Phase 1: config + templates + tags + conversations + messages.
// Phases 2-4 add wa_broadcast / wa_broadcast_recipient / wa_automation / wa_automation_run.

export const waConfig = pgTable(
  "wa_config",
  {
    id:                   uuid("id").primaryKey().defaultRandom(),
    tenantId:             uuid("tenant_id").notNull().references(() => tenant.id),
    phoneNumberId:        text("phone_number_id"),
    wabaId:               text("waba_id"),
    appId:                text("app_id"),
    appSecret:            text("app_secret"),
    systemUserToken:      text("system_user_token"),
    webhookVerifyToken:   text("webhook_verify_token"),
    displayPhoneNumber:   text("display_phone_number"),
    verifiedName:         text("verified_name"),
    qualityRating:        text("quality_rating"),
    status:               text("status").notNull().default("disconnected"),
    connectedAt:          timestamp("connected_at",  { withTimezone: true }),
    registeredAt:         timestamp("registered_at", { withTimezone: true }),
    subscribedAt:         timestamp("subscribed_at", { withTimezone: true }),
    createdAt:            timestamp("created_at",    { withTimezone: true }).notNull().defaultNow(),
    updatedAt:            timestamp("updated_at",    { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantUnique: uniqueIndex("wa_config_tenant_unique").on(t.tenantId),
    statusCheck:  check("wa_config_status_check", sql`${t.status} IN ('disconnected','connected')`),
  }),
);

export const waTemplate = pgTable(
  "wa_template",
  {
    id:             uuid("id").primaryKey().defaultRandom(),
    tenantId:       uuid("tenant_id").notNull().references(() => tenant.id),
    templateName:   text("template_name").notNull(),
    language:       text("language").notNull().default("en_US"),
    category:       text("category").notNull(),
    headerType:     text("header_type"),
    headerContent:  text("header_content"),
    bodyText:       text("body_text").notNull(),
    footerText:     text("footer_text"),
    buttons:        jsonb("buttons"),
    variableCount:  integer("variable_count").notNull().default(0),
    status:         text("status").notNull().default("pending"),
    lastSyncedAt:   timestamp("last_synced_at", { withTimezone: true }),
    createdAt:      timestamp("created_at",     { withTimezone: true }).notNull().defaultNow(),
    updatedAt:      timestamp("updated_at",     { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantNameLangKey: uniqueIndex("wa_template_tenant_name_lang_key").on(t.tenantId, t.templateName, t.language),
    tenantStatusIdx:   index("wa_template_tenant_status_idx").on(t.tenantId, t.status),
    categoryCheck: check("wa_template_category_check", sql`${t.category} IN ('UTILITY','MARKETING','AUTHENTICATION')`),
    statusCheck:   check("wa_template_status_check",   sql`${t.status} IN ('approved','pending','rejected','paused')`),
  }),
);

export const waTag = pgTable(
  "wa_tag",
  {
    id:        uuid("id").primaryKey().defaultRandom(),
    tenantId:  uuid("tenant_id").notNull().references(() => tenant.id),
    name:      text("name").notNull(),
    color:     text("color").notNull().default("#3b82f6"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantNameKey: uniqueIndex("wa_tag_tenant_name_key").on(t.tenantId, sql`lower(${t.name})`),
  }),
);

export const waPartyTag = pgTable(
  "wa_party_tag",
  {
    tenantId:  uuid("tenant_id").notNull().references(() => tenant.id),
    partyId:   uuid("party_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    tagId:     uuid("tag_id").notNull().references(() => waTag.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk:        uniqueIndex("wa_party_tag_pk").on(t.partyId, t.tagId),
    tagIdx:    index("wa_party_tag_tag_idx").on(t.tagId),
    partyIdx:  index("wa_party_tag_party_idx").on(t.partyId),
  }),
);

export const waConversation = pgTable(
  "wa_conversation",
  {
    id:                uuid("id").primaryKey().defaultRandom(),
    tenantId:          uuid("tenant_id").notNull().references(() => tenant.id),
    partyId:           uuid("party_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    status:            text("status").notNull().default("open"),
    assignedUserId:    uuid("assigned_user_id").references(() => party.id, { onDelete: "set null" }),
    lastMessageText:   text("last_message_text"),
    lastMessageAt:     timestamp("last_message_at", { withTimezone: true }),
    lastInboundAt:     timestamp("last_inbound_at", { withTimezone: true }),
    unreadCount:       integer("unread_count").notNull().default(0),
    labels:            text("labels").array().notNull().default(sql`'{}'::text[]`),
    createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantPartyKey:   uniqueIndex("wa_conversation_tenant_party_key").on(t.tenantId, t.partyId),
    tenantStatusIdx:  index("wa_conversation_tenant_status_idx").on(t.tenantId, t.status, t.lastMessageAt),
    statusCheck:      check("wa_conversation_status_check", sql`${t.status} IN ('open','pending','closed')`),
  }),
);

export const waMessage = pgTable(
  "wa_message",
  {
    id:                     uuid("id").primaryKey().defaultRandom(),
    tenantId:               uuid("tenant_id").notNull().references(() => tenant.id),
    conversationId:         uuid("conversation_id").notNull().references(() => waConversation.id, { onDelete: "cascade" }),
    direction:              text("direction").notNull(),
    senderType:             text("sender_type").notNull(),
    senderUserId:           uuid("sender_user_id").references(() => party.id, { onDelete: "set null" }),
    contentType:            text("content_type").notNull().default("text"),
    body:                   text("body"),
    mediaUrl:               text("media_url"),
    mediaMime:              text("media_mime"),
    templateName:           text("template_name"),
    templateVariables:      jsonb("template_variables"),
    providerMessageId:      text("provider_message_id"),
    status:                 text("status").notNull().default("queued"),
    httpStatus:             integer("http_status"),
    errorCode:              text("error_code"),
    errorMessage:           text("error_message"),
    inReplyToProviderId:    text("in_reply_to_provider_id"),
    sentAt:                 timestamp("sent_at",      { withTimezone: true }).notNull().defaultNow(),
    deliveredAt:            timestamp("delivered_at", { withTimezone: true }),
    readAt:                 timestamp("read_at",      { withTimezone: true }),
    rawPayload:             jsonb("raw_payload"),
  },
  (t) => ({
    conversationSentIdx:   index("wa_message_conversation_sent_idx").on(t.conversationId, t.sentAt),
    tenantSentIdx:         index("wa_message_tenant_sent_idx").on(t.tenantId, t.sentAt),
    directionCheck:        check("wa_message_direction_check",    sql`${t.direction} IN ('inbound','outbound')`),
    senderTypeCheck:       check("wa_message_sender_type_check",  sql`${t.senderType} IN ('customer','agent','bot','system')`),
    statusCheck:           check("wa_message_status_check",       sql`${t.status} IN ('queued','sent','delivered','read','failed')`),
  }),
);

// ─── WhatsApp broadcasts (Phase 3) ────────────────────────────────────────

export const waBroadcast = pgTable(
  "wa_broadcast",
  {
    id:                 uuid("id").primaryKey().defaultRandom(),
    tenantId:           uuid("tenant_id").notNull().references(() => tenant.id),
    name:               text("name").notNull(),
    templateId:         uuid("template_id").notNull().references(() => waTemplate.id, { onDelete: "restrict" }),
    createdBy:          uuid("created_by").references(() => party.id, { onDelete: "set null" }),
    defaultVariables:   jsonb("default_variables").notNull().default(sql`'{}'::jsonb`),
    status:             text("status").notNull().default("draft"),
    scheduledAt:        timestamp("scheduled_at", { withTimezone: true }),
    startedAt:          timestamp("started_at",   { withTimezone: true }),
    finishedAt:         timestamp("finished_at",  { withTimezone: true }),
    totalRecipients:    integer("total_recipients").notNull().default(0),
    sentCount:          integer("sent_count").notNull().default(0),
    deliveredCount:     integer("delivered_count").notNull().default(0),
    readCount:          integer("read_count").notNull().default(0),
    failedCount:        integer("failed_count").notNull().default(0),
    createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantStatusIdx: index("wa_broadcast_tenant_status_idx").on(t.tenantId, t.status, t.createdAt),
    statusCheck: check("wa_broadcast_status_check",
      sql`${t.status} IN ('draft','scheduled','sending','completed','cancelled','failed')`),
  }),
);

export const waBroadcastRecipient = pgTable(
  "wa_broadcast_recipient",
  {
    id:                  uuid("id").primaryKey().defaultRandom(),
    tenantId:            uuid("tenant_id").notNull().references(() => tenant.id),
    broadcastId:         uuid("broadcast_id").notNull().references(() => waBroadcast.id, { onDelete: "cascade" }),
    partyId:             uuid("party_id").references(() => party.id, { onDelete: "set null" }),
    toPhone:             text("to_phone").notNull(),
    variables:           jsonb("variables").notNull().default(sql`'{}'::jsonb`),
    status:              text("status").notNull().default("pending"),
    providerMessageId:   text("provider_message_id"),
    errorCode:           text("error_code"),
    errorMessage:        text("error_message"),
    queuedAt:            timestamp("queued_at",    { withTimezone: true }).notNull().defaultNow(),
    sentAt:              timestamp("sent_at",      { withTimezone: true }),
    deliveredAt:         timestamp("delivered_at", { withTimezone: true }),
    readAt:              timestamp("read_at",      { withTimezone: true }),
  },
  (t) => ({
    statusCheck: check("wa_broadcast_recipient_status_check",
      sql`${t.status} IN ('pending','sent','delivered','read','failed','cancelled')`),
  }),
);

// Type exports — convenient for routes/seed
export type Tenant = typeof tenant.$inferSelect;
export type Stack = typeof stack.$inferSelect;
export type Program = typeof program.$inferSelect;
export type Course = typeof course.$inferSelect;
export type ProgramCourse = typeof programCourse.$inferSelect;
export type Lead = typeof lead.$inferSelect;
export type WorkItem = typeof workItem.$inferSelect;
export type ContactPoint = typeof contactPoint.$inferSelect;
export type PartyExternalId = typeof partyExternalId.$inferSelect;
export type PartyAffiliation = typeof partyAffiliation.$inferSelect;
export type PartyConsent = typeof partyConsent.$inferSelect;
export type PartyMergeLog = typeof partyMergeLog.$inferSelect;
export type PartyMatchRule = typeof partyMatchRule.$inferSelect;
export type PartyDuplicateCandidate = typeof partyDuplicateCandidate.$inferSelect;
export type Activity = typeof activity.$inferSelect;
export type AgentRun = typeof agentRun.$inferSelect;
export type SupportCase = typeof supportCase.$inferSelect;
export type SavedView = typeof savedView.$inferSelect;
export type SlackRule = typeof slackRule.$inferSelect;
export type SlackDeliveryLog = typeof slackDeliveryLog.$inferSelect;
export type SlackWorkspace = typeof slackWorkspace.$inferSelect;
export type SlackShareTarget = typeof slackShareTarget.$inferSelect;
export type WaConfig = typeof waConfig.$inferSelect;
export type WaTemplate = typeof waTemplate.$inferSelect;
export type WaTag = typeof waTag.$inferSelect;
export type WaConversation = typeof waConversation.$inferSelect;
export type WaMessage = typeof waMessage.$inferSelect;
export type WaBroadcast = typeof waBroadcast.$inferSelect;
export type WaBroadcastRecipient = typeof waBroadcastRecipient.$inferSelect;

// ─── WhatsApp automations (Phase 4) ───────────────────────────────────

export const waAutomation = pgTable(
  "wa_automation",
  {
    id:          uuid("id").primaryKey().defaultRandom(),
    tenantId:    uuid("tenant_id").notNull().references(() => tenant.id),
    name:        text("name").notNull(),
    description: text("description"),
    trigger:     jsonb("trigger").notNull(),
    actions:     jsonb("actions").notNull().default(sql`'[]'::jsonb`),
    enabled:     boolean("enabled").notNull().default(false),
    createdBy:   uuid("created_by").references(() => party.id, { onDelete: "set null" }),
    createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameLen: check("wa_automation_name_len_check", sql`char_length(${t.name}) BETWEEN 1 AND 120`),
  }),
);

export const waAutomationRun = pgTable(
  "wa_automation_run",
  {
    id:             uuid("id").primaryKey().defaultRandom(),
    tenantId:       uuid("tenant_id").notNull().references(() => tenant.id),
    automationId:   uuid("automation_id").notNull().references(() => waAutomation.id, { onDelete: "cascade" }),
    partyId:        uuid("party_id").references(() => party.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id").references(() => waConversation.id, { onDelete: "set null" }),
    status:         text("status").notNull().default("running"),
    context:        jsonb("context").notNull().default(sql`'{}'::jsonb`),
    actionsLog:     jsonb("actions_log").notNull().default(sql`'[]'::jsonb`),
    errorMessage:   text("error_message"),
    startedAt:      timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt:    timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    statusCheck: check(
      "wa_automation_run_status_check",
      sql`${t.status} IN ('running','completed','failed','skipped')`,
    ),
  }),
);

export type WaAutomation = typeof waAutomation.$inferSelect;
export type WaAutomationRun = typeof waAutomationRun.$inferSelect;
