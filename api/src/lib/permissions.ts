// Permission catalog — single source of truth.
// Group rows in user_group_permission carry these strings verbatim.

export const PERMISSIONS = [
  "users.read",
  "users.manage",
  "groups.read",
  "groups.manage",

  "leads.read",
  "leads.write",

  "pipeline.read",

  "tickets.read",
  "tickets.write",

  "learners.read",
  "learners.write",

  "admin.programs.manage",
  "admin.courses.manage",
  "admin.batches.manage",

  "agents.read",
  "agents.run",

  "reports.read",

  "timesheets.read.self",
  "timesheets.read.all",
  "clients.manage",
  "events.manage.self",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(s: string): s is Permission {
  return (PERMISSIONS as readonly string[]).includes(s);
}

// Default groups seeded once per tenant.
export const SYSTEM_GROUPS: Array<{ name: string; description: string; permissions: Permission[] }> = [
  {
    name: "Administrators",
    description: "Full access. Can manage users and groups.",
    permissions: [...PERMISSIONS],
  },
  {
    name: "Advisors",
    description: "Read everything CRM-side; write leads, tickets, learners.",
    permissions: [
      "leads.read", "leads.write",
      "pipeline.read",
      "tickets.read", "tickets.write",
      "learners.read", "learners.write",
      "agents.read", "agents.run",
      "reports.read",
      "timesheets.read.self",
      "events.manage.self",
    ],
  },
];
