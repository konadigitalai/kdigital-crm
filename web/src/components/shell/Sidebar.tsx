"use client";

// Labeled sidebar — the 280px column to the right of the IconRail. Reads
// from the shared navItems registry so it always agrees with the rail.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import type { CurrentUser, RecentRun, SummaryResponse } from "@/lib/types";
import { useLiveSummary } from "@/lib/live-summary";
import { buildNavItems, filterNavItems, isActive } from "./navItems";

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
  // Server-fetched summary is the initial value; useLiveSummary swaps it for
  // fresh data on every mutation event and route change.
  const liveSummary = useLiveSummary(summary);
  const navItems = filterNavItems(buildNavItems(liveSummary), currentUser);

  function onSignOut() {
    // Full-page nav: /auth/logout is auto-mounted by the Auth0 SDK
    // middleware and handles cookie wipe + Auth0 server-side logout.
    window.location.href = "/auth/logout";
  }

  return (
    <aside className="hidden h-screen flex-col overflow-hidden border-r border-rule bg-warm p-[16px_14px] lg:flex">
      {/* Pinned top — slim brand row. Just the wordmark + collapse button,
          no heavy pill outline. The Chat / Agents / Build tab strip is
          parked for now and the bottom-of-sidebar brand block is gone;
          this single line is the only branding inside the panel. */}
      <div className="mb-3 flex flex-shrink-0 items-center justify-between gap-2 px-[6px]">
        {/* Claude-style minimal wordmark — no border, no pill. Just the
            product name in the serif display face. The whole word is the
            link target so clicking it returns to Agent Home. */}
        <Link
          href="/"
          aria-label="Agent Home"
          className="group flex min-w-0 flex-1 items-baseline gap-1.5 px-1"
        >
          <span className="font-serif text-[22px] font-normal leading-none tracking-[-.01em] text-ink transition group-hover:text-brand-violet">
            Kona
          </span>
          <span className="truncate font-serif text-[15px] font-normal italic leading-none text-mute">
            Agentic&nbsp;OS
          </span>
        </Link>
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

      {/* Pinned footer: signed-in user. The old "Edify Agent OS" app-switcher
          card was dropped — branding lives in the top row now and the card
          itself wasn't clickable anyway. */}
      <div className="mt-3 flex-shrink-0 border-t border-rule pt-3.5">
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
