// Digital Edify Agentic CRM — Drizzle schema (full doc-03 model)
// Skips only: metadata layer (record_type/field_def/state_model) and activity partitioning.
// Tenant-scoped throughout. RLS + sequences are added in 0001_post_drizzle.sql (raw SQL).

import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
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
    // Fee ledger — MOVED to `enrolment` in post-0077-move-fee-to-enrolment.sql.
    // Financial information now lives on the enrolment (one per learner), not
    // on the person. Do not re-add fee columns here.
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
    roleCheck: check("party_role_role_check", sql`${t.role} IN ('lead','contact','enrolled','learner','intern','advisor','alumnus')`),
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
// contact_point in the same transaction (see routes/leads.ts, db/seed.ts).
// Read paths migrate in Phase 3.

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
  // Short code the learner portal prints — "PRG-11". Filled by a DB default
  // off seq_program (post-0086), so no insert path has to remember it.
  code: text("code"),
  name: text("name").notNull(),
  description: text("description"),
  price: numeric("price", { precision: 12, scale: 2 }),
  // Duration is stored as a number + unit so it stays sortable/filterable.
  // Unit is constrained to weeks|months in SQL (post-0054).
  durationValue: integer("duration_value"),
  durationUnit: text("duration_unit"),
  enabled: boolean("enabled").notNull().default(true), // soft "active" flag — never delete
  attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
  // ─── KDigital catalogue registry (post-0087) ───────────────────────────
  // registryId is the permanent external key — "K-P003-FSAE". It, not the
  // uuid and not the name, is what credit and certificates resolve by
  // (CAT-001/005). shortCode is the registry's mnemonic ("FSAE"), which is a
  // different identifier from `code` above and owned by the registry.
  registryId: text("registry_id"),
  shortCode: text("short_code"),
  catalogueSequence: integer("catalogue_sequence"),
  fullName: text("full_name"),
  searchAlias: text("search_alias"),   // normalised for search only — never displayed
  programmeType: text("programme_type"), // 'Career Pathway' | 'Composite Career Pathway'
  family: text("family"),
  credentialType: text("credential_type"),
  deliveryModes: text("delivery_modes").array(), // 'Online' | 'Classroom' | 'Hybrid'
  catalogueVersion: text("catalogue_version"),   // "2026.08"
  // The registry's publication state, distinct from `enabled` (our
  // operational on/off). A Published programme can still be disabled locally.
  catalogueStatus: text("catalogue_status").notNull().default("Published"),
  effectiveFrom: date("effective_from"),
  effectiveTo: date("effective_to"),
  sourceRegistry: text("source_registry"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  stackIdx: index("program_stack_idx").on(t.tenantId, t.stackId),
  registryIdUniq: uniqueIndex("program_registry_id_uniq").on(t.tenantId, t.registryId),
  durationValueCheck: check("program_duration_value_check",
    sql`${t.durationValue} IS NULL OR ${t.durationValue} > 0`),
  durationUnitCheck: check("program_duration_unit_check",
    sql`${t.durationUnit} IS NULL OR ${t.durationUnit} IN ('weeks','months')`),
  catalogueStatusCheck: check("program_catalogue_status_check",
    sql`${t.catalogueStatus} IN ('Draft','Published','Retired')`),
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
  // ─── KDigital catalogue registry (post-0087) ───────────────────────────
  registryId: text("registry_id"),      // "K-C008-PYTH" — permanent (CAT-001)
  shortCode: text("short_code"),        // "PYTH"
  catalogueSequence: integer("catalogue_sequence"),
  searchAlias: text("search_alias"),
  family: text("family"),
  credentialType: text("credential_type"),
  // CAT-015 — the stable ID and the dated syllabus are separate. This is the
  // template ("K-C008-PYTH-VYYYY.N") a cohort's concrete version comes from.
  curriculumVersionPattern: text("curriculum_version_pattern"),
  // CAT-002/003 — may completion be credited into another pathway, and may
  // this be sold standalone?
  reusableAcrossProgrammes: boolean("reusable_across_programmes").notNull().default(true),
  independentlyDeliverable: boolean("independently_deliverable").notNull().default(true),
  catalogueVersion: text("catalogue_version"),
  catalogueStatus: text("catalogue_status").notNull().default("Published"),
  effectiveFrom: date("effective_from"),
  effectiveTo: date("effective_to"),
  sourceRegistry: text("source_registry"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  registryIdUniq: uniqueIndex("course_registry_id_uniq").on(t.tenantId, t.registryId),
  catalogueStatusCheck: check("course_catalogue_status_check",
    sql`${t.catalogueStatus} IN ('Draft','Published','Retired')`),
}));

// A programme component (post-0087). Despite the table name it is no longer
// only courses: a composite pathway such as Forward Deployed AI Engineer
// (K-P008-FDE) lists seven other PROGRAMMES among its components (CAT-007),
// which is why courseId is nullable and childProgramId exists. Exactly one of
// the two is set, agreeing with componentType — enforced by a SQL CHECK.
export const programCourse = pgTable(
  "program_course",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    programId: uuid("program_id").notNull().references(() => program.id, { onDelete: "cascade" }),
    componentType: text("component_type").notNull().default("course"), // 'course' | 'programme'
    courseId: uuid("course_id").references(() => course.id, { onDelete: "cascade" }),
    childProgramId: uuid("child_program_id").references((): AnyPgColumn => program.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull().default(0),  // registry sequence_number − 1
    // Registry-owned vocabulary, deliberately not a CHECK: it grows between
    // catalogue versions. 'Core Course' | 'Foundation Course' |
    // 'Product Specialisation' | 'Referenced Pathway' | 'FDE-Specific Course'.
    componentRole: text("component_role"),
    // CAT-008 — keeps ServiceNow product areas grouped behind the core
    // platform pathway instead of forking duplicate courses.
    specialisationGroup: text("specialisation_group"),
    required: boolean("required").notNull().default(true),
    creditReuseAllowed: boolean("credit_reuse_allowed").notNull().default(true),
    catalogueStatus: text("catalogue_status").notNull().default("Active"), // 'Active' | 'Retired'
    effectiveFrom: date("effective_from"),
    effectiveTo: date("effective_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("program_course_uniq").on(t.programId, t.courseId),
    childUniq: uniqueIndex("program_course_child_program_uniq").on(t.programId, t.childProgramId),
    programIdx: index("program_course_program_idx").on(t.tenantId, t.programId),
    courseIdx:  index("program_course_course_idx").on(t.tenantId, t.courseId),
    childIdx:   index("program_course_child_program_idx").on(t.tenantId, t.childProgramId),
    componentTargetCheck: check("program_course_component_target_check",
      sql`(${t.componentType} = 'course'    AND ${t.courseId} IS NOT NULL AND ${t.childProgramId} IS NULL)
       OR (${t.componentType} = 'programme' AND ${t.childProgramId} IS NOT NULL AND ${t.courseId} IS NULL)`),
    noSelfReferenceCheck: check("program_course_no_self_reference_check",
      sql`${t.childProgramId} IS NULL OR ${t.childProgramId} <> ${t.programId}`),
    catalogueStatusCheck: check("program_course_catalogue_status_check",
      sql`${t.catalogueStatus} IN ('Active','Retired')`),
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
    // ─── post-0087 / post-0088 ────────────────────────────────────────────
    // CAT-015 — the dated syllabus this run teaches ("K-C008-PYTH-V2026.1").
    // Two batches of the same course a term apart may differ, and a
    // certificate has to name which one.
    curriculumVersion: text("curriculum_version"),
    // Whether this run is online, in a classroom, or both. join_url being set
    // was the old proxy, and hybrid batches have one too.
    // online | classroom | hybrid — the vocabulary post-0060 settled on for
    // `lead`, corrected here in post-0093. It is also the registry's, in
    // lower case, so nothing has to be translated.
    deliveryMode: text("delivery_mode"),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    location: text("location"),                  // campus/room, when not online
  },
  (t) => ({
    courseIdx: index("cohort_course_idx").on(t.tenantId, t.courseId),
    deliveryModeCheck: check("cohort_delivery_mode_check",
      sql`${t.deliveryMode} IS NULL OR ${t.deliveryMode} IN ('online','classroom','hybrid')`),
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
  // ─── Qualification (post-0088) ──────────────────────────────────────────
  // The three questions an advisor asks on the first call. They were being
  // typed into `description` by hand, which made them unsearchable.
  workingStatus:  text("working_status"),   // student | working | not_working
  yearOfPassout:  integer("year_of_passout"),
  currentCompany: text("current_company"),
  // `value` is a bare numeric. This says which currency it is in — every
  // existing row is INR, but a non-INR quote is now representable.
  currency: text("currency").notNull().default("INR"),
  // The campaign that produced this lead. `source` is a free-text channel
  // ("Website"); this is the actual row, so spend attributes to revenue.
  sourceCampaignId: uuid("source_campaign_id").references((): AnyPgColumn => campaign.id, { onDelete: "set null" }),
}, (t) => ({
  advisorIdx: index("lead_advisor_idx").on(t.tenantId, t.advisorId),
  programIdx: index("lead_program_idx").on(t.tenantId, t.programId),
  workingStatusCheck: check("lead_working_status_check",
    sql`${t.workingStatus} IS NULL OR ${t.workingStatus} IN ('student','working','not_working')`),
  yearOfPassoutCheck: check("lead_year_of_passout_check",
    sql`${t.yearOfPassout} IS NULL OR (${t.yearOfPassout} BETWEEN 1950 AND 2100)`),
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

// A deal is the B2B opportunity. It sits on the work_item spine, which
// supplies the number (DEAL-3142), the owner, the state, the priority and the
// activity timeline — everything below is what work_item cannot know about a
// sale. Extended in post-0090; before that it was a cohort, a value and a
// probability, which is not a pipeline.
export const deal = pgTable("deal", {
  workItemId: uuid("work_item_id")
    .primaryKey()
    .references(() => workItem.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  cohortId: uuid("cohort_id").references(() => cohort.id),
  value: numeric("value", { precision: 12, scale: 2 }),
  probability: integer("probability"),
  // ─── B2B opportunity (post-0090) ────────────────────────────────────────
  name: text("name"),
  accountPartyId: uuid("account_party_id").references((): AnyPgColumn => account.partyId, { onDelete: "set null" }),
  primaryContactPartyId: uuid("primary_contact_party_id").references((): AnyPgColumn => contact.partyId, { onDelete: "set null" }),
  opportunityType: text("opportunity_type"),
  // Sales stage, separate from work_item.state. A deal can be in
  // 'negotiation' while its work_item is simply 'open'.
  stage: text("stage").notNull().default("qualification"),
  stageUpdatedAt: timestamp("stage_updated_at", { withTimezone: true }).notNull().defaultNow(),
  currency: text("currency").notNull().default("INR"),
  // Weighted value, stored rather than computed so a forecast snapshot keeps
  // the probability it was taken at.
  expectedRevenue: numeric("expected_revenue", { precision: 14, scale: 2 }),
  expectedCloseDate: date("expected_close_date"),
  actualCloseDate: date("actual_close_date"),
  nextAction: text("next_action"),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  probCheck: check("deal_probability_check", sql`${t.probability} BETWEEN 0 AND 100`),
  stageCheck: check("deal_stage_check",
    sql`${t.stage} IN ('qualification','discovery','proposal','negotiation','closed_won','closed_lost')`),
  opportunityTypeCheck: check("deal_opportunity_type_check",
    sql`${t.opportunityType} IS NULL OR ${t.opportunityType} IN ('corporate_training','hiring','consulting','renewal','upsell')`),
  // A closed deal has a close date; an open one does not. The invariant every
  // pipeline report assumed and nothing was enforcing.
  closeDateCheck: check("deal_close_date_check",
    sql`(${t.stage} IN ('closed_won','closed_lost')) = (${t.actualCloseDate} IS NOT NULL)`),
  accountIdx: index("deal_account_idx").on(t.tenantId, t.accountPartyId),
  stageIdx: index("deal_stage_idx").on(t.tenantId, t.stage),
  closeIdx: index("deal_close_idx").on(t.tenantId, t.expectedCloseDate),
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

    // ── Cases board redesign (post-0080) ──────────────────────────────────
    // How the case entered the system — powers the "+AUTO" badge + Auto-detected
    // tab. Display-only: agents/imports set 'auto'; humans 'manual'.
    source:          text("source").notNull().default("manual"),   // manual | auto
    // Finer human label the record header shows ("Refund request", …). Falls
    // back to the category label when null.
    typeLabel:       text("type_label"),
    // Intake context for the record page's CASE section.
    channel:         text("channel"),                              // whatsapp | email | phone | portal
    raisedBy:        text("raised_by"),                            // learner | internal | system
    // Splits the "Pending Learner" vs "Pending Internal" display status.
    pendingWith:     text("pending_with"),                         // learner | internal
    // First staff response — set on the first comment/reply. Powers "First response".
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    // How many times reopened — increments in /reopen. Powers the Reopened tab.
    reopenCount:     integer("reopen_count").notNull().default(0),
    // OUTCOME · required-to-close fields.
    preventable:     boolean("preventable"),
    rootCause:       text("root_cause"),
    // Free-text systemic reference ("SN-2624 trainer_employment_id = null"). When
    // set, the record page shows the red systemic banner. Display-only this pass.
    systemicRef:     text("systemic_ref"),
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
      sql`${t.category} IN ('billing','technical','content_lms','onboarding','cohort_batch','refund','certificate','data_privacy','other')`,
    ),
    sourceCheck: check("support_case_source_check", sql`${t.source} IN ('manual','auto')`),
    raisedByCheck: check(
      "support_case_raised_by_check",
      sql`${t.raisedBy} IS NULL OR ${t.raisedBy} IN ('learner','internal','system')`,
    ),
    pendingWithCheck: check(
      "support_case_pending_with_check",
      sql`${t.pendingWith} IS NULL OR ${t.pendingWith} IN ('learner','internal')`,
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
    sourceIdx:   index("support_case_source_idx").on(t.tenantId, t.source),
  }),
);

// Program-level enrolment (the umbrella). One row per learner per program.
// cohort_id stays for back-compat during migration; new code uses program_id.
export const enrolment = pgTable(
  "enrolment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    // Human-friendly enrollment number, e.g. "ENR-00231". Set by the app via
    // seq_enrolment. Added in post-0078. Nullable for legacy safety; the
    // enroll route always populates it.
    number: text("number"),
    partyId: uuid("party_id").notNull().references(() => party.id),
    programId: uuid("program_id").references(() => program.id), // becomes NOT NULL after migration
    cohortId: uuid("cohort_id").references(() => cohort.id),    // legacy — to be dropped post-migration
    dealId: uuid("deal_id").references(() => workItem.id),
    // Lifecycle: 'pending' = enrolled, payment not yet verified (pre-learner);
    // 'active' = converted to learner. See post-0078.
    status: text("status").notNull().default("active"),
    pricePaid:       numeric("price_paid", { precision: 12, scale: 2 }),
    feeDue:          numeric("fee_due",    { precision: 12, scale: 2 }), // legacy snapshot; UI computes due = quoted − paid
    dueDate:         date("due_date"),
    registeredDate:  date("registered_date"),
    paymentProofUrl: text("payment_proof_url"),
    // Fee ledger — moved here from `party` in post-0077. One ledger per
    // enrolment; a learner has exactly one enrolment. paymentProofs is the
    // canonical ordered receipt list; paymentProofUrl mirrors proofs[0].
    feeQuoted:       numeric("fee_quoted", { precision: 12, scale: 2 }),
    feePaid:         numeric("fee_paid",   { precision: 12, scale: 2 }),
    paymentStatus:   text("payment_status"),
    paymentProofs:   text("payment_proofs").array().notNull().default(sql`'{}'::text[]`),
    feeNotes:        text("fee_notes"),
    // Payment verification — the gate for enrolled → learner. Set when finance
    // signs off; Convert to Learner requires paymentVerifiedAt IS NOT NULL.
    paymentVerifiedAt: timestamp("payment_verified_at", { withTimezone: true }),
    paymentVerifiedBy: uuid("payment_verified_by").references(() => party.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // ─── post-0088 ────────────────────────────────────────────────────────
    // The engagement's own owner, mode and dates. Previously all of these
    // were inherited from whichever batch the learner happened to sit in,
    // which breaks the moment they sit in several — the normal case for a
    // nine-course pathway.
    advisorId: uuid("advisor_id").references(() => party.id, { onDelete: "set null" }),
    deliveryMode: text("delivery_mode"),   // online | classroom | hybrid (post-0093)
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    currency: text("currency").notNull().default("INR"),
    startDate: date("start_date"),
    expectedCompletionDate: date("expected_completion_date"),
    // Admission gating. Three signals rather than one because they are
    // cleared by three different people at three different times.
    admissionChecklistStatus: text("admission_checklist_status").notNull().default("pending"),
    identityProofStatus: text("identity_proof_status").notNull().default("not_submitted"),
    // Asked at enrolment, not at the end. Feeds the candidate pipeline.
    staffingInterest: boolean("staffing_interest").notNull().default(false),
  },
  (t) => ({
    statusCheck: check("enrolment_status_check", sql`${t.status} IN ('pending','active','on_hold','completed','dropped','deferred')`),
    deliveryModeCheck: check("enrolment_delivery_mode_check",
      sql`${t.deliveryMode} IS NULL OR ${t.deliveryMode} IN ('online','classroom','hybrid')`),
    admissionChecklistCheck: check("enrolment_admission_checklist_check",
      sql`${t.admissionChecklistStatus} IN ('pending','partial','complete')`),
    identityProofCheck: check("enrolment_identity_proof_check",
      sql`${t.identityProofStatus} IN ('not_submitted','submitted','verified','rejected')`),
    paymentStatusCheck: check("enrolment_payment_status_check",
      sql`${t.paymentStatus} IS NULL OR ${t.paymentStatus} IN ('pending','paid','refund','on_hold')`),
    tenantNumberKey: uniqueIndex("enrolment_tenant_number_key").on(t.tenantId, t.number),
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

// ─── Batch sessions + attendance (post-0079) ──────────────────────────────
// One row per ACTUAL class occurrence, materialized from the cohort's schedule
// (days_of_week + start/end time + date bounds). These persist so the board can
// compute Coverage % (delivered + recording published), Attendance %, and the
// recording-SLA rollup — none of which the on-the-fly /batches/sessions feed can.
export const batchSession = pgTable(
  "batch_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    cohortId: uuid("cohort_id").notNull().references(() => cohort.id, { onDelete: "cascade" }),
    sessionDate: date("session_date").notNull(),
    startTime: time("start_time"),   // copied from cohort at materialize time
    endTime:   time("end_time"),
    status: text("status").notNull().default("planned"),  // planned | delivered | cancelled
    recordingUrl: text("recording_url"),
    recordingPublishedAt: timestamp("recording_published_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusCheck: check("batch_session_status_check", sql`${t.status} IN ('planned','delivered','cancelled')`),
    // One session per (cohort, date) — makes materialize idempotent.
    cohortDateUniq: uniqueIndex("batch_session_uniq").on(t.cohortId, t.sessionDate),
    cohortIdx: index("batch_session_cohort_idx").on(t.tenantId, t.cohortId, t.sessionDate),
    dateIdx:   index("batch_session_date_idx").on(t.tenantId, t.sessionDate),  // calendar range scans
  }),
);

// One row per learner per session. Roster comes from active batch_assignment;
// unmarked learners simply have no row (treated as unmarked, not absent).
export const attendance = pgTable(
  "attendance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    batchSessionId: uuid("batch_session_id").notNull().references(() => batchSession.id, { onDelete: "cascade" }),
    partyId: uuid("party_id").notNull().references(() => party.id),  // the learner
    status: text("status").notNull().default("present"),  // present | absent | late | excused
    markedBy: uuid("marked_by").references(() => party.id, { onDelete: "set null" }),
    markedAt: timestamp("marked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusCheck: check("attendance_status_check", sql`${t.status} IN ('present','absent','late','excused')`),
    // One mark per (session, learner) — upsert key.
    sessionPartyUniq: uniqueIndex("attendance_uniq").on(t.batchSessionId, t.partyId),
    sessionIdx: index("attendance_session_idx").on(t.tenantId, t.batchSessionId),
    partyIdx:   index("attendance_party_idx").on(t.tenantId, t.partyId),
  }),
);

// ─── Learner profile (1:1 satellite of party — keyed by party_id) ─────────
// Durable learner-specific attributes that don't belong on `party` (identity)
// and aren't a role transition (party_role) or an engagement (enrolment).
// PK = party_id ⇒ exactly one profile per person and NO identity duplicated —
// name/email/phone/fees stay on `party`. RLS + grants are SQL-side. See
// post-0076-learner-profile.sql.
export const learnerProfile = pgTable(
  "learner_profile",
  {
    partyId: uuid("party_id").primaryKey().references(() => party.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    lmsUserId: text("lms_user_id"),
    mentorPartyId: uuid("mentor_party_id").references(() => party.id, { onDelete: "set null" }),
    skillLevel: text("skill_level"),           // beginner | intermediate | advanced
    placementStatus: text("placement_status"), // not_started | in_progress | placed | deferred
    placedCompany: text("placed_company"),
    placedAt: date("placed_at"),
    status: text("status").notNull().default("active"), // active | paused | completed | dropped
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // ─── Progress + risk + staffing gate (post-0088) ──────────────────────
    // The profile knew where a learner ended up but nothing about how they
    // were doing on the way. Risk is what an advisor acts on weeks before a
    // drop-out; without it the first signal IS the drop-out.
    //
    // progressPercent is a cached roll-up — the truth is resource_progress.
    // Cached because the learners list renders it per row.
    progressPercent: integer("progress_percent"),
    riskLevel: text("risk_level"),     // low | medium | high
    riskReason: text("risk_reason"),
    // The staffing gate. Two independent facts, so two columns: a learner can
    // be qualified without consenting, and consent can be withdrawn later.
    // `candidate` never restates these — see the candidate_eligible view.
    staffingEligibilityStatus: text("staffing_eligibility_status").notNull().default("not_assessed"),
    staffingConsentStatus: text("staffing_consent_status").notNull().default("not_asked"),
    staffingConsentAt: timestamp("staffing_consent_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("learner_profile_tenant_idx").on(t.tenantId),
    progressCheck: check("learner_profile_progress_check",
      sql`${t.progressPercent} IS NULL OR ${t.progressPercent} BETWEEN 0 AND 100`),
    riskLevelCheck: check("learner_profile_risk_level_check",
      sql`${t.riskLevel} IS NULL OR ${t.riskLevel} IN ('low','medium','high')`),
    staffingEligibilityCheck: check("learner_profile_staffing_eligibility_check",
      sql`${t.staffingEligibilityStatus} IN ('not_assessed','qualified','not_qualified')`),
    staffingConsentCheck: check("learner_profile_staffing_consent_check",
      sql`${t.staffingConsentStatus} IN ('not_asked','granted','withheld','withdrawn')`),
    mentorIdx: index("learner_profile_mentor_idx").on(t.tenantId, t.mentorPartyId),
    placementIdx: index("learner_profile_placement_idx").on(t.tenantId, t.placementStatus),
    skillLevelCheck: check("learner_profile_skill_level_check",
      sql`${t.skillLevel} IS NULL OR ${t.skillLevel} IN ('beginner','intermediate','advanced')`),
    placementStatusCheck: check("learner_profile_placement_status_check",
      sql`${t.placementStatus} IS NULL OR ${t.placementStatus} IN ('not_started','in_progress','placed','deferred')`),
    statusCheck: check("learner_profile_status_check",
      sql`${t.status} IN ('active','paused','completed','dropped')`),
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

// ─── LMS (post-0083) ──────────────────────────────────────────────────────
// The learner-facing layer. Shape mirrors the existing batch spine:
//
//   cohort (batch) → module → module_resource
//                           → coursework → submission
//
// A learner reaches a module because they hold a batch_assignment on its
// cohort. That is the entire access rule — nothing here restates it, and
// RLS does NOT enforce it (RLS is tenant-scoped only). Every learner route
// must filter on the caller's party_id.

// Ordered units of study inside ONE batch. Modules hang off cohort rather
// than course on purpose: each batch's trainer curates their own material.
export const module = pgTable(
  "module",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    cohortId: uuid("cohort_id").notNull().references(() => cohort.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull().default(0),
    title: text("title").notNull(),
    summary: text("summary"),
    // Draft modules are invisible to learners; admins build then publish.
    status: text("status").notNull().default("draft"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    cohortIdx: index("module_cohort_idx").on(t.tenantId, t.cohortId, t.rank),
    statusCheck: check("module_status_check", sql`${t.status} IN ('draft','published')`),
  }),
);

// One row per piece of material. `kind` selects which payload column is
// meaningful — a CHECK guarantees the matching one is populated, so a video
// row can always be played and a link row always resolves.
export const moduleResource = pgTable(
  "module_resource",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    moduleId: uuid("module_id").notNull().references(() => module.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull().default(0),
    title: text("title").notNull(),
    kind: text("kind").notNull(),  // video | recording | document | note | link
    // Vimeo ID only, never a URL — the embed template and privacy options
    // then live in one place in code instead of in every row.
    videoProvider: text("video_provider"),
    videoRef: text("video_ref"),
    durationSeconds: integer("duration_seconds"),
    // kind='recording': point at the class rather than copying its URL, so
    // batch_session stays the single source of truth for recordings.
    batchSessionId: uuid("batch_session_id").references(() => batchSession.id, { onDelete: "set null" }),
    body: text("body"),                 // kind='note' — markdown
    mediaAssetId: uuid("media_asset_id"), // kind='document' — FK added SQL-side
    externalUrl: text("external_url"),  // kind='link'
    // Only required resources count toward module completion.
    required: boolean("required").notNull().default(true),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    moduleIdx: index("module_resource_module_idx").on(t.tenantId, t.moduleId, t.rank),
    sessionIdx: index("module_resource_session_idx").on(t.tenantId, t.batchSessionId),
    kindCheck: check("module_resource_kind_check",
      sql`${t.kind} IN ('video','recording','document','note','link')`),
    durationCheck: check("module_resource_duration_check",
      sql`${t.durationSeconds} IS NULL OR ${t.durationSeconds} > 0`),
    // module_resource_payload_check is SQL-side (post-0083) — it spans four
    // columns conditionally on kind, which Drizzle can't express inline.
  }),
);

// Per learner per resource. Facts only: position + completion. Every "44%"
// in the UI is computed from these — a stored percentage would go stale the
// moment an admin adds a resource.
export const resourceProgress = pgTable(
  "resource_progress",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    partyId: uuid("party_id").notNull().references(() => party.id),
    resourceId: uuid("resource_id").notNull().references(() => moduleResource.id, { onDelete: "cascade" }),
    positionSeconds: integer("position_seconds").notNull().default(0),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Upsert key for PUT …/progress.
    uniq: uniqueIndex("resource_progress_uniq").on(t.partyId, t.resourceId),
    partyIdx: index("resource_progress_party_idx").on(t.tenantId, t.partyId),
    resourceIdx: index("resource_progress_resource_idx").on(t.tenantId, t.resourceId),
    positionCheck: check("resource_progress_position_check", sql`${t.positionSeconds} >= 0`),
  }),
);

// Labs, assignments and assessments. Due dates live here rather than in a
// separate per-batch window table: a module belongs to exactly one batch, so
// definition and instance are the same row.
export const coursework = pgTable(
  "coursework",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    moduleId: uuid("module_id").notNull().references(() => module.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull().default(0),
    type: text("type").notNull(),   // lab | assignment | assessment
    title: text("title").notNull(),
    brief: text("brief"),
    maxScore: numeric("max_score", { precision: 6, scale: 2 }),
    passScore: numeric("pass_score", { precision: 6, scale: 2 }),
    // 'auto' is reserved. v1 grades by trainer — auto-grading needs a
    // question bank or an external autograder posting scores back.
    grading: text("grading").notNull().default("trainer"),
    opensAt: timestamp("opens_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    closesAt: timestamp("closes_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    moduleIdx: index("coursework_module_idx").on(t.tenantId, t.moduleId, t.rank),
    dueIdx: index("coursework_due_idx").on(t.tenantId, t.dueAt),
    typeCheck: check("coursework_type_check", sql`${t.type} IN ('lab','assignment','assessment')`),
    gradingCheck: check("coursework_grading_check", sql`${t.grading} IN ('trainer','auto')`),
    windowCheck: check("coursework_window_check",
      sql`${t.closesAt} IS NULL OR ${t.dueAt} IS NULL OR ${t.closesAt} >= ${t.dueAt}`),
  }),
);

export const submission = pgTable(
  "submission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    courseworkId: uuid("coursework_id").notNull().references(() => coursework.id, { onDelete: "cascade" }),
    partyId: uuid("party_id").notNull().references(() => party.id),
    attempt: integer("attempt").notNull().default(1),
    status: text("status").notNull().default("draft"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    content: jsonb("content").notNull().default(sql`'{}'::jsonb`),
    score: numeric("score", { precision: 6, scale: 2 }),
    feedback: text("feedback"),
    gradedBy: uuid("graded_by").references(() => party.id, { onDelete: "set null" }),
    gradedAt: timestamp("graded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("submission_uniq").on(t.courseworkId, t.partyId, t.attempt),
    courseworkIdx: index("submission_coursework_idx").on(t.tenantId, t.courseworkId),
    partyIdx: index("submission_party_idx").on(t.tenantId, t.partyId),
    statusIdx: index("submission_status_idx").on(t.tenantId, t.status),
    statusCheck: check("submission_status_check",
      sql`${t.status} IN ('draft','submitted','late','graded','returned')`),
    attemptCheck: check("submission_attempt_check", sql`${t.attempt} > 0`),
    scoreCheck: check("submission_score_check", sql`${t.score} IS NULL OR ${t.score} >= 0`),
    // A graded row must actually carry a score.
    gradedCheck: check("submission_graded_check", sql`${t.status} <> 'graded' OR ${t.score} IS NOT NULL`),
  }),
);

// v1 stores a reference to a file an admin uploads — not a render pipeline.
export const certificate = pgTable(
  "certificate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    enrolmentId: uuid("enrolment_id").notNull().references(() => enrolment.id, { onDelete: "cascade" }),
    partyId: uuid("party_id").notNull().references(() => party.id),
    number: text("number"),   // 'KD-CERT-20114', from seq_certificate
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    url: text("url"),
    mediaAssetId: uuid("media_asset_id"),  // FK added SQL-side
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    partyIdx: index("certificate_party_idx").on(t.tenantId, t.partyId),
    enrolmentIdx: index("certificate_enrolment_idx").on(t.tenantId, t.enrolmentId),
  }),
);

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

// ─── Lead tasks (post-0073) ──────────────────────────────────────────────
//
// The forward-looking counterpart to `activity`. `activity` logs what already
// happened; `lead_task` is what an advisor still owes a lead — a follow-up, a
// call, a demo, a campus visit — with a due date, a lifecycle and an owner.
// This is what the Leads calendar view reads.

export const leadTask = pgTable(
  "lead_task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    workItemId: uuid("work_item_id").notNull().references(() => workItem.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("follow_up"),
    title: text("title").notNull(),
    notes: text("notes"),
    // all_day rows still carry a timestamp (IST midnight) so one ORDER BY
    // due_at sorts timed and all-day rows together; the UI reads all_day to
    // decide whether to render a time.
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    allDay: boolean("all_day").notNull().default(false),
    durationMin: integer("duration_min"),
    status: text("status").notNull().default("open"),
    assigneePartyId: uuid("assignee_party_id").references(() => party.id, { onDelete: "set null" }),
    createdByPartyId: uuid("created_by_party_id").references(() => party.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantDueIdx: index("lead_task_tenant_due_idx").on(t.tenantId, t.dueAt),
    wiDueIdx: index("lead_task_wi_due_idx").on(t.tenantId, t.workItemId, t.dueAt),
    kindCheck: check(
      "lead_task_kind_check",
      sql`${t.kind} IN ('follow_up','call','demo','campus_visit','trainer_talk','enrollment','re_engage','task')`,
    ),
    statusCheck: check("lead_task_status_check", sql`${t.status} IN ('open','done','cancelled')`),
    durationCheck: check(
      "lead_task_duration_check",
      sql`${t.durationMin} IS NULL OR ${t.durationMin} BETWEEN 1 AND 1440`,
    ),
  }),
);

// ─── Message templates (post-0075) — saved canned replies ────────────────

export const messageTemplate = pgTable(
  "message_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    title: text("title").notNull(),
    body: text("body").notNull(),
    createdByPartyId: uuid("created_by_party_id").references(() => party.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantTitleIdx: index("message_template_tenant_title_idx").on(t.tenantId, t.title),
    titleLen: check("message_template_title_len", sql`char_length(${t.title}) BETWEEN 1 AND 120`),
    bodyLen: check("message_template_body_len", sql`char_length(${t.body}) BETWEEN 1 AND 4000`),
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

// ─── Twilio messaging (SMS + WhatsApp via Twilio) ────────────────────────
// One conversation row per (tenant, party, channel) — SMS and WA threads
// with the same person are separate rows. See post-0066-twilio.sql for
// the DDL + RLS.

export const twConversation = pgTable(
  "tw_conversation",
  {
    id:                uuid("id").primaryKey().defaultRandom(),
    tenantId:          uuid("tenant_id").notNull().references(() => tenant.id),
    partyId:           uuid("party_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    channel:           text("channel").notNull(),
    status:            text("status").notNull().default("open"),
    assignedUserId:    uuid("assigned_user_id").references(() => party.id, { onDelete: "set null" }),
    lastMessageText:   text("last_message_text"),
    lastMessageAt:     timestamp("last_message_at", { withTimezone: true }),
    lastInboundAt:     timestamp("last_inbound_at", { withTimezone: true }),
    unreadCount:       integer("unread_count").notNull().default(0),
    isUnlinked:        boolean("is_unlinked").notNull().default(false),
    createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantPartyChannelKey: uniqueIndex("tw_conversation_tenant_party_channel_key")
      .on(t.tenantId, t.partyId, t.channel),
    tenantStatusIdx: index("tw_conversation_tenant_status_idx")
      .on(t.tenantId, t.status, t.lastMessageAt),
    tenantChannelIdx: index("tw_conversation_tenant_channel_idx")
      .on(t.tenantId, t.channel, t.lastMessageAt),
    channelCheck: check("tw_conversation_channel_check",
      sql`${t.channel} IN ('sms','whatsapp','voice','email')`),
    statusCheck: check("tw_conversation_status_check",
      sql`${t.status} IN ('open','closed')`),
  }),
);

export const twMessage = pgTable(
  "tw_message",
  {
    id:                  uuid("id").primaryKey().defaultRandom(),
    tenantId:            uuid("tenant_id").notNull().references(() => tenant.id),
    conversationId:      uuid("conversation_id").notNull()
                           .references(() => twConversation.id, { onDelete: "cascade" }),
    direction:           text("direction").notNull(),
    channel:             text("channel").notNull(),
    // post-0074: 'message' | 'note' | 'call_log'. Only 'message' is ever sent to
    // a provider — an internal note is staff-only and never transmitted.
    kind:                text("kind").notNull().default("message"),
    // Structured detail for call_log rows (outcome, durationSec, …). Empty {}
    // for everything else.
    meta:                jsonb("meta").notNull().default({}),
    // Nullable since post-0074: notes and call logs have no addresses.
    fromNumber:          text("from_number"),
    toNumber:            text("to_number"),
    body:                text("body"),
    providerMessageId:   text("provider_message_id"),
    status:              text("status").notNull().default("queued"),
    errorCode:           text("error_code"),
    errorMessage:        text("error_message"),
    senderUserId:        uuid("sender_user_id").references(() => party.id, { onDelete: "set null" }),
    sentAt:              timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt:         timestamp("delivered_at", { withTimezone: true }),
    rawPayload:          jsonb("raw_payload"),
    contentSid:          text("content_sid"),
    contentVariables:    jsonb("content_variables"),
    campaignId:          uuid("campaign_id"),
    // Email-only (channel='email'). See post-0072-gmail.sql. Note that for
    // email rows, fromNumber/toNumber above hold email ADDRESSES — the
    // column names are a Twilio-era legacy the voice channel already inherited.
    subject:             text("subject"),
    bodyHtml:            text("body_html"),
    toAddrs:             text("to_addrs").array(),
    ccAddrs:             text("cc_addrs").array(),
    providerThreadId:    text("provider_thread_id"),
    rfc822MessageId:     text("rfc822_message_id"),
    inReplyTo:           text("in_reply_to"),
    gmailAccountId:      uuid("gmail_account_id"),
  },
  (t) => ({
    conversationSentIdx: index("tw_message_conversation_sent_idx")
      .on(t.conversationId, t.sentAt),
    tenantSentIdx: index("tw_message_tenant_sent_idx")
      .on(t.tenantId, t.sentAt),
    providerMessageIdKey: uniqueIndex("tw_message_provider_message_id_key")
      .on(t.providerMessageId),
    campaignIdx: index("tw_message_campaign_idx")
      .on(t.campaignId, t.sentAt),
    providerThreadIdx: index("tw_message_provider_thread_idx")
      .on(t.providerThreadId),
    rfc822Idx: index("tw_message_rfc822_idx")
      .on(t.rfc822MessageId),
    directionCheck: check("tw_message_direction_check",
      sql`${t.direction} IN ('inbound','outbound')`),
    channelCheck: check("tw_message_channel_check",
      sql`${t.channel} IN ('sms','whatsapp','voice','email')`),
    statusCheck: check("tw_message_status_check",
      sql`${t.status} IN ('queued','sent','delivered','read','failed','received')`),
  }),
);

// ─── Gmail (two-way email) ───────────────────────────────────────────────
// One row per connected mailbox. Per-user accounts have appUserId set; the
// shared fallback mailbox (GMAIL_SHARED_ACCOUNT_EMAIL) has isShared=true and
// appUserId NULL. Email messages themselves live in tw_message with
// channel='email'. See post-0072-gmail.sql.

export const gmailAccount = pgTable(
  "gmail_account",
  {
    id:              uuid("id").primaryKey().defaultRandom(),
    tenantId:        uuid("tenant_id").notNull().references(() => tenant.id),
    appUserId:       uuid("app_user_id"),
    email:           text("email").notNull(),
    refreshToken:    text("refresh_token").notNull(),
    accessToken:     text("access_token"),
    expiresAt:       timestamp("expires_at", { withTimezone: true }),
    scopes:          text("scopes"),
    isShared:        boolean("is_shared").notNull().default(false),
    historyId:       text("history_id"),
    lastSyncedAt:    timestamp("last_synced_at", { withTimezone: true }),
    syncErrorCount:  integer("sync_error_count").notNull().default(0),
    syncError:       text("sync_error"),
    connectedAt:     timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt:       timestamp("revoked_at", { withTimezone: true }),
    createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    appUserKey:      uniqueIndex("gmail_account_app_user_key").on(t.appUserId),
    tenantEmailKey:  uniqueIndex("gmail_account_tenant_email_key").on(t.tenantId, t.email),
    tenantIdx:       index("gmail_account_tenant_idx").on(t.tenantId),
  }),
);

// ─── WhatsApp templates (Twilio Content Builder cache) ────────────────────
// See post-0068-templates.sql for DDL + RLS.

export const waTemplate = pgTable(
  "wa_template",
  {
    id:              uuid("id").primaryKey().defaultRandom(),
    tenantId:        uuid("tenant_id").notNull().references(() => tenant.id),
    contentSid:      text("content_sid").notNull(),
    friendlyName:    text("friendly_name").notNull(),
    language:        text("language"),
    category:        text("category"),
    variables:       jsonb("variables").notNull().default(sql`'{}'::jsonb`),
    types:           jsonb("types").notNull().default(sql`'{}'::jsonb`),
    approvalStatus:  text("approval_status").notNull().default("unknown"),
    approvalNote:    text("approval_note"),
    syncedAt:        timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantContentSidKey: uniqueIndex("wa_template_tenant_content_sid_key")
      .on(t.tenantId, t.contentSid),
    tenantApprovalIdx: index("wa_template_tenant_approval_idx")
      .on(t.tenantId, t.approvalStatus),
    approvalStatusCheck: check("wa_template_approval_status_check",
      sql`${t.approvalStatus} IN ('draft','pending','approved','rejected','unknown','paused')`),
  }),
);

// ─── Campaigns ────────────────────────────────────────────────────────────
// See post-0069-campaigns.sql for DDL + RLS.

export const campaign = pgTable(
  "campaign",
  {
    id:                       uuid("id").primaryKey().defaultRandom(),
    tenantId:                 uuid("tenant_id").notNull().references(() => tenant.id),
    name:                     text("name").notNull(),
    createdBy:                uuid("created_by").references(() => party.id, { onDelete: "set null" }),
    channel:                  text("channel").notNull().default("whatsapp"),
    contentSid:               text("content_sid").notNull(),
    contentVariableBindings:  jsonb("content_variable_bindings").notNull().default(sql`'{}'::jsonb`),
    audience:                 jsonb("audience").notNull().default(sql`'{}'::jsonb`),
    status:                   text("status").notNull().default("draft"),
    scheduledAt:              timestamp("scheduled_at", { withTimezone: true }),
    sendRatePerSec:           integer("send_rate_per_sec").notNull().default(5),
    dailyCap:                 integer("daily_cap"),
    createdAt:                timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt:                timestamp("started_at", { withTimezone: true }),
    completedAt:              timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    tenantStatusIdx: index("campaign_tenant_status_idx")
      .on(t.tenantId, t.status, t.scheduledAt),
    statusCheck: check("campaign_status_check",
      sql`${t.status} IN ('draft','scheduled','running','paused','completed','cancelled')`),
    channelCheck: check("campaign_channel_check",
      sql`${t.channel} IN ('whatsapp','sms')`),
    sendRateCheck: check("campaign_send_rate_check",
      sql`${t.sendRatePerSec} BETWEEN 1 AND 100`),
  }),
);

export const campaignRecipient = pgTable(
  "campaign_recipient",
  {
    id:                  uuid("id").primaryKey().defaultRandom(),
    tenantId:            uuid("tenant_id").notNull().references(() => tenant.id),
    campaignId:          uuid("campaign_id").notNull().references(() => campaign.id, { onDelete: "cascade" }),
    partyId:             uuid("party_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    workItemId:          uuid("work_item_id").references(() => workItem.id, { onDelete: "set null" }),
    status:              text("status").notNull().default("pending"),
    errorCode:           text("error_code"),
    errorMessage:        text("error_message"),
    twMessageId:         uuid("tw_message_id").references(() => twMessage.id, { onDelete: "set null" }),
    resolvedVariables:   jsonb("resolved_variables"),
    queuedAt:            timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt:              timestamp("sent_at", { withTimezone: true }),
    deliveredAt:         timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => ({
    campaignPartyKey: uniqueIndex("campaign_recipient_campaign_party_key")
      .on(t.campaignId, t.partyId),
    campaignStatusIdx: index("campaign_recipient_campaign_status_idx")
      .on(t.campaignId, t.status),
    twMessageIdx: index("campaign_recipient_tw_message_idx")
      .on(t.twMessageId),
    statusCheck: check("campaign_recipient_status_check",
      sql`${t.status} IN ('pending','sending','sent','delivered','read',
                          'failed','skipped_optout','skipped_no_phone','skipped_dup')`),
  }),
);

// ─── Campaign triggers (event-driven auto-sends) ─────────────────────────
// See post-0070-campaign-triggers.sql for DDL + RLS.

export const campaignTrigger = pgTable(
  "campaign_trigger",
  {
    id:                uuid("id").primaryKey().defaultRandom(),
    tenantId:          uuid("tenant_id").notNull().references(() => tenant.id),
    name:              text("name").notNull(),
    contentSid:        text("content_sid").notNull(),
    variableBindings:  jsonb("variable_bindings").notNull().default(sql`'{}'::jsonb`),
    eventType:         text("event_type").notNull(),
    condition:         jsonb("condition").notNull().default(sql`'{}'::jsonb`),
    cooldownHours:     integer("cooldown_hours").notNull().default(24),
    enabled:           boolean("enabled").notNull().default(false),
    autoCampaignId:    uuid("auto_campaign_id").references(() => campaign.id, { onDelete: "set null" }),
    createdBy:         uuid("created_by").references(() => party.id, { onDelete: "set null" }),
    createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantEventEnabledIdx: index("campaign_trigger_tenant_event_enabled_idx")
      .on(t.tenantId, t.eventType, t.enabled),
    eventCheck: check("campaign_trigger_event_check",
      sql`${t.eventType} IN ('lead.stage_changed','lead.created','lead.rating_changed')`),
  }),
);

export const campaignTriggerFire = pgTable(
  "campaign_trigger_fire",
  {
    id:           uuid("id").primaryKey().defaultRandom(),
    tenantId:     uuid("tenant_id").notNull().references(() => tenant.id),
    triggerId:    uuid("trigger_id").notNull().references(() => campaignTrigger.id, { onDelete: "cascade" }),
    partyId:      uuid("party_id").notNull().references(() => party.id, { onDelete: "cascade" }),
    workItemId:   uuid("work_item_id").references(() => workItem.id, { onDelete: "set null" }),
    firedAt:      timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
    recipientId:  uuid("recipient_id").references(() => campaignRecipient.id, { onDelete: "set null" }),
    outcome:      text("outcome").notNull().default("queued"),
  },
  (t) => ({
    triggerPartyIdx: index("campaign_trigger_fire_trigger_party_idx")
      .on(t.triggerId, t.partyId, t.firedAt),
  }),
);

// ─── Media library + Twilio message attachments ──────────────────────────
// See post-0067-media.sql for DDL + RLS.

export const mediaFolder = pgTable(
  "media_folder",
  {
    id:         uuid("id").primaryKey().defaultRandom(),
    tenantId:   uuid("tenant_id").notNull().references(() => tenant.id),
    name:       text("name").notNull(),
    createdBy:  uuid("created_by").references(() => party.id, { onDelete: "set null" }),
    createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantNameKey: uniqueIndex("media_folder_tenant_name_key")
      .on(t.tenantId, sql`lower(${t.name})`),
  }),
);

export const mediaAsset = pgTable(
  "media_asset",
  {
    id:              uuid("id").primaryKey().defaultRandom(),
    tenantId:        uuid("tenant_id").notNull().references(() => tenant.id),
    folderId:        uuid("folder_id").references(() => mediaFolder.id, { onDelete: "set null" }),
    uploadedBy:      uuid("uploaded_by").references(() => party.id, { onDelete: "set null" }),
    filename:        text("filename").notNull(),
    contentType:     text("content_type").notNull(),
    sizeBytes:       bigint("size_bytes", { mode: "bigint" }).notNull(),
    sha256:          text("sha256"),
    blobUrl:         text("blob_url").notNull(),
    blobPathname:    text("blob_pathname"),
    isLibrary:       boolean("is_library").notNull().default(false),
    source:          text("source").notNull().default("user_upload"),
    providerHosted:  boolean("provider_hosted").notNull().default(false),
    deletedAt:       timestamp("deleted_at", { withTimezone: true }),
    createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantFolderIdx: index("media_asset_tenant_folder_idx")
      .on(t.tenantId, t.folderId, t.createdAt),
    tenantUploaderIdx: index("media_asset_tenant_uploader_idx")
      .on(t.tenantId, t.uploadedBy, t.createdAt),
    sourceCheck: check("media_asset_source_check",
      sql`${t.source} IN ('user_upload','twilio_inbound','exotel_recording')`),
  }),
);

export const twMessageMedia = pgTable(
  "tw_message_media",
  {
    messageId:  uuid("message_id").notNull()
                  .references(() => twMessage.id, { onDelete: "cascade" }),
    assetId:    uuid("asset_id").notNull()
                  .references(() => mediaAsset.id, { onDelete: "restrict" }),
    ordinal:    integer("ordinal").notNull(),
  },
  (t) => ({
    pk:         uniqueIndex("tw_message_media_pk").on(t.messageId, t.ordinal),
    assetIdx:   index("tw_message_media_asset_idx").on(t.assetId),
  }),
);

// ─── Exotel voice call events ────────────────────────────────────────────
// One row per callback fired by Exotel StatusCallback + Passthru webhooks.
// Ties into the same tw_message row that click-to-call inserted; unique
// on (tw_message_id, event_type) so Exotel retries are idempotent.
export const twCallEvent = pgTable(
  "tw_call_event",
  {
    id:              uuid("id").primaryKey().defaultRandom(),
    tenantId:        uuid("tenant_id").notNull().references(() => tenant.id),
    twMessageId:     uuid("tw_message_id").notNull().references(() => twMessage.id, { onDelete: "cascade" }),
    callSid:         text("call_sid").notNull(),
    eventType:       text("event_type").notNull(),
    status:          text("status"),
    durationSeconds: integer("duration_seconds"),
    recordingUrl:    text("recording_url"),
    legs:            jsonb("legs"),
    raw:             jsonb("raw").notNull(),
    receivedAt:      timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    msgEvtKey: uniqueIndex("tw_call_event_msg_evt_key").on(t.twMessageId, t.eventType),
    callSidIdx: index("tw_call_event_call_sid_idx").on(t.callSid, t.receivedAt),
  }),
);

// ─── Interakt (WhatsApp) sync ─────────────────────────────────────────────
// One row per tenant holding the Interakt "Secret Key" (already base64 from the
// Interakt dashboard — used verbatim as `Authorization: Basic <key>`). Powers
// the "Sync to Interakt" action that pushes lead details to Interakt as user
// traits. See post-0081-interakt.sql for RLS + grants.
export const interaktAccount = pgTable(
  "interakt_account",
  {
    id:         uuid("id").primaryKey().defaultRandom(),
    tenantId:   uuid("tenant_id").notNull().references(() => tenant.id),
    apiKey:     text("api_key"),               // base64 Secret Key; nullable until configured
    enabled:    boolean("enabled").notNull().default(true),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantUnique: uniqueIndex("interakt_account_tenant_unique").on(t.tenantId),
  }),
);

// ─── Workforce (post-0089) ────────────────────────────────────────────────
//
// A satellite of `party`, keyed by party_id, exactly like learnerProfile. A
// worker is a person the business already knows — name, email, phone and city
// stay on party + contactPoint and are never stored twice here.
//
// Restricted HR data (salary, documents, performance) is deliberately absent.
// What is here is what the CRM schedules and staffs against; anything more
// would make this a payroll table with no access control in front of it.
export const worker = pgTable(
  "worker",
  {
    partyId: uuid("party_id").primaryKey().references(() => party.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    // WRK-01042 — DB default off seq_worker, so every insert path gets one.
    employeeNumber: text("employee_number").notNull(),
    // 'trainer' here is the employment type. Distinct from trainerCapable
    // below: a delivery manager can be trainer-capable without being one.
    workerType: text("worker_type").notNull().default("employee"),
    designation: text("designation"),
    department: text("department"),
    employmentType: text("employment_type"),
    dateOfJoining: date("date_of_joining"),
    dateOfExit: date("date_of_exit"),
    // party_id, not worker_id, so a manager whose worker row is gone does not
    // orphan their reports.
    reportingToPartyId: uuid("reporting_to_party_id").references(() => party.id, { onDelete: "set null" }),
    status: text("status").notNull().default("active"),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    workingHoursPerWeek: numeric("working_hours_per_week", { precision: 5, scale: 2 }),
    // Free text on purpose — shifts vary per team and an enum would be wrong
    // within a month.
    shift: text("shift"),
    // Read whole, written whole, never joined against a skill master.
    skills: text("skills").array().notNull().default(sql`'{}'::text[]`),
    // The two flags the scheduler filters on. Columns rather than derived from
    // `skills` because "can teach" and "can be deployed" are decisions
    // somebody makes, not facts about a skill list.
    trainerCapable: boolean("trainer_capable").notNull().default(false),
    deploymentAvailable: boolean("deployment_available").notNull().default(false),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    employeeNumberUniq: uniqueIndex("worker_employee_number_uniq").on(t.tenantId, t.employeeNumber),
    statusIdx: index("worker_tenant_status_idx").on(t.tenantId, t.status),
    departmentIdx: index("worker_department_idx").on(t.tenantId, t.department),
    reportingIdx: index("worker_reporting_idx").on(t.tenantId, t.reportingToPartyId),
    typeCheck: check("worker_type_check",
      sql`${t.workerType} IN ('employee','contractor','trainer','intern','vendor')`),
    employmentTypeCheck: check("worker_employment_type_check",
      sql`${t.employmentType} IS NULL OR ${t.employmentType} IN ('full_time','part_time','contract','intern')`),
    statusCheck: check("worker_status_check",
      sql`${t.status} IN ('active','on_leave','notice_period','exited')`),
    noSelfReportCheck: check("worker_no_self_report_check",
      sql`${t.reportingToPartyId} IS NULL OR ${t.reportingToPartyId} <> ${t.partyId}`),
  }),
);

// ─── B2B (post-0090) ──────────────────────────────────────────────────────
//
// Accounts and contacts are party satellites, not new identity tables.
// `party.kind` already separates person from organisation, and
// `partyAffiliation` already models person↔organisation with a role and a
// valid interval — which IS the workbook's contact.account_id plus
// affiliation_valid_from/to. A separate account identity would fork the
// dedupe, merge and consent machinery that post-0040…0052 exist to provide.

export const account = pgTable(
  "account",
  {
    partyId: uuid("party_id").primaryKey().references(() => party.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    accountNumber: text("account_number").notNull(),
    // What we sell them, not a mutually exclusive bucket — plenty of
    // organisations both buy training and hire the graduates.
    accountType: text("account_type").notNull().default("prospect"),
    industry: text("industry"),
    ownership: text("ownership"),
    website: text("website"),
    // Rupees, like every other money column here. The workbook ships minor
    // units; the importer divides by 100.
    annualRevenue: numeric("annual_revenue", { precision: 16, scale: 2 }),
    currency: text("currency").notNull().default("INR"),
    ownerPartyId: uuid("owner_party_id").references(() => party.id, { onDelete: "set null" }),
    rating: text("rating"),
    status: text("status").notNull().default("active"),
    description: text("description"),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberUniq: uniqueIndex("account_number_uniq").on(t.tenantId, t.accountNumber),
    statusIdx: index("account_tenant_status_idx").on(t.tenantId, t.status),
    ownerIdx: index("account_owner_idx").on(t.tenantId, t.ownerPartyId),
    typeIdx: index("account_type_idx").on(t.tenantId, t.accountType),
    typeCheck: check("account_type_check",
      sql`${t.accountType} IN ('client','prospect','partner','vendor','hiring_partner')`),
    ratingCheck: check("account_rating_check",
      sql`${t.rating} IS NULL OR ${t.rating} IN ('hot','warm','cold')`),
    statusCheck: check("account_status_check",
      sql`${t.status} IN ('active','inactive','churned')`),
  }),
);

// No accountId column: the employer link is a partyAffiliation row, which
// already carries isPrimary and the valid interval. Storing it twice would
// mean one of the two is eventually wrong.
export const contact = pgTable(
  "contact",
  {
    partyId: uuid("party_id").primaryKey().references(() => party.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    jobTitle: text("job_title"),
    department: text("department"),
    // What they do in a buying decision — distinct from jobTitle. A CTO can be
    // the evaluator on one deal and the sponsor on the next.
    contactRole: text("contact_role"),
    preferredContactMethod: text("preferred_contact_method"),
    preferredLanguage: text("preferred_language"),
    state: text("state"),
    country: text("country").notNull().default("India"),
    description: text("description"),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("contact_tenant_idx").on(t.tenantId),
    roleIdx: index("contact_role_idx").on(t.tenantId, t.contactRole),
    preferredMethodCheck: check("contact_preferred_method_check",
      sql`${t.preferredContactMethod} IS NULL OR ${t.preferredContactMethod} IN ('email','phone','whatsapp','sms','none')`),
    roleCheck: check("contact_role_check",
      sql`${t.contactRole} IS NULL OR ${t.contactRole} IN ('decision_maker','evaluator','sponsor','influencer','user','gatekeeper')`),
  }),
);

// ─── Staffing (post-0091) ─────────────────────────────────────────────────
//
// The gate into this module is NOT restated here. learnerProfile carries
// staffingEligibilityStatus and staffingConsentStatus because both are facts
// about the LEARNER — withdraw consent and they must leave staffing however
// many applications are open. `candidate` holds only the recruiting profile.
// The `candidate_eligible` view (post-0091) is where the gate is expressed.

export const requisition = pgTable(
  "requisition",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    number: text("number").notNull(),                 // REQ-01042
    accountPartyId: uuid("account_party_id").notNull().references(() => account.partyId, { onDelete: "cascade" }),
    jobTitle: text("job_title").notNull(),
    designation: text("designation"),
    department: text("department"),
    jobDescription: text("job_description"),
    keyResponsibilities: text("key_responsibilities"),
    openings: integer("openings").notNull().default(1),
    employmentType: text("employment_type"),
    workLocation: text("work_location"),
    workMode: text("work_mode"),
    // Months, not years — a range in years cannot express "18 months
    // minimum", which is exactly where a graduate of a six-month pathway sits.
    minimumExperienceMonths: integer("minimum_experience_months"),
    maximumExperienceMonths: integer("maximum_experience_months"),
    requiredQualification: text("required_qualification"),
    requiredSkills: text("required_skills").array().notNull().default(sql`'{}'::text[]`),
    preferredSkills: text("preferred_skills").array().notNull().default(sql`'{}'::text[]`),
    languages: text("languages").array().notNull().default(sql`'{}'::text[]`),
    salaryMin: numeric("salary_min", { precision: 14, scale: 2 }),
    salaryMax: numeric("salary_max", { precision: 14, scale: 2 }),
    currency: text("currency").notNull().default("INR"),
    budgetApproved: boolean("budget_approved").notNull().default(false),
    hiringManagerPartyId: uuid("hiring_manager_party_id").references(() => party.id, { onDelete: "set null" }),
    recruiterPartyId: uuid("recruiter_party_id").references(() => party.id, { onDelete: "set null" }),
    approvalStatus: text("approval_status").notNull().default("not_required"),
    approvedByPartyId: uuid("approved_by_party_id").references(() => party.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    priority: integer("priority").notNull().default(3),
    targetCloseDate: date("target_close_date"),
    status: text("status").notNull().default("draft"),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberUniq: uniqueIndex("requisition_number_uniq").on(t.tenantId, t.number),
    accountIdx: index("requisition_account_idx").on(t.tenantId, t.accountPartyId),
    statusIdx: index("requisition_status_idx").on(t.tenantId, t.status),
    recruiterIdx: index("requisition_recruiter_idx").on(t.tenantId, t.recruiterPartyId),
    openingsCheck: check("requisition_openings_check", sql`${t.openings} > 0`),
    workModeCheck: check("requisition_work_mode_check",
      sql`${t.workMode} IS NULL OR ${t.workMode} IN ('onsite','remote','hybrid')`),
    approvalStatusCheck: check("requisition_approval_status_check",
      sql`${t.approvalStatus} IN ('not_required','pending','approved','rejected')`),
    statusCheck: check("requisition_status_check",
      sql`${t.status} IN ('draft','open','on_hold','filled','cancelled','closed')`),
    // An approved requisition records who approved it and when — otherwise the
    // approval trail is decorative.
    approvedEvidenceCheck: check("requisition_approved_evidence_check",
      sql`${t.approvalStatus} <> 'approved' OR (${t.approvedByPartyId} IS NOT NULL AND ${t.approvedAt} IS NOT NULL)`),
  }),
);

export const candidate = pgTable(
  "candidate",
  {
    partyId: uuid("party_id").primaryKey().references(() => party.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    number: text("number").notNull(),                 // CAN-01042
    totalExperienceMonths: integer("total_experience_months"),
    currentEmployer: text("current_employer"),
    currentDesignation: text("current_designation"),
    currentCtc: numeric("current_ctc", { precision: 14, scale: 2 }),
    expectedCtc: numeric("expected_ctc", { precision: 14, scale: 2 }),
    currency: text("currency").notNull().default("INR"),
    noticePeriodDays: integer("notice_period_days"),
    skills: text("skills").array().notNull().default(sql`'{}'::text[]`),
    highestQualification: text("highest_qualification"),
    workHistorySummary: text("work_history_summary"),
    certifications: text("certifications").array().notNull().default(sql`'{}'::text[]`),
    resumeAttachmentId: uuid("resume_attachment_id").references((): AnyPgColumn => attachment.id, { onDelete: "set null" }),
    portfolioUrl: text("portfolio_url"),
    profileStatus: text("profile_status").notNull().default("draft"),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberUniq: uniqueIndex("candidate_number_uniq").on(t.tenantId, t.number),
    statusIdx: index("candidate_status_idx").on(t.tenantId, t.profileStatus),
    profileStatusCheck: check("candidate_profile_status_check",
      sql`${t.profileStatus} IN ('draft','ready','active','placed','withdrawn')`),
  }),
);

export const application = pgTable(
  "application",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    number: text("number").notNull(),                 // APP-01042
    candidatePartyId: uuid("candidate_party_id").notNull().references(() => candidate.partyId, { onDelete: "cascade" }),
    requisitionId: uuid("requisition_id").notNull().references(() => requisition.id, { onDelete: "cascade" }),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    stage: text("stage").notNull().default("applied"),
    stageUpdatedAt: timestamp("stage_updated_at", { withTimezone: true }).notNull().defaultNow(),
    // The score is the model's; screeningFactors is the evidence behind it.
    // Both are kept because a rejection a candidate can contest needs to show
    // its reasoning, not just its number.
    screeningScore: integer("screening_score"),
    screeningFactors: jsonb("screening_factors").notNull().default(sql`'{}'::jsonb`),
    assignedRecruiterPartyId: uuid("assigned_recruiter_party_id").references(() => party.id, { onDelete: "set null" }),
    interviewStatus: text("interview_status"),
    offerStatus: text("offer_status"),
    rejectionReason: text("rejection_reason"),
    // An automated screen must be signed off by a human before it can reject
    // someone. 'not_required' is for applications a human staged by hand.
    humanReviewStatus: text("human_review_status").notNull().default("not_required"),
    status: text("status").notNull().default("open"),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Re-applying is a stage change, not a second row.
    candidateRequisitionUniq: uniqueIndex("application_candidate_requisition_uniq")
      .on(t.candidatePartyId, t.requisitionId),
    numberUniq: uniqueIndex("application_number_uniq").on(t.tenantId, t.number),
    requisitionIdx: index("application_requisition_idx").on(t.tenantId, t.requisitionId, t.stage),
    candidateIdx: index("application_candidate_idx").on(t.tenantId, t.candidatePartyId),
    recruiterIdx: index("application_recruiter_idx").on(t.tenantId, t.assignedRecruiterPartyId),
    stageCheck: check("application_stage_check",
      sql`${t.stage} IN ('applied','screening','shortlisted','interviewing','offered','hired','rejected','withdrawn')`),
    screeningScoreCheck: check("application_screening_score_check",
      sql`${t.screeningScore} IS NULL OR ${t.screeningScore} BETWEEN 0 AND 100`),
    humanReviewCheck: check("application_human_review_check",
      sql`${t.humanReviewStatus} IN ('not_required','pending','approved','rejected')`),
    statusCheck: check("application_status_check", sql`${t.status} IN ('open','closed')`),
    // A rejection says why. Empty rejections are how a pipeline stops being
    // reviewable.
    rejectionReasonCheck: check("application_rejection_reason_check",
      sql`${t.stage} <> 'rejected' OR (${t.rejectionReason} IS NOT NULL AND length(btrim(${t.rejectionReason})) > 0)`),
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
export type WaTemplate = typeof waTemplate.$inferSelect;
export type Campaign = typeof campaign.$inferSelect;
export type CampaignRecipient = typeof campaignRecipient.$inferSelect;
export type CampaignTrigger = typeof campaignTrigger.$inferSelect;
export type CampaignTriggerFire = typeof campaignTriggerFire.$inferSelect;
export type TwCallEvent = typeof twCallEvent.$inferSelect;
export type LearnerProfile = typeof learnerProfile.$inferSelect;
export type SlackRule = typeof slackRule.$inferSelect;
export type SlackDeliveryLog = typeof slackDeliveryLog.$inferSelect;
export type SlackWorkspace = typeof slackWorkspace.$inferSelect;
export type SlackShareTarget = typeof slackShareTarget.$inferSelect;
export type TwConversation = typeof twConversation.$inferSelect;
export type TwMessage = typeof twMessage.$inferSelect;
export type MediaFolder = typeof mediaFolder.$inferSelect;
export type MediaAsset = typeof mediaAsset.$inferSelect;
export type TwMessageMedia = typeof twMessageMedia.$inferSelect;
export type Worker = typeof worker.$inferSelect;
export type Account = typeof account.$inferSelect;
export type Contact = typeof contact.$inferSelect;
export type Requisition = typeof requisition.$inferSelect;
export type Candidate = typeof candidate.$inferSelect;
export type Application = typeof application.$inferSelect;
