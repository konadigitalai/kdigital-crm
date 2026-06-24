"use client";

// Labeled sidebar — the 280px column to the right of the IconRail. Reads
// from the shared navItems registry so it always agrees with the rail.

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { logout } from "@/lib/api";
import type { CurrentUser, RecentRun, SummaryResponse } from "@/lib/types";
import { buildNavItems, filterNavItems, isActive } from "./navItems";

type SideTabKey = "chat" | "agents" | "build";

export function Sidebar({
  recentRuns,
  currentUser,
  summary,
  onCollapse,
}: {
  recentRuns: RecentRun[];
  currentUser: CurrentUser | null;
  summary: SummaryResponse;
  /** Optional — if provided, the sidebar shows a chevron-left button in its
   *  top-right that calls this to hide the sidebar. */
  onCollapse?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const navItems = filterNavItems(buildNavItems(summary), currentUser);
  const [activeTab, setActiveTab] = useState<SideTabKey>("agents");

  async function onSignOut() {
    try {
      await logout();
    } catch {
      /* ignore — even if the request fails, the cookie is gone */
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <aside className="hidden h-screen flex-col overflow-hidden border-r border-rule bg-warm p-[16px_14px] lg:flex">
      {/* Pinned: tab strip + new task. The tab strip shares its row with the
          collapse button, which sits at the far right. */}
      <div className="mb-[18px] flex flex-shrink-0 items-center gap-2">
        <div className="flex flex-1 gap-[3px] rounded-[12px] border border-rule bg-warm2 p-1">
          <SideTab icon="chat"        label="Chat"   on={activeTab === "chat"}   onClick={() => setActiveTab("chat")} />
          <SideTab icon="agents-grid" label="Agents" on={activeTab === "agents"} onClick={() => setActiveTab("agents")} />
          <SideTab icon="build"       label="Build"  on={activeTab === "build"}  onClick={() => setActiveTab("build")} />
        </div>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md border border-rule bg-warm2 text-mute transition hover:border-rule2 hover:bg-paper hover:text-ink"
          >
            <ChevronGlyph dir="left" />
          </button>
        )}
      </div>

      {activeTab === "chat" && <SideTabPlaceholder kind="chat" />}
      {activeTab === "build" && <SideTabPlaceholder kind="build" />}

      {activeTab === "agents" && <>
      {/* Scrollable middle: nav + recent runs share one scroll region so the
          full nav is reachable when there are many entries. */}
      <div className="-mx-[14px] flex flex-1 flex-col overflow-y-auto px-[14px]">
        <nav className="mb-[18px] flex flex-col gap-px">
          {navItems.map((it) => {
            const active = isActive(pathname, it.href);
            return (
              <Link
                key={it.href}
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
        <div className="flex flex-col gap-px">
          {recentRuns.map((r, i) => {
            const href = r.agentKey ? `/agents/${r.agentKey}` : null;
            const body = (
              <>
                <span
                  className={cn(
                    "h-[7px] w-[7px] flex-shrink-0 rounded-full",
                    r.status === "run"  && "bg-brand-blue shadow-[0_0_8px_rgba(31,63,207,.5)]",
                    r.status === "done" && "bg-state-ok",
                    r.status === "wait" && "border-[1.5px] border-hint",
                  )}
                />
                <span className="truncate">{r.label}</span>
              </>
            );
            const cls = "flex items-center gap-[11px] rounded-[9px] px-[14px] py-2 text-[13px] font-medium leading-tight text-ink2 hover:bg-warm2";
            return href ? (
              <Link key={r.id ?? `${r.label}#${i}`} href={href} className={cls}>
                {body}
              </Link>
            ) : (
              <div key={r.id ?? `${r.label}#${i}`} className={cls}>
                {body}
              </div>
            );
          })}
        </div>
      </div>
      </>}

      {/* Pinned footer: app switcher + signed-in user */}
      <div className="mt-3 flex-shrink-0 border-t border-rule pt-3.5">
        <div className="mb-3 flex items-center gap-3 rounded-[12px] border border-rule bg-warm2 p-3">
          <div className="grid h-[34px] w-[34px] flex-shrink-0 place-items-center rounded-[9px] bg-grad text-white">
            <span className="font-serif text-[18px] font-semibold leading-none">E</span>
          </div>
          <div className="flex-1">
            <div className="text-[13px] font-bold tracking-tight">Edify Agent OS</div>
          </div>
        </div>
        <div className="flex items-center gap-2.5 px-1.5 py-1">
          <div className="grid h-[30px] w-[30px] place-items-center rounded-full bg-ink text-[12px] font-bold text-white">
            {currentUser?.initials ?? "?"}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-semibold">{currentUser?.name ?? "—"}</div>
            {currentUser && (
              <div className="truncate text-[11px] capitalize text-mute">{currentUser.role}</div>
            )}
          </div>
          <button
            onClick={onSignOut}
            className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
          >
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}

function SideTab({
  icon,
  label,
  on,
  onClick,
}: {
  icon: IconName;
  label: string;
  on?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={!!on}
      className={cn(
        "flex flex-1 items-center justify-center gap-[7px] rounded-lg px-[6px] py-2 text-[12.5px] font-semibold transition",
        on
          ? "bg-paper text-ink shadow-[0_1px_3px_rgba(14,10,20,.08)]"
          : "bg-transparent text-mute hover:text-ink",
      )}
    >
      <Icon name={icon} size={14} strokeWidth={1.8} />
      {label}
    </button>
  );
}

function SideTabPlaceholder({ kind }: { kind: "chat" | "build" }) {
  const copy =
    kind === "chat"
      ? {
          icon: "chat" as IconName,
          title: "Chat",
          body: "Conversations with your agents will live here. Coming soon.",
        }
      : {
          icon: "build" as IconName,
          title: "Build",
          body: "Compose new agents and tools from this panel. Coming soon.",
        };
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-10 text-center">
      <div className="grid h-10 w-10 place-items-center rounded-[11px] border border-rule bg-warm2 text-mute">
        <Icon name={copy.icon} size={18} strokeWidth={1.8} />
      </div>
      <div className="text-[14px] font-semibold text-ink">{copy.title}</div>
      <div className="max-w-[220px] text-[12.5px] leading-snug text-mute">{copy.body}</div>
    </div>
  );
}

// Claude-style sidebar-panel-toggle glyph. See IconRail.tsx for rationale.
function ChevronGlyph({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      aria-hidden
    >
      <rect x="1.5" y="3.25" width="13" height="9.5" rx="1.25" stroke="currentColor" strokeWidth="1.5" />
      {dir === "right" ? (
        <rect x="1.5" y="3.25" width="3.75" height="9.5" rx="1.25" fill="currentColor" />
      ) : (
        <rect x="10.75" y="3.25" width="3.75" height="9.5" rx="1.25" fill="currentColor" />
      )}
    </svg>
  );
}
