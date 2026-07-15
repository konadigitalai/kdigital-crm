"use client";

// Client wrapper that owns the "sidebar collapsed" state. AppShell stays a
// server component (loads currentUser / summary / recentRuns server-side);
// this thin client layer holds the toggle and reshapes the grid template.
//
// State persists in localStorage so collapsing the sidebar sticks across
// navigations and reloads.

import { useEffect, useState } from "react";
import { IconRail } from "./IconRail";
import { Sidebar } from "./Sidebar";
import { NotificationProvider } from "./NotificationProvider";
import type { CurrentUser, RecentRun, SummaryResponse } from "@/lib/types";

const STORAGE_KEY = "decrm_sidebar_collapsed";

function loadCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveCollapsed(v: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
  } catch {
    /* private mode — silently ignore */
  }
}

export function AppShellClient({
  recentRuns,
  currentUser,
  summary,
  children,
}: {
  recentRuns: RecentRun[];
  currentUser: CurrentUser | null;
  summary: SummaryResponse;
  children: React.ReactNode;
}) {
  // Gates the notification poller — no point polling inbound events for a user
  // who can't open the inbox anyway.
  const canSeeInbox = currentUser?.permissions.includes("messaging.read") ?? false;

  // Start uncollapsed on first paint so SSR + client first render match.
  // The real preference loads on mount; the swap is invisible because there's
  // no animated layout shift — just a width change applied via Tailwind class.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(loadCollapsed());
  }, []);

  function toggle() {
    setCollapsed((v) => {
      const next = !v;
      saveCollapsed(next);
      return next;
    });
  }

  // Two layout modes:
  //   collapsed → IconRail (66px) only, Sidebar hidden
  //   expanded  → Sidebar (280px) only, IconRail hidden
  // We never show both at once — that's the design call. (Originally we
  // showed both, then collapsed only the Sidebar; now we keep just one
  // panel visible at a time so the chrome stays minimal.)
  return (
    <div
      className="relative z-[1] grid h-screen"
      style={{
        gridTemplateColumns: collapsed ? "66px 0px 1fr" : "0px 280px 1fr",
        // Constrain the single grid row to exactly the viewport height.
        // Without this, a long `<main>` would push grid row height to its
        // content size — the `overflow-y-auto` on <main> never kicks in
        // because the column has no max height to overflow against.
        gridTemplateRows: "100vh",
        transition: "grid-template-columns 200ms ease",
      }}
    >
      {/* Rail's parent column shrinks to 0 when Sidebar is open. We also
          conditionally render so it stops being interactive (no stray
          tooltips, no tab-stops) when hidden. */}
      <div className="overflow-hidden">
        {collapsed && (
          <IconRail
            currentUser={currentUser}
            summary={summary}
            sidebarCollapsed={collapsed}
            onExpandSidebar={() => setCollapsed(false)}
          />
        )}
      </div>
      {/* The sidebar's parent column collapses to 0 width; the aside itself
          adds overflow-hidden so contents don't spill out mid-animation. */}
      <div className="overflow-hidden">
        {!collapsed && (
          <Sidebar
            recentRuns={recentRuns}
            currentUser={currentUser}
            summary={summary}
            onCollapse={toggle}
          />
        )}
      </div>
      {/* Provider wraps the page content so the bell (rendered inside each
          page's Topbar) can read the shared count. It lives here, not per-page,
          so the count survives client-side navigation between pages. */}
      <main className="relative min-h-0 overflow-y-auto">
        <NotificationProvider enabled={canSeeInbox}>{children}</NotificationProvider>
      </main>
    </div>
  );
}
