import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { NotProvisioned } from "@/components/shell/NotProvisioned";
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

  // null means the API wouldn't give us a user: either the session lapsed
  // between middleware and this fetch (401), or Auth0 authenticated someone
  // the CRM has no record for (403). Middleware already handles the first
  // case before we get here, so in practice this is the second.
  //
  // Rendering AppShell anyway would fire /agents/recent and /summary, get
  // 403 on both, and blow up with a stack trace — which is what used to
  // happen. Show them what to do instead.
  if (!me) return <NotProvisioned />;

  const perms = new Set(me.permissions);
  const hasCrm = CRM_PERMISSIONS.some((p) => perms.has(p));
  if (!hasCrm && perms.has("lms.read.self")) redirect("/learn");

  // Authenticated, known to the CRM, but the token carries no permission that
  // reaches any surface — almost always an Auth0 role that was never assigned.
  // AppShell would render, fetch /agents/recent and /summary, 403 on both, and
  // take the page down. Tell them what's missing instead.
  if (!hasCrm) return <NotProvisioned email={me.email} reason="no-permissions" />;

  return <AppShell>{children}</AppShell>;
}
