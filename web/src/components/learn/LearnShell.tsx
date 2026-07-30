"use client";

// The learner portal chrome. Deliberately NOT the CRM's AppShell: that shell
// fetches /agents/recent and /summary on every render, which a learner has no
// permission for — it would 403 the whole page before anything rendered.
//
// The admin switch in the top right appears only for lms.content.manage. A
// learner never sees it; a staff member gets a one-click hop into authoring.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import type { LmsMe } from "@/lib/types";

const NAV = [
  { href: "/learn", label: "Today", exact: true },
  { href: "/learn/batches", label: "My learning" },
  { href: "/learn/schedule", label: "Schedule" },
  { href: "/learn/work", label: "My work" },
  { href: "/learn/help", label: "Help" },
];

function initials(name: string | null, email: string | null): string {
  const src = (name ?? email ?? "?").trim();
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function LearnShell({
  me, canAdmin, badges, children,
}: {
  me: LmsMe | null;
  canAdmin: boolean;
  badges?: { learning?: number; work?: number };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isActive = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(href + "/");

  const badgeFor = (href: string) =>
    href === "/learn/batches" ? badges?.learning
    : href === "/learn/work" ? badges?.work
    : undefined;

  // globals.css pins `html, body { height: 100vh; overflow: hidden }` because
  // the CRM shell scrolls inside its own panes. The portal is an ordinary
  // document-flow page, so under that rule it was simply clipped at the
  // viewport with no way to reach anything below the fold — you could see the
  // "+ Resource" button and never scroll to the form it opened.
  //
  // Own the scrolling here rather than changing the global rule, which the
  // whole CRM depends on. The header stays sticky because it lives inside
  // this scroll container.
  return (
    <div className="h-screen overflow-y-auto bg-[#f7f5f0]">
      <header className="sticky top-0 z-30 border-b border-black/5 bg-[#fdfcfa]/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5">
          <Link href="/learn" className="flex shrink-0 items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-ink text-sm font-semibold text-white">
              K
            </span>
            <span className="text-lg font-semibold tracking-tight">KDigital</span>
            <span className="font-serif text-lg text-ink/50">Academy</span>
          </Link>

          <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
            {NAV.map((n) => {
              const active = isActive(n.href, n.exact);
              const badge = badgeFor(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm transition",
                    active ? "bg-indigo-100 font-medium text-indigo-900" : "text-ink/70 hover:bg-black/5",
                  )}
                >
                  {n.label}
                  {badge ? (
                    <span className="rounded-full bg-amber-200/80 px-1.5 text-[11px] font-medium text-amber-900">
                      {badge}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </nav>

          <div className="flex shrink-0 items-center gap-3">
            {canAdmin ? (
              <Link
                href="/learn/admin"
                title="Switch to admin"
                aria-label="Switch to admin"
                className={cn(
                  "grid h-9 w-9 place-items-center rounded-full border border-black/10 transition",
                  pathname.startsWith("/learn/admin")
                    ? "bg-ink text-white"
                    : "bg-white text-ink/70 hover:bg-black/5",
                )}
              >
                {/* sliders icon — inline so the portal doesn't pull the CRM icon set */}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
                </svg>
              </Link>
            ) : null}
            <div className="hidden text-right sm:block">
              <div className="text-sm font-medium leading-tight">{me?.name ?? "Learner"}</div>
              <div className="font-mono text-[11px] uppercase tracking-wide text-ink/45">
                {me?.learnerNumber ?? "—"}
              </div>
            </div>
            <span className="grid h-9 w-9 place-items-center rounded-full bg-indigo-600 text-sm font-semibold text-white">
              {initials(me?.name ?? null, me?.email ?? null)}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
    </div>
  );
}
