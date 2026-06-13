"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { logout } from "@/lib/api";
import type { CurrentUser, SummaryResponse } from "@/lib/types";

function buildItems(summary: SummaryResponse): {
  href: string; icon: IconName; label: string; badge?: string; dot?: boolean;
}[] {
  const o = summary.overall;
  return [
    { href: "/", icon: "home", label: "Agent Home" },
    { href: "/leads", icon: "users",
      label: o.pendingApprovals > 0
        ? `Leads · ${o.pendingApprovals} need action`
        : "Leads",
      badge: o.pendingApprovals > 0 ? String(o.pendingApprovals) : undefined },
    { href: "/pipeline", icon: "chart", label: "Pipeline" },
    { href: "/learners", icon: "stamp", label: "Learners" },
    { href: "/timesheet", icon: "clock", label: "Timesheet" },
    { href: "/calendar", icon: "spark", label: "Calendar" },
    { href: "/agents", icon: "spark",
      label: o.liveAgents > 0 ? `Agents · ${o.liveAgents} live` : "Agents",
      dot: o.liveAgents > 0 },
    { href: "/inbox", icon: "inbox", label: "Inbox" },
  ];
}

const second: { href: string; icon: IconName; label: string }[] = [
  { href: "/reports", icon: "bars", label: "Reports" },
  { href: "/admin/programs", icon: "doc", label: "Admin · Programs" },
  { href: "/admin/courses",  icon: "doc", label: "Admin · Courses" },
  { href: "/admin/cohorts",  icon: "build", label: "Admin · Batches" },
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href === "/leads") return pathname.startsWith("/leads") || pathname.startsWith("/records");
  if (href === "/learners") return pathname.startsWith("/learners");
  if (href === "/admin/programs") return pathname === "/admin/programs";
  if (href === "/admin/courses")  return pathname === "/admin/courses";
  if (href === "/admin/cohorts")  return pathname === "/admin/cohorts";
  return pathname.startsWith(href);
}

export function IconRail({ currentUser, summary }: { currentUser: CurrentUser | null; summary: SummaryResponse }) {
  const pathname = usePathname();
  const router = useRouter();
  const items = buildItems(summary);
  const [menuOpen, setMenuOpen] = useState(false);

  async function onSignOut() {
    setMenuOpen(false);
    try {
      await logout();
    } catch {
      /* ignore — even if API rejects, the cookie is gone */
    }
    router.replace("/login");
    router.refresh();
  }
  return (
    <nav className="relative z-[2] flex flex-col items-center gap-1.5 bg-ink py-3.5">
      <Link href="/" className="mb-2.5 flex h-10 w-10 items-center justify-center rounded-xl bg-grad shadow-rail">
        <span className="text-white"><Icon name="stamp" size={20} strokeWidth={1.9} /></span>
      </Link>

      {items.map((it) => {
        const active = isActive(pathname, it.href);
        return (
          <Link
            key={it.label}
            href={it.href}
            className={cn(
              "rail-btn group relative flex h-[42px] w-[42px] items-center justify-center rounded-xl transition",
              active
                ? "bg-white/10 text-white before:absolute before:-left-[14px] before:top-[11px] before:bottom-[11px] before:w-[3px] before:rounded-full before:bg-grad"
                : "text-white/55 hover:bg-white/[.07] hover:text-white",
            )}
          >
            <Icon name={it.icon} size={19} strokeWidth={1.7} />
            {it.badge && (
              <span className="absolute right-[7px] top-[7px] flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-brand-magenta px-1 font-mono text-[8px] font-semibold text-white shadow-[0_0_0_2px_var(--ink)]">
                {it.badge}
              </span>
            )}
            {it.dot && (
              <span className="absolute right-[9px] top-[9px] h-[7px] w-[7px] rounded-full bg-state-ok shadow-[0_0_8px_#2E9E6A,0_0_0_2px_var(--ink)]" />
            )}
            <span className="rail-tip">{it.label}</span>
          </Link>
        );
      })}

      <div className="my-1.5 h-px w-[26px] bg-white/[.12]" />

      {second.map((it) => (
        <Link
          key={it.label}
          href={it.href}
          className="rail-btn group relative flex h-[42px] w-[42px] items-center justify-center rounded-xl text-white/55 transition hover:bg-white/[.07] hover:text-white"
        >
          <Icon name={it.icon} size={19} />
          <span className="rail-tip">{it.label}</span>
        </Link>
      ))}

      <div className="flex-1" />

      <Link
        href="/settings"
        className="rail-btn group relative flex h-[42px] w-[42px] items-center justify-center rounded-xl text-white/55 transition hover:bg-white/[.07] hover:text-white"
      >
        <Icon name="settings" size={19} />
        <span className="rail-tip">Settings</span>
      </Link>

      <div className="relative mt-1">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Account menu"
          aria-expanded={menuOpen}
          title={currentUser ? `${currentUser.name} · sign out` : "Sign out"}
          className="flex h-[38px] w-[38px] items-center justify-center rounded-xl border-[1.5px] border-white/[.18] bg-grad-mute text-[13px] font-bold text-white transition hover:border-white/40"
        >
          {currentUser?.initials ?? "?"}
        </button>
        {menuOpen && (
          <>
            {/* click-away */}
            <button
              type="button"
              aria-label="Close menu"
              className="fixed inset-0 z-[40] cursor-default"
              onClick={() => setMenuOpen(false)}
            />
            <div className="absolute bottom-[44px] left-[44px] z-[50] w-[200px] overflow-hidden rounded-[12px] border border-rule bg-paper shadow-card">
              {currentUser && (
                <div className="border-b border-rule px-3 py-2.5">
                  <div className="truncate text-[13px] font-semibold text-ink">{currentUser.name}</div>
                  <div className="truncate text-[11px] text-mute">{currentUser.email}</div>
                </div>
              )}
              <button
                type="button"
                onClick={onSignOut}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] font-semibold text-ink hover:bg-warm"
              >
                <Icon name="arrow-right" size={14} strokeWidth={2} className="text-mute" />
                Sign out
              </button>
            </div>
          </>
        )}
      </div>
    </nav>
  );
}
