import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { getCurrentUser } from "@/lib/api";

// Same URL serves both audiences. A learner holds none of the CRM
// permissions, and AppShell fetches /agents/recent + /summary up front — so
// without this redirect their very first page load 403s before anything
// renders.
//
// The check has to live in the layout, not a page: layouts resolve before
// their children, and that's the only point we can bail out ahead of
// AppShell's data fetching.
//
// Anyone holding a CRM permission stays here, including an LMS admin who is
// also staff — they reach authoring through the Academy nav entry.
const CRM_PERMISSIONS = [
  "leads.read", "pipeline.read", "cases.read", "learners.read",
  "agents.read", "reports.read", "messaging.read", "media.read",
  "users.manage", "groups.manage", "integrations.read",
  "admin.programs.manage", "admin.courses.manage", "admin.batches.manage",
  "lms.content.manage",
];

export default async function AppGroupLayout({ children }: { children: React.ReactNode }) {
  const me = await getCurrentUser();
  if (me) {
    const perms = new Set(me.permissions);
    const hasCrm = CRM_PERMISSIONS.some((p) => perms.has(p));
    if (!hasCrm && perms.has("lms.read.self")) redirect("/learn");
  }
  return <AppShell>{children}</AppShell>;
}
