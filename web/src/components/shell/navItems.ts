// Shared navigation registry. Both the IconRail (compact dark column) and
// the Sidebar (labeled column) read from this list so the two panels can't
// drift out of sync. Permission gates apply identically — anything that's
// hidden from one panel is hidden from the other.

import type { IconName } from "@/components/ui/Icon";
import type { SummaryResponse } from "@/lib/types";

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
   *  show for everyone. */
  requires?: string;
}

export function buildNavItems(summary: SummaryResponse): NavItem[] {
  const caseBadge = summary.cases?.open ? String(summary.cases.open) : undefined;
  const leadBadge = summary.overall.total ? String(summary.overall.total) : undefined;
  return [
    { href: "/",                          icon: "home",  label: "Agent Home" },
    { href: "/leads",                     icon: "users", label: "Leads",       badge: leadBadge, requires: "leads.read" },
    { href: "/pipeline",                  icon: "chart", label: "Pipeline",                       requires: "pipeline.read" },
    { href: "/inbox",                     icon: "chat",  label: "Inbox",                          requires: "whatsapp.read" },
    { href: "/learners",                  icon: "stamp", label: "Learners",                       requires: "learners.read" },
    { href: "/cases",                     icon: "inbox", label: "Cases",       badge: caseBadge, requires: "cases.read" },
    { href: "/timesheet",                 icon: "clock", label: "Timesheet",                      requires: "timesheets.read.self" },
    { href: "/calendar",                  icon: "spark", label: "Calendar",                       requires: "events.manage.self" },
    { href: "/agents",                    icon: "spark", label: "Agents",                         requires: "agents.read" },
    { href: "/scheduled",                 icon: "clock", label: "Scheduled" },
    { href: "/live-artifacts",            icon: "globe", label: "Live artifacts" },
    { href: "/dispatch",                  icon: "doc",   label: "Dispatch", pillBeta: true },
    { href: "/customize",                 icon: "star",  label: "Customize" },
    { href: "/admin/users",               icon: "users", label: "Admin · Users",      requires: "users.manage" },
    { href: "/admin/groups",              icon: "users", label: "Admin · Groups",     requires: "groups.manage" },
    { href: "/admin/programs",            icon: "doc",   label: "Admin · Programs",   requires: "admin.programs.manage" },
    { href: "/admin/courses",             icon: "doc",   label: "Admin · Courses",    requires: "admin.courses.manage" },
    { href: "/admin/cohorts",             icon: "build", label: "Admin · Batches",    requires: "admin.batches.manage" },
    { href: "/admin/timesheets",          icon: "clock", label: "Admin · Timesheets", requires: "timesheets.read.all" },
    { href: "/admin/reports/timesheets",  icon: "chart", label: "Admin · Reports",    requires: "timesheets.read.all" },
    { href: "/admin/integrations/slack",  icon: "globe", label: "Admin · Integrations", requires: "integrations.read" },
    { href: "/admin/integrations/whatsapp", icon: "chat", label: "Admin · WhatsApp",    requires: "whatsapp.read" },
    { href: "/whatsapp/broadcasts",       icon: "send",  label: "WA Broadcasts",         requires: "whatsapp.read" },
    { href: "/whatsapp/automations",      icon: "spark", label: "WA Automations",        requires: "whatsapp.read" },
    { href: "/admin/leads/deleted",       icon: "inbox", label: "Admin · Deleted leads", requires: "leads.delete" },
  ];
}

export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/leads") return pathname.startsWith("/leads") || pathname.startsWith("/records");
  if (href === "/learners") return pathname.startsWith("/learners");
  if (href === "/cases") return pathname.startsWith("/cases");
  if (href === "/whatsapp/broadcasts") return pathname.startsWith("/whatsapp/broadcasts");
  if (href === "/whatsapp/automations") return pathname.startsWith("/whatsapp/automations");
  return pathname.startsWith(href);
}
