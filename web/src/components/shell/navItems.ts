// Shared navigation registry. Both the IconRail (compact dark column) and
// the Sidebar (labeled column) read from this list so the two panels can't
// drift out of sync. Permission gates apply identically — anything that's
// hidden from one panel is hidden from the other.
//
// Admin / configuration entries (users, groups, programs, integrations)
// live behind a single Settings link. /settings is a hub page that lists
// the sections the user has access to. Keeps the sidebar lean as the
// surface grows.

import type { IconName } from "@/components/ui/Icon";
import type { SummaryResponse } from "@/lib/types";
import type { CurrentUser } from "@/lib/types";

export interface NavItem {
  href: string;
  icon: IconName;
  /** The full label (used by the Sidebar and as the IconRail tooltip). */
  label: string;
  /** Optional small badge for the Sidebar (e.g. "12" leads). */
  badge?: string;
  /** Optional "Beta" pill on the Sidebar. */
  pillBeta?: boolean;
  /** Permission gate (matches lib/permissions.ts). Items with no `requires`
   *  show for everyone. Items in `requiresAny` show if the user has ANY of
   *  the listed permissions — useful for hub entries (Settings) that
   *  surface different sections per role. */
  requires?: string;
  requiresAny?: string[];
}

/** Permissions that surface ANY admin/config section in the Settings hub.
 *  If a user has any of these, the Settings sidebar entry is visible. */
export const SETTINGS_ANY_PERMISSIONS = [
  "users.manage",
  "groups.manage",
  "admin.programs.manage",
  "admin.courses.manage",
  "admin.batches.manage",
  "integrations.read",
  "leads.delete",
];

export function buildNavItems(summary: SummaryResponse): NavItem[] {
  const caseBadge = summary.cases?.open ? String(summary.cases.open) : undefined;
  const leadBadge = summary.overall.total ? String(summary.overall.total) : undefined;
  return [
    { href: "/",                          icon: "home",            label: "Agent Home" },
    { href: "/inbox",                     icon: "message-square",  label: "Inbox",                          requires: "messaging.read" },
    { href: "/leads",                     icon: "user-plus",       label: "Leads",       badge: leadBadge, requires: "leads.read" },
    { href: "/learners",                  icon: "graduation-cap",  label: "Learners",                       requires: "learners.read" },
    { href: "/cases",                     icon: "life-ring",       label: "Cases",       badge: caseBadge, requires: "cases.read" },
    { href: "/pipeline",                  icon: "pipeline",        label: "Pipeline",                       requires: "pipeline.read" },
    { href: "/admin/cohorts",             icon: "batches",         label: "Batches",                        requires: "admin.batches.manage" },
    { href: "/calendar",                  icon: "calendar",        label: "Calendar",                       requires: "events.manage.self" },
    { href: "/agents",                    icon: "robot",           label: "Agents",                         requires: "agents.read" },
    { href: "/settings",                  icon: "settings",        label: "Settings", requiresAny: SETTINGS_ANY_PERMISSIONS },
  ];
}

/** Filter nav items by the current user's permissions. Items with `requires`
 *  must match exactly; items with `requiresAny` match if the user has at
 *  least one of the listed permissions. */
export function filterNavItems(items: NavItem[], user: CurrentUser | null): NavItem[] {
  const perms = new Set(user?.permissions ?? []);
  return items.filter((it) => {
    if (it.requires && !perms.has(it.requires)) return false;
    if (it.requiresAny && !it.requiresAny.some((p) => perms.has(p))) return false;
    return true;
  });
}

// Resolve which sidebar entry should be marked "active" for a given URL.
//
// Rule: exactly one nav item lights up at a time. Items with their own
// dedicated entry (Batches → /admin/cohorts, Calendar → /calendar, etc.)
// always win over the generic Settings catch-all, even though their paths
// happen to live under /admin.
//
// The dedicated-entry exception list below MUST stay in sync with the
// `href` values that appear in buildNavItems().
const DEDICATED_HREFS = [
  "/inbox",
  "/leads",
  "/learners",
  "/cases",
  "/pipeline",
  "/admin/cohorts",   // Batches
  "/calendar",
  "/agents",
];

export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/leads") return pathname.startsWith("/leads") || pathname.startsWith("/records");
  if (href === "/learners") return pathname.startsWith("/learners");
  if (href === "/cases") return pathname.startsWith("/cases");
  // Settings is the catch-all for admin config. But it must NOT light up
  // when the user is on a path that has its own dedicated nav entry —
  // e.g. /admin/cohorts (Batches) is also under /admin, but we want only
  // Batches to highlight, not Settings.
  if (href === "/settings") {
    const onDedicated = DEDICATED_HREFS.some(
      (h) => h !== "/settings" && (pathname === h || pathname.startsWith(`${h}/`)),
    );
    if (onDedicated) return false;
    return pathname.startsWith("/settings")
        || pathname.startsWith("/admin");
  }
  // For every other entry, use strict prefix-with-boundary so /admin/cohorts
  // doesn't accidentally match /admin or vice versa.
  return pathname === href || pathname.startsWith(`${href}/`);
}
