"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import type { CurrentUser, RecentRun, SummaryResponse } from "@/lib/types";

function buildNavItems(summary: SummaryResponse): {
  href: string; icon: IconName; label: string; badge?: string; pillBeta?: boolean;
}[] {
  return [
    { href: "/", icon: "home", label: "Agent Home" },
    { href: "/leads", icon: "users", label: "Leads", badge: String(summary.overall.total) },
    { href: "/pipeline", icon: "chart", label: "Pipeline" },
    { href: "/learners", icon: "stamp", label: "Learners" },
    { href: "/scheduled", icon: "clock", label: "Scheduled" },
    { href: "/live-artifacts", icon: "globe", label: "Live artifacts" },
    { href: "/dispatch", icon: "doc", label: "Dispatch", pillBeta: true },
    { href: "/customize", icon: "star", label: "Customize" },
    { href: "/admin/programs", icon: "doc", label: "Admin · Programs" },
    { href: "/admin/courses",  icon: "doc", label: "Admin · Courses" },
    { href: "/admin/cohorts",  icon: "build", label: "Admin · Batches" },
  ];
}

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href === "/leads") return pathname.startsWith("/leads") || pathname.startsWith("/records");
  return pathname.startsWith(href);
}

export function Sidebar({
  recentRuns, currentUser, summary,
}: {
  recentRuns: RecentRun[];
  currentUser: CurrentUser | null;
  summary: SummaryResponse;
}) {
  const pathname = usePathname();
  const navItems = buildNavItems(summary);
  return (
    <aside className="hidden flex-col overflow-hidden border-r border-rule bg-warm p-[16px_14px] lg:flex">
      <div className="mb-[18px] flex gap-[3px] rounded-[12px] border border-rule bg-warm2 p-1">
        <SideTab icon="chat" label="Chat" />
        <SideTab icon="agents-grid" label="Agents" on />
        <SideTab icon="build" label="Build" />
      </div>

      <Link
        href="/"
        className="mb-2 flex w-full items-center gap-3 rounded-[11px] border border-rule bg-warm2 px-[14px] py-[11px] text-sm font-semibold text-ink transition hover:border-rule2 hover:bg-paper"
      >
        <span className="grid h-[18px] w-[18px] place-items-center rounded-md bg-grad text-sm font-medium leading-none text-white">+</span>
        New agent task
      </Link>

      <nav className="mb-[18px] flex flex-col gap-px">
        {navItems.map((it) => {
          const active = isActive(pathname, it.href);
          return (
            <Link
              key={it.label}
              href={it.href}
              className={cn(
                "relative flex w-full items-center gap-3 rounded-[10px] px-[14px] py-[9px] text-sm font-medium text-ink2 transition",
                active
                  ? "bg-warm2 font-semibold text-ink before:absolute before:left-0 before:top-[9px] before:bottom-[9px] before:w-[3px] before:rounded-full before:bg-grad"
                  : "hover:bg-warm2",
              )}
            >
              <Icon name={it.icon} size={16} strokeWidth={1.7} className={cn(active ? "text-brand-violet" : "text-mute")} />
              <span>{it.label}</span>
              {it.badge && (
                <span className="ml-auto rounded-full bg-[rgba(199,25,122,.1)] px-[7px] py-0.5 font-mono text-[9px] font-semibold tracking-[.08em] text-brand-magenta">
                  {it.badge}
                </span>
              )}
              {it.pillBeta && (
                <span className="mono-cap ml-auto rounded-full border border-rule bg-warm2 px-[7px] py-0.5 text-[9px] font-semibold text-mute">
                  Beta
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="mb-2.5 px-[14px] font-mono text-[9.5px] font-semibold uppercase tracking-[.14em] text-hint">
        Recent agent runs
      </div>
      <div className="flex flex-1 flex-col gap-px overflow-y-auto">
        {recentRuns.map((r) => (
          <div
            key={r.label}
            className="flex items-center gap-[11px] rounded-[9px] px-[14px] py-2 text-[13px] font-medium leading-tight text-ink2 hover:bg-warm2"
          >
            <span
              className={cn(
                "h-[7px] w-[7px] flex-shrink-0 rounded-full",
                r.status === "run"  && "bg-brand-blue shadow-[0_0_8px_rgba(31,63,207,.5)]",
                r.status === "done" && "bg-state-ok",
                r.status === "wait" && "border-[1.5px] border-hint",
              )}
            />
            <span className="truncate">{r.label}</span>
          </div>
        ))}
      </div>

      <div className="mt-3 border-t border-rule pt-3.5">
        <div className="mb-3 flex items-center gap-3 rounded-[12px] border border-rule bg-warm2 p-3">
          <div className="grid h-[34px] w-[34px] flex-shrink-0 place-items-center rounded-[9px] bg-grad text-white">
            <Icon name="stamp" size={18} strokeWidth={1.8} />
          </div>
          <div className="flex-1">
            <div className="text-[13px] font-bold tracking-tight">Edify Agent OS</div>
            <div className="font-mono text-[10px] tracking-[.04em] text-mute">v2.6 · MCP connected</div>
          </div>
          <span className="text-mute">→</span>
        </div>
        <div className="flex items-center gap-2.5 px-1.5 py-1">
          <div className="grid h-[30px] w-[30px] place-items-center rounded-full bg-ink text-[12px] font-bold text-white">
            {currentUser?.initials ?? "?"}
          </div>
          <div className="text-[13.5px] font-semibold">{currentUser?.name ?? "—"}</div>
          {currentUser && (
            <span className="text-[13.5px] capitalize text-mute">· {currentUser.role}</span>
          )}
          <span className="ml-auto text-[12px] text-mute">⌄</span>
        </div>
      </div>
    </aside>
  );
}

function SideTab({ icon, label, on }: { icon: IconName; label: string; on?: boolean }) {
  return (
    <button
      className={cn(
        "flex flex-1 items-center justify-center gap-[7px] rounded-lg px-[6px] py-2 text-[12.5px] font-semibold transition",
        on ? "bg-paper text-ink shadow-[0_1px_3px_rgba(14,10,20,.08)]" : "bg-transparent text-mute",
      )}
    >
      <Icon name={icon} size={14} strokeWidth={1.8} />
      {label}
    </button>
  );
}
