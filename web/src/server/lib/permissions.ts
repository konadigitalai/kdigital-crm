// Permission catalog — single source of truth.
// Group rows in user_group_permission carry these strings verbatim.

export const PERMISSIONS = [
  "users.read",
  "users.manage",
  "groups.read",
  "groups.manage",

  "leads.read",
  "leads.write",
  "leads.delete",
  "leads.purge",

  "pipeline.read",
  "pipeline.write",

  "cases.read",
  "cases.write",

  "learners.read",
  "learners.write",

  "admin.programs.manage",
  "admin.courses.manage",
  "admin.batches.manage",

  // ─── Workforce ─────────────────────────────────────────────────────────
  // The staff directory. Read is separate from manage because the trainer
  // and recruiter pickers all over the app need to READ workers, while
  // editing someone's reporting line or exit date is an HR action.
  "workers.read",
  "workers.manage",

  // ─── B2B ───────────────────────────────────────────────────────────────
  // Organisations that buy training and hire graduates, the people inside
  // them, and the opportunity pipeline against them. Deliberately separate
  // from leads.*: a B2C advisor working a lead list has no reason to see
  // corporate deal values.
  "accounts.read",
  "accounts.write",
  "opportunities.read",
  "opportunities.write",

  // ─── Staffing ──────────────────────────────────────────────────────────
  // Requisitions, candidate profiles and applications. `staffing.decide` is
  // split out because moving someone to 'rejected' or 'hired' is a decision
  // about a person's livelihood, not an edit.
  "staffing.read",
  "staffing.write",
  "staffing.decide",

  "agents.read",
  "agents.run",

  "reports.read",

  "leaves.read.self",
  "leaves.read.all",
  "events.manage.self",

  "integrations.read",
  "integrations.manage",

  "messaging.read",
  "messaging.send",

  "media.read",
  "media.upload",
  "media.manage",

  // ─── LMS ───────────────────────────────────────────────────────────────
  // Two populations, deliberately disjoint.
  //
  // Staff side. lms.content.manage also covers updating cohort.status, so an
  // LMS admin can move a batch to 'running' without being granted
  // admin.batches.manage — that permission would surface the whole CRM
  // Batches module in their nav. Creating and deleting batches stays
  // CRM-side.
  "lms.content.manage",
  "lms.grade",

  // Learner side. `.self` follows leaves.read.self / events.manage.self.
  //
  // NOTE: the suffix is a naming convention, not an enforcement mechanism.
  // RLS is tenant-scoped and will happily return another learner's rows.
  // Every route carrying one of these MUST filter on req.user.partyId and
  // join through batch_assignment. The permission says "may read LMS data";
  // only the query says "…their own".
  "lms.read.self",
  "lms.progress.write.self",
  "lms.submit.self",
  "lms.requests.write.self",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(s: string): s is Permission {
  return (PERMISSIONS as readonly string[]).includes(s);
}

// Module catalog — drives the group-builder UI. Each module groups one or
// more permissions and gets a friendly label. The shape is also returned by
// GET /groups so the web client doesn't hard-code it.
export interface ModuleAccess {
  key: string;            // stable id for the module row
  label: string;          // human label shown in the UI
  description?: string;
  // Each access level is a labelled checkbox tied to one permission string.
  levels: { key: string; label: string; permission: Permission }[];
}

export const MODULE_CATALOG: ModuleAccess[] = [
  {
    key: "leads",
    label: "Leads",
    description: "View and edit lead records, ratings, follow-up dates. Purge lets you permanently erase soft-deleted leads.",
    levels: [
      { key: "read",   label: "Read",   permission: "leads.read" },
      { key: "write",  label: "Write",  permission: "leads.write" },
      { key: "delete", label: "Delete", permission: "leads.delete" },
      { key: "purge",  label: "Purge",  permission: "leads.purge"  },
    ],
  },
  {
    key: "pipeline",
    label: "Pipeline",
    description: "Kanban view of leads. Write lets users drag between columns.",
    levels: [
      { key: "read",  label: "Read",  permission: "pipeline.read" },
      { key: "write", label: "Write", permission: "pipeline.write" },
    ],
  },
  {
    key: "cases",
    label: "Cases",
    description: "Support cases, categories and assignees.",
    levels: [
      { key: "read",  label: "Read",  permission: "cases.read" },
      { key: "write", label: "Write", permission: "cases.write" },
    ],
  },
  {
    key: "learners",
    label: "Learners",
    description: "Converted leads, batch + course state.",
    levels: [
      { key: "read",  label: "Read",  permission: "learners.read" },
      { key: "write", label: "Write", permission: "learners.write" },
    ],
  },
  {
    key: "agents",
    label: "AI agents",
    description: "Edify chat, scoring, NBA, forecast, outreach.",
    levels: [
      { key: "read", label: "Read",   permission: "agents.read" },
      { key: "run",  label: "Run",    permission: "agents.run" },
    ],
  },
  {
    key: "calendar",
    label: "Calendar",
    description: "Personal calendar, events, batch sessions and meeting invites.",
    levels: [
      { key: "self", label: "Self-manage", permission: "events.manage.self" },
    ],
  },
  {
    key: "leaves",
    label: "Leaves",
    description: "Leave marking. 'All' grants visibility into other users' leaves.",
    levels: [
      { key: "self", label: "Own",       permission: "leaves.read.self" },
      { key: "all",  label: "Team",      permission: "leaves.read.all" },
    ],
  },
  {
    key: "reports",
    label: "Reports",
    description: "Cross-module reporting (admin reports page).",
    levels: [
      { key: "read", label: "Read", permission: "reports.read" },
    ],
  },
  {
    key: "programs",
    label: "Programs",
    description: "Top-level program catalog.",
    levels: [
      { key: "manage", label: "Manage", permission: "admin.programs.manage" },
    ],
  },
  {
    key: "courses",
    label: "Courses",
    description: "Courses inside each program.",
    levels: [
      { key: "manage", label: "Manage", permission: "admin.courses.manage" },
    ],
  },
  {
    key: "batches",
    label: "Batches",
    description: "Cohorts with trainer + co-trainer + schedule.",
    levels: [
      { key: "manage", label: "Manage", permission: "admin.batches.manage" },
    ],
  },
  {
    key: "workers",
    label: "Workforce directory",
    description: "Staff records — designation, department, reporting line, shift, skills, and the trainer/deployment flags the scheduler filters on. No salary or personal documents are stored.",
    levels: [
      { key: "read",   label: "Read",   permission: "workers.read" },
      { key: "manage", label: "Manage", permission: "workers.manage" },
    ],
  },
  {
    key: "accounts",
    label: "Accounts & contacts (B2B)",
    description: "Client and hiring-partner organisations, and the people inside them.",
    levels: [
      { key: "read",  label: "Read",  permission: "accounts.read" },
      { key: "write", label: "Write", permission: "accounts.write" },
    ],
  },
  {
    key: "opportunities",
    label: "Opportunities (B2B pipeline)",
    description: "Corporate deals against an account — stage, amount, close date. Separate from the B2C lead pipeline.",
    levels: [
      { key: "read",  label: "Read",  permission: "opportunities.read" },
      { key: "write", label: "Write", permission: "opportunities.write" },
    ],
  },
  {
    key: "staffing",
    label: "Staffing",
    description: "Requisitions, candidate profiles and applications. 'Decide' is separate because hiring and rejecting are decisions about a person, not edits.",
    levels: [
      { key: "read",   label: "Read",           permission: "staffing.read" },
      { key: "write",  label: "Write",          permission: "staffing.write" },
      { key: "decide", label: "Hire / reject",  permission: "staffing.decide" },
    ],
  },
  {
    key: "users",
    label: "User management",
    description: "Create users, reset passwords, assign groups + clients.",
    levels: [
      { key: "read",   label: "Read",   permission: "users.read" },
      { key: "manage", label: "Manage", permission: "users.manage" },
    ],
  },
  {
    key: "groups",
    label: "Permission groups",
    description: "Define who can do what.",
    levels: [
      { key: "read",   label: "Read",   permission: "groups.read" },
      { key: "manage", label: "Manage", permission: "groups.manage" },
    ],
  },
  {
    key: "integrations",
    label: "Integrations",
    description: "Slack and other outbound notification rules.",
    levels: [
      { key: "read",   label: "Read",   permission: "integrations.read" },
      { key: "manage", label: "Manage", permission: "integrations.manage" },
    ],
  },
  {
    key: "messaging",
    label: "Messaging (SMS / WhatsApp)",
    description: "Inbox + send SMS/WhatsApp to leads via Twilio.",
    levels: [
      { key: "read", label: "Read", permission: "messaging.read" },
      { key: "send", label: "Send", permission: "messaging.send" },
    ],
  },
  {
    key: "media",
    label: "Media library",
    description: "Upload files, manage the shared media library used when sending WhatsApp/SMS attachments.",
    levels: [
      { key: "read",   label: "Read",   permission: "media.read" },
      { key: "upload", label: "Upload", permission: "media.upload" },
      { key: "manage", label: "Manage", permission: "media.manage" },
    ],
  },
  {
    key: "lms_admin",
    label: "LMS administration",
    description: "Build modules inside a batch, attach videos and documents, set coursework and due dates, update batch status, and grade submissions.",
    levels: [
      { key: "content", label: "Manage content", permission: "lms.content.manage" },
      { key: "grade",   label: "Grade",          permission: "lms.grade" },
    ],
  },
  {
    key: "lms_learner",
    label: "LMS (learner)",
    description: "The student portal. Every level is scoped to the signed-in learner's own batches and submissions — never anyone else's.",
    levels: [
      { key: "read",     label: "View own batches",  permission: "lms.read.self" },
      { key: "progress", label: "Track progress",    permission: "lms.progress.write.self" },
      { key: "submit",   label: "Submit coursework", permission: "lms.submit.self" },
      { key: "requests", label: "Raise requests",    permission: "lms.requests.write.self" },
    ],
  },
];

// Quick-fill presets shown above the checkbox grid in the group editor.
// These are only suggestions — admins can tick/untick anything before saving.
export interface PermissionPreset {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
}

const ADVISOR_PERMS: Permission[] = [
  "leads.read", "leads.write", "leads.delete",
  "pipeline.read", "pipeline.write",
  "agents.read", "agents.run",
  "events.manage.self",
  "leaves.read.self",
  "reports.read",
  "messaging.read", "messaging.send",
  "media.read", "media.upload",
  // Reads the directory so the trainer/owner pickers resolve names. Not
  // manage — an advisor does not edit someone's employment record.
  "workers.read",
];

const SUPPORT_PERMS: Permission[] = [
  "cases.read", "cases.write",
  "learners.read", "learners.write",
  "events.manage.self",
  "leaves.read.self",
  "messaging.read", "messaging.send",
  "media.read", "media.upload",
  "workers.read",
];

const TRAINER_PERMS: Permission[] = [
  "learners.read",
  "events.manage.self",
  "leaves.read.self",
  "workers.read",
];

// Corporate sales. Deliberately has no leads.* — this person works accounts
// and opportunities, not the B2C lead list.
const CORPORATE_SALES_PERMS: Permission[] = [
  "accounts.read", "accounts.write",
  "opportunities.read", "opportunities.write",
  "workers.read",
  "agents.read",
  "reports.read",
  "events.manage.self",
  "leaves.read.self",
  "messaging.read", "messaging.send",
  "media.read", "media.upload",
];

// Recruiter. Reads learners (to see who is coming through) and accounts (to
// see who is hiring), owns the staffing pipeline end to end.
const RECRUITER_PERMS: Permission[] = [
  "staffing.read", "staffing.write", "staffing.decide",
  "accounts.read",
  "learners.read",
  "workers.read",
  "events.manage.self",
  "leaves.read.self",
  "messaging.read", "messaging.send",
  "media.read", "media.upload",
  "reports.read",
];

// LMS admin gets NO CRM permissions on purpose. navItems.ts gates every
// entry on a permission, so this person signs in and sees the LMS admin
// surface and nothing else — no Leads, no Cases, no Pipeline.
const LMS_ADMIN_PERMS: Permission[] = [
  "lms.content.manage",
  "lms.grade",
];

// The student. Four permissions, all self-scoped, nothing else in the CRM.
const LMS_LEARNER_PERMS: Permission[] = [
  "lms.read.self",
  "lms.progress.write.self",
  "lms.submit.self",
  "lms.requests.write.self",
];

const REPORTS_ONLY_PERMS: Permission[] = [
  "leads.read",
  "pipeline.read",
  "cases.read",
  "learners.read",
  "reports.read",
  "leaves.read.self",
];

export const PRESETS: PermissionPreset[] = [
  {
    key: "sales_advisor",
    name: "Sales advisor",
    description: "Lead pipeline + agents + own calendar / leaves.",
    permissions: ADVISOR_PERMS,
  },
  {
    key: "support_rep",
    name: "Support rep",
    description: "Cases + learners + own calendar / leaves.",
    permissions: SUPPORT_PERMS,
  },
  {
    key: "trainer",
    name: "Trainer",
    description: "See the batches you teach on your calendar; read learners.",
    permissions: TRAINER_PERMS,
  },
  {
    key: "corporate_sales",
    name: "Corporate sales",
    description: "B2B accounts + opportunity pipeline. No B2C lead access.",
    permissions: CORPORATE_SALES_PERMS,
  },
  {
    key: "recruiter",
    name: "Recruiter",
    description: "Requisitions, candidates and applications end to end.",
    permissions: RECRUITER_PERMS,
  },
  {
    key: "reports_only",
    name: "Reports only",
    description: "Read across modules; no edits anywhere.",
    permissions: REPORTS_ONLY_PERMS,
  },
  {
    key: "lms_admin",
    name: "LMS admin",
    description: "Build batch content and grade. No CRM access.",
    permissions: LMS_ADMIN_PERMS,
  },
  {
    key: "lms_learner",
    name: "LMS learner",
    description: "Student portal only — their own batches and submissions.",
    permissions: LMS_LEARNER_PERMS,
  },
];

// Default groups seeded once per tenant.
export const SYSTEM_GROUPS: Array<{ name: string; description: string; permissions: Permission[] }> = [
  {
    name: "Administrators",
    description: "Full access. Can manage users and groups.",
    permissions: [...PERMISSIONS],
  },
  {
    name: "Advisors",
    description: "Read everything CRM-side; write leads, cases, learners.",
    permissions: [
      "leads.read", "leads.write", "leads.delete",
      "pipeline.read", "pipeline.write",
      "cases.read", "cases.write",
      "learners.read", "learners.write",
      "agents.read", "agents.run",
      "reports.read",
      "leaves.read.self",
      "events.manage.self",
      "messaging.read", "messaging.send",
      "media.read", "media.upload", "media.manage",
    ],
  },
  {
    name: "Sales advisor",
    description: PRESETS[0]!.description,
    permissions: ADVISOR_PERMS,
  },
  {
    name: "Support rep",
    description: PRESETS[1]!.description,
    permissions: SUPPORT_PERMS,
  },
  {
    name: "Trainer",
    description: PRESETS[2]!.description,
    permissions: TRAINER_PERMS,
  },
  {
    name: "Corporate sales",
    description: "B2B accounts + opportunity pipeline. No B2C lead access.",
    permissions: CORPORATE_SALES_PERMS,
  },
  {
    name: "Recruiter",
    description: "Requisitions, candidates and applications end to end.",
    permissions: RECRUITER_PERMS,
  },
  {
    name: "Reports only",
    description: "Read across modules; no edits anywhere.",
    permissions: REPORTS_ONLY_PERMS,
  },
  {
    name: "LMS admin",
    description: "Build batch content and grade. No CRM access.",
    permissions: LMS_ADMIN_PERMS,
  },
  {
    name: "LMS learner",
    description: "Student portal only — their own batches and submissions.",
    permissions: LMS_LEARNER_PERMS,
  },
];
