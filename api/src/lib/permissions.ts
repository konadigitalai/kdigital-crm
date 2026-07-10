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
];

const SUPPORT_PERMS: Permission[] = [
  "cases.read", "cases.write",
  "learners.read", "learners.write",
  "events.manage.self",
  "leaves.read.self",
  "messaging.read", "messaging.send",
  "media.read", "media.upload",
];

const TRAINER_PERMS: Permission[] = [
  "learners.read",
  "events.manage.self",
  "leaves.read.self",
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
    key: "reports_only",
    name: "Reports only",
    description: "Read across modules; no edits anywhere.",
    permissions: REPORTS_ONLY_PERMS,
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
    name: "Reports only",
    description: PRESETS[3]!.description,
    permissions: REPORTS_ONLY_PERMS,
  },
];
