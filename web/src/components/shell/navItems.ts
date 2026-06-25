// Shared navigation registry. Both the IconRail (compact dark column) and
// the Sidebar (labeled column) read from this list so the two panels can't
// drift out of sync. Permission gates apply identically — anything that's
// hidden from one panel is hidden from the other.
//
// Admin / configuration entries (users, groups, programs, integrations,
// WhatsApp broadcasts/automations, etc.) live behind a single Settings
// link. /settings is a hub page that lists the sections the user has
// access to. Keeps the sidebar lean as the surface grows.

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
  "whatsapp.read",
  "leads.delete",
];

export function buildNavItems(summary: SummaryResponse): NavItem[] {
  const caseBadge = summary.cases?.open ? String(summary.cases.open) : undefined;
  const leadBadge = summary.overall.total ? String(summary.overall.total) : undefined;
  return [
    { href: "/",                          icon: "home",            label: "Agent Home" },
    // Inbox is hidden for now — WhatsApp conversations module is still WIP.
    // Re-enable by uncommenting once the inbox UX is finalized.
    // { href: "/inbox",                     icon: "message-square",  label: "Inbox",                          requires: "whatsapp.read" },
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

export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/leads") return pathname.startsWith("/leads") || pathname.startsWith("/records");
  if (href === "/learners") return pathname.startsWith("/learners");
  if (href === "/cases") return pathname.startsWith("/cases");
  // Settings is the new home for admin + integrations + WA broadcasts/automations.
  if (href === "/settings") {
    return pathname.startsWith("/settings")
        || pathname.startsWith("/admin")
        || pathname.startsWith("/whatsapp/broadcasts")
        || pathname.startsWith("/whatsapp/automations");
  }
  return pathname.startsWith(href);
}
