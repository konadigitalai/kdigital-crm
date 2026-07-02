"use client";

// IconRail — the compact dark column on the far left. Same nav items as the
// Sidebar, just rendered as icons with hover tooltips. Reads from the shared
// `navItems.ts` registry so the two panels can't drift.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import type { CurrentUser, SummaryResponse } from "@/lib/types";
import { useLiveSummary } from "@/lib/live-summary";
import { buildNavItems, filterNavItems, isActive } from "./navItems";

export function IconRail({
  currentUser,
  summary,
  sidebarCollapsed,
  onExpandSidebar,
}: {
  currentUser: CurrentUser | null;
  summary: SummaryResponse;
  /** When true, show the "expand sidebar" button at the top of the rail. */
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
}) {
  const pathname = usePathname();
  // Server-fetched summary is the initial value; useLiveSummary swaps it for
  // fresh data on every mutation event and route change.
  const liveSummary = useLiveSummary(summary);
  const items = filterNavItems(buildNavItems(liveSummary), currentUser);
  const [menuOpen, setMenuOpen] = useState(false);

  function onSignOut() {
    setMenuOpen(false);
    // Full-page nav: /auth/logout is auto-mounted by the Auth0 SDK
    // middleware and handles cookie wipe + Auth0 server-side logout.
    window.location.href = "/auth/logout";
  }

  return (
    <nav className="relative z-[2] flex h-full flex-col items-center bg-ink py-3.5">
      {/* Pinned top: only the expand-sidebar button. The gradient brand
          mark was dropped — the dark rail looks cleaner without it, and
          the labeled sidebar (when open) already has the Edify wordmark
          at the top. */}
      <div className="flex flex-shrink-0 flex-col items-center gap-1.5">
        {sidebarCollapsed && onExpandSidebar && (
          <RailTooltip label="Expand sidebar">
            <button
              type="button"
              onClick={onExpandSidebar}
              aria-label="Expand sidebar"
              className="flex h-[34px] w-[34px] items-center justify-center rounded-lg text-white/55 transition hover:bg-white/[.07] hover:text-white"
            >
              <ChevronGlyph dir="right" />
            </button>
          </RailTooltip>
        )}
      </div>

      {/* Scrollable middle: nav items. Scrollbar is hidden because it would
          eat ~17px of a 66px-wide rail on Windows. Users still get wheel /
          touch scrolling; overflow on small screens just works.
          Tooltips are rendered via portal so the overflow:auto here doesn't
          clip them — they appear over the main content, beside the icon. */}
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 self-stretch overflow-y-auto py-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((it) => {
          const active = isActive(pathname, it.href);
          return (
            <RailTooltip key={it.href} label={it.label}>
              <Link
                href={it.href}
                className={cn(
                  "relative flex h-[42px] w-[42px] flex-shrink-0 items-center justify-center rounded-xl transition",
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
              </Link>
            </RailTooltip>
          );
        })}
      </div>

      {/* Pinned bottom: account avatar. (Settings is rendered above as part
          of the shared nav registry; we used to have a hardcoded copy here
          which produced a duplicate gear icon.) */}
      <div className="flex flex-shrink-0 flex-col items-center gap-1.5">
        <AccountMenu currentUser={currentUser} onSignOut={onSignOut} open={menuOpen} setOpen={setMenuOpen} />
      </div>
    </nav>
  );
}

// Account avatar + dropdown.
//
// The dropdown HAS to be portaled — IconRail lives in a grid column whose
// parent has `overflow-hidden` (66px wide), so an absolutely-positioned
// child trying to render past the rail gets clipped. Same trick as
// `RailTooltip` below: read the button's bounding rect at click time and
// render the menu via createPortal at fixed coordinates.
function AccountMenu({
  currentUser,
  onSignOut,
  open,
  setOpen,
}: {
  currentUser: CurrentUser | null;
  onSignOut: () => void;
  open: boolean;
  setOpen: (next: boolean | ((v: boolean) => boolean)) => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const el = btnRef.current;
    if (!el) {
      setOpen(true);
      return;
    }
    const r = el.getBoundingClientRect();
    // Place the menu's bottom-left corner ~8px above the avatar's top, and
    // shifted right past the rail. Coordinates are viewport-fixed so the
    // dropdown isn't subject to any ancestor's overflow:hidden.
    setPos({ top: r.top - 8, left: r.right + 6 });
    setOpen(true);
  }

  return (
    <div className="relative mt-1">
      <RailTooltip label={currentUser ? `${currentUser.name} · ${currentUser.email}` : "Account"}>
        <button
          ref={btnRef}
          type="button"
          onClick={toggle}
          aria-label="Account menu"
          aria-expanded={open}
          className="flex h-[38px] w-[38px] items-center justify-center rounded-xl border-[1.5px] border-white/[.18] bg-grad-mute text-[13px] font-bold text-white transition hover:border-white/40"
        >
          {currentUser?.initials ?? "?"}
        </button>
      </RailTooltip>
      {open && typeof document !== "undefined" && pos && createPortal(
        <>
          {/* Click-outside backdrop. Fixed-fill captures every click and
              closes the menu so we don't need outside-click listeners. */}
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 z-[60] cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            // Menu's BOTTOM edge is anchored to `top: pos.top`, so it
            // opens upward, sitting just above the avatar.
            style={{ top: pos.top, left: pos.left, transform: "translateY(-100%)" }}
            className="fixed z-[70] w-[220px] overflow-hidden rounded-[12px] border border-rule bg-paper shadow-card"
          >
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
        </>,
        document.body,
      )}
    </div>
  );
}

// Wraps a rail button and shows a label tooltip beside it on hover/focus.
//
// Implementation notes — why a portal + fixed position:
//   The scrollable middle of the rail uses `overflow-y: auto`. Once a parent
//   has overflow:auto on either axis, the other axis becomes implicit `auto`
//   too, which clips absolutely-positioned children that extend outside the
//   container. A 200-px-wide tooltip anchored at `left: 54px` would be cut
//   off mid-letter. Rendering via a portal moves the tooltip out of that
//   container and onto document.body; positioning with `fixed` reads the
//   anchor button's bounding rect at hover time so the tooltip appears
//   right beside the icon regardless of scroll offset.
function RailTooltip({ label, children }: { label: string; children: ReactNode }) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [tipPos, setTipPos] = useState<{ top: number; left: number } | null>(null);

  function show() {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setTipPos({ top: r.top + r.height / 2, left: r.right + 10 });
  }
  function hide() {
    setTipPos(null);
  }

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {tipPos && typeof document !== "undefined" && createPortal(
        <span
          role="tooltip"
          style={{ top: tipPos.top, left: tipPos.left }}
          className="pointer-events-none fixed z-[60] -translate-y-1/2 whitespace-nowrap rounded-lg border border-white/15 bg-ink px-3 py-1.5 text-[12px] font-semibold text-white shadow-[0_8px_22px_rgba(0,0,0,0.4)]"
        >
          {label}
        </span>,
        document.body,
      )}
    </span>
  );
}

// Claude-style sidebar-panel-toggle glyph. Crisp rectangle outline with a
// solid filled bar on one side representing the sidebar.
//
//   dir="right"  rail → sidebar (expand): filled bar on the LEFT
//   dir="left"   sidebar → rail (collapse): filled bar on the RIGHT
//
// Sharp 1px-rounded corners, ~1.5 stroke, fill on the active side. Matches
// Claude/VSCode panel-toggle iconography.
function ChevronGlyph({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      aria-hidden
    >
      {/* Outer rounded rectangle */}
      <rect
        x="1.5" y="3.25"
        width="13" height="9.5"
        rx="1.25"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {/* Filled side panel */}
      {dir === "right" ? (
        <rect x="1.5" y="3.25" width="3.75" height="9.5" rx="1.25" fill="currentColor" />
      ) : (
        <rect x="10.75" y="3.25" width="3.75" height="9.5" rx="1.25" fill="currentColor" />
      )}
    </svg>
  );
}
