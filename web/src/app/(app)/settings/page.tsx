// Settings hub. Lists every admin / configuration section the current
// user has access to. Items are grouped (Workspace, Operations, Channels,
// Data) so it scales as we add more.


//
// Each card links to its existing page (URLs unchanged from the previous
// flat sidebar). When a user has zero permissions for any section, we
// show a friendly empty state — but the sidebar entry would already be
// hidden by `requiresAny` in navItems, so they shouldn't reach here.

import Link from "next/link";
import { Topbar } from "@/components/shell/Topbar";
import { Icon, type IconName } from "@/components/ui/Icon";
import { getCurrentUser } from "@/lib/api";

interface SettingsCard {
  href: string;
  icon: IconName;
  title: string;
  blurb: string;
  /** Permission gate. Card is hidden if the user lacks this permission. */
  requires: string;
  /** Section the card belongs to in the page layout. */
  section: "Workspace" | "Operations" | "Channels" | "Data";
  /** When true, render as an external link (opens new tab). Used for the
   *  Auth0 dashboard card. */
  external?: boolean;
}

const ALL_CARDS: SettingsCard[] = [
  // Workspace — who has access, who they belong to. User + role management
  // lives in Auth0 now; this card just hands the operator off to the
  // dashboard. The legacy /admin/users and /admin/groups routes were
  // deleted; their permissions (users.manage, groups.manage) are still
  // honored as the gate so non-admins don't see this card.
  { section: "Workspace",
    href: "https://manage.auth0.com",
    external: true,
    icon: "users",
    title: "Users & roles (Auth0)",
    blurb: "Manage users, groups, and permissions in the Auth0 dashboard.",
    requires: "users.manage" },
  { section: "Workspace",
    href: "/admin/advisors",
    icon: "users",
    title: "Advisors",
    blurb: "Add / edit / deactivate advisors that leads get assigned to.",
    requires: "users.manage" },

  // Operations — academic structure
  { section: "Operations", href: "/admin/stacks",   icon: "chart", title: "Stacks",
    blurb: "Top-level buckets programs belong to.",
    requires: "admin.programs.manage" },
  { section: "Operations", href: "/admin/programs", icon: "doc", title: "Programs",
    blurb: "Programs, with stack, price, duration, and linked courses.",
    requires: "admin.programs.manage" },
  { section: "Operations", href: "/admin/courses",  icon: "graduation-cap", title: "Courses",
    blurb: "Reusable course modules linked to programs.",
    requires: "admin.courses.manage" },

  // Channels — third-party integrations
  { section: "Channels", href: "/admin/integrations/slack",    icon: "globe",          title: "Slack",
    blurb: "Automated rules + manual share targets.",
    requires: "integrations.read" },
  { section: "Channels", href: "/admin/integrations/interakt", icon: "chat",           title: "Interakt (WhatsApp)",
    blurb: "Sync lead details to Interakt WhatsApp contacts. Configure the Secret Key + sync from lead records.",
    requires: "integrations.read" },
  { section: "Channels", href: "/admin/media",                 icon: "doc",            title: "Media library",
    blurb: "Shared brochures, invoices, and other files reusable across Twilio sends.",
    requires: "media.read" },
  { section: "Channels", href: "/admin/message-templates",     icon: "message-square", title: "Saved messages",
    blurb: "Reusable canned replies — pick them from the inbox composer to insert and edit before sending.",
    requires: "messaging.read" },
  { section: "Channels", href: "/campaigns",                   icon: "send",           title: "Campaigns",
    blurb: "Bulk WhatsApp template sends with audience filters and per-recipient delivery tracking.",
    requires: "messaging.send" },
  { section: "Channels", href: "/templates",                   icon: "doc",            title: "WhatsApp templates",
    blurb: "Draft new templates, submit for Meta approval, and sync approved ones from Twilio.",
    requires: "messaging.send" },
  { section: "Channels", href: "/campaigns/triggers",          icon: "spark",          title: "Auto-send triggers",
    blurb: "Auto-fire an approved template when a lead's stage or rating changes, or on lead creation.",
    requires: "messaging.send" },

  // Data — destructive / archival
  { section: "Data", href: "/admin/leads/deleted", icon: "inbox", title: "Deleted leads",
    blurb: "Restore or permanently purge soft-deleted leads.",
    requires: "leads.delete" },
];

const SECTION_ORDER: SettingsCard["section"][] = ["Workspace", "Operations", "Channels", "Data"];

export default async function SettingsPage() {
  const me = await getCurrentUser();
  const perms = new Set(me?.permissions ?? []);
  const visible = ALL_CARDS.filter((c) => perms.has(c.requires));

  // Group by section for rendering, preserving SECTION_ORDER.
  const grouped = SECTION_ORDER.map((s) => ({
    section: s,
    cards: visible.filter((c) => c.section === s),
  })).filter((g) => g.cards.length > 0);

  return (
    <>
      <Topbar
        crumb={<b className="font-semibold text-ink">Settings</b>}
        status={me?.role === "admin" ? "Admin" : me ? "Limited" : undefined}
      />
      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px]">
          <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Settings</h1>
          <p className="mt-2 max-w-[720px] text-[13.5px] text-mute">
            Workspace administration, operational data, and channel integrations.
            Only sections you have permission for are listed.
          </p>
        </div>

        {visible.length === 0 ? (
          <div className="rounded-[16px] border border-dashed border-rule bg-warm/30 px-6 py-16 text-center">
            <h3 className="font-serif text-[22px] text-ink">No accessible sections</h3>
            <p className="mt-2 text-[13.5px] text-mute">
              You don&apos;t have permission for any settings section. Ask an administrator to grant access.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {grouped.map((g) => (
              <section key={g.section}>
                <h2 className="mono-cap mb-3 text-[10.5px] font-semibold tracking-[.14em] text-mute">{g.section}</h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {g.cards.map((c) => {
                    const cardClass = "group relative flex items-start gap-3 rounded-[14px] border border-rule bg-paper p-5 transition hover:border-rule2 hover:bg-warm/30";
                    const body = (
                      <>
                        <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[10px] bg-grad-soft text-brand-violet ring-1 ring-inset ring-rule">
                          <Icon name={c.icon} size={18} strokeWidth={1.7} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[14.5px] font-semibold text-ink">{c.title}</span>
                            <span className="ml-auto text-mute opacity-0 transition group-hover:opacity-100">↗</span>
                          </div>
                          <p className="mt-1 text-[12.5px] leading-snug text-mute">{c.blurb}</p>
                        </div>
                      </>
                    );
                    return c.external ? (
                      <a key={c.href} href={c.href} target="_blank" rel="noreferrer" className={cardClass}>
                        {body}
                      </a>
                    ) : (
                      <Link key={c.href} href={c.href} className={cardClass}>
                        {body}
                      </Link>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
