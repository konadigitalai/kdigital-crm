"use client";

// Leads > Calendar. The scheduled work advisors owe their leads — follow-ups,
// demos, campus visits — as a month (Sunday-first) or a single week.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { getLeadTasks } from "@/lib/api";
import type { LeadTask, LeadTaskKind, LeadTaskStatus } from "@/lib/types";
import { taskChipLabel, taskKindStyles } from "@/lib/ui";

// Every date part is resolved in IST, never in the runtime's local zone. This
// view server-renders and then hydrates: the server runs in UTC and the browser
// in IST, so a local-zone grid would put the same task in a different cell on
// each pass. Pinning the zone makes both agree, and the users are all in India.
// Same reasoning as lib/ui.ts — see the note above `istDayStart` there.
const IST = "Asia/Kolkata";

const istDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit",
});
const monthTitleFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST, month: "long", year: "numeric",
});
const dayMonthFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST, day: "numeric", month: "short",
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** How many chips fit in a month cell before we collapse to "+N more". */
const MAX_CHIPS = 3;

export type CalendarScale = "month" | "week";

function todayIST(): string {
  return istDayFmt.format(new Date());
}

function istDayOf(iso: string): string {
  return istDayFmt.format(new Date(iso));
}

// Day arithmetic runs on UTC-noon Dates parsed from the ISO day string, which
// keeps it independent of the runtime zone (noon absorbs any ±12h offset) and
// out of DST's way. getUTCDate/getUTCDay below are therefore safe; the local
// getDate/getMonth/getDay are not, and are never used here.
function isoToUTCNoon(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

function utcNoonToISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysISO(iso: string, n: number): string {
  const d = isoToUTCNoon(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return utcNoonToISO(d);
}

function addMonthsISO(iso: string, n: number): string {
  const d = isoToUTCNoon(iso);
  // Anchor on the 1st before shifting: stepping from Jan 31 by +1 month would
  // otherwise overflow into March.
  return utcNoonToISO(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, 12)));
}

/** 6×7 grid, Sunday-first: 42 days from the Sunday on/before the 1st. */
function monthGrid(anchorISO: string): string[] {
  const anchor = isoToUTCNoon(anchorISO);
  const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1, 12));
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - first.getUTCDay());
  return Array.from({ length: 42 }, (_, i) => utcNoonToISO(
    new Date(Date.UTC(
      start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + i, 12,
    )),
  ));
}

/** The 7 days of the Sunday-first week containing the anchor. */
function weekGrid(anchorISO: string): string[] {
  const d = isoToUTCNoon(anchorISO);
  const sunday = addDaysISO(anchorISO, -d.getUTCDay());
  return Array.from({ length: 7 }, (_, i) => addDaysISO(sunday, i));
}

export function LeadsCalendarView({
  kindFilter,
  assigneeFilter,
  statusFilter,
  scale,
  leadScope,
  leadScopeLabel,
}: {
  kindFilter: LeadTaskKind | "all";
  assigneeFilter: string | "all";
  statusFilter: LeadTaskStatus | "all";
  scale: CalendarScale;
  /** Lead ids the board's active filter / saved-view tab admits, or null for
   *  "no filter — show every lead's tasks". The tab scopes the whole leads
   *  surface, so a calendar that ignored it would contradict the highlighted
   *  tab sitting right above it. */
  leadScope: Set<string> | null;
  /** What that scope is called, for the header note ("FS crm", "Filtered"). */
  leadScopeLabel: string | null;
}) {
  const router = useRouter();
  const [anchor, setAnchor] = useState<string>(todayIST);
  const [tasks, setTasks] = useState<LeadTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const today = todayIST();
  const days = useMemo(
    () => (scale === "month" ? monthGrid(anchor) : weekGrid(anchor)),
    [anchor, scale],
  );
  const from = days[0]!;
  const to = days[days.length - 1]!;

  // The fetch window is the visible grid, not the calendar month — in month
  // scale the leading/trailing cells belong to the neighbouring months and
  // would render empty otherwise.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getLeadTasks({ from, to })
      .then((rows) => {
        if (cancelled) return;
        setTasks(rows);
        setError(null);
      })
      .catch((err: Error) => {
        // Surface the failure instead of leaving an empty grid that reads as
        // "nothing is scheduled" — a silent month is indistinguishable from a
        // dead endpoint, and the advisor would act on the wrong one.
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [from, to]);

  // Filtering is client-side: a month holds a few dozen tasks at most, so a
  // round-trip per filter change buys nothing.
  const byDay = useMemo(() => {
    const m = new Map<string, LeadTask[]>();
    for (const t of tasks) {
      if (leadScope && !leadScope.has(t.leadId)) continue;
      if (kindFilter !== "all" && t.kind !== kindFilter) continue;
      if (statusFilter !== "all" && t.status !== statusFilter) continue;
      if (assigneeFilter !== "all" && t.assigneeId !== assigneeFilter) continue;
      const day = istDayOf(t.dueAt);
      const list = m.get(day);
      if (list) list.push(t);
      else m.set(day, [t]);
    }
    for (const list of m.values()) list.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    return m;
  }, [tasks, kindFilter, statusFilter, assigneeFilter, leadScope]);

  const anchorMonth = isoToUTCNoon(anchor).getUTCMonth();

  function step(direction: -1 | 1) {
    setExpanded(new Set());
    setAnchor(scale === "month" ? addMonthsISO(anchor, direction) : addDaysISO(anchor, direction * 7));
  }

  function goToday() {
    setExpanded(new Set());
    setAnchor(todayIST());
  }

  function toggleExpanded(iso: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      return next;
    });
  }

  const title = scale === "month"
    ? monthTitleFmt.format(isoToUTCNoon(anchor))
    : `${dayMonthFmt.format(isoToUTCNoon(from))} – ${dayMonthFmt.format(isoToUTCNoon(to))}`;

  return (
    <div className="overflow-hidden rounded-[14px] border border-rule bg-paper">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-rule px-4 py-3">
        {/* Title sits between the arrows, so the thing you're stepping through
            is the thing the arrows bracket. */}
        <div className="flex items-center gap-2.5">
          <NavButton label={scale === "month" ? "Previous month" : "Previous week"} onClick={() => step(-1)}>
            ‹
          </NavButton>
          <div className="min-w-[104px] text-center text-[15px] font-bold tracking-[-.01em] text-ink">
            {title}
          </div>
          <NavButton label={scale === "month" ? "Next month" : "Next week"} onClick={() => step(1)}>
            ›
          </NavButton>
        </div>

        <div className="mono-cap text-[9.5px] tracking-[.1em] text-hint">
          Follow-ups · Demos · Campus visits
        </div>

        {/* Without this, a scoped calendar that happens to be empty is
            indistinguishable from "nothing is scheduled this month". */}
        {leadScopeLabel && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-violet/30 bg-brand-violet/10 px-2.5 py-1 text-[11px] font-semibold text-brand-violet">
            Scoped to {leadScopeLabel}
          </span>
        )}

        <div className="flex-1" />

        <button
          type="button"
          onClick={goToday}
          className="rounded-full border border-rule bg-paper px-3.5 py-1.5 text-[12px] font-semibold text-ink2 transition hover:border-rule2 hover:text-ink"
        >
          Today
        </button>
      </div>

      {error && (
        <div className="border-b border-rule bg-state-warn/10 px-4 py-2 text-[12.5px] text-state-warn">
          Couldn’t load the calendar: {error}
        </div>
      )}

      {/* Weekday rail — left-aligned to sit over the day numbers below it. */}
      <div className="grid grid-cols-7 border-b border-rule">
        {WEEKDAYS.map((d) => (
          <div key={d} className="mono-cap px-3 py-2 text-[9.5px] tracking-[.1em] text-mute">
            {d}
          </div>
        ))}
      </div>

      {loading && tasks.length === 0 ? (
        <div className="grid grid-cols-7">
          {days.map((iso, i) => (
            <div
              key={iso}
              className={cn(
                "border-rule p-2",
                scale === "month" ? "min-h-[88px]" : "min-h-[380px]",
                (i + 1) % 7 !== 0 && "border-r",
                i < days.length - 7 && "border-b",
              )}
            >
              <div className="h-3 w-4 animate-pulse rounded bg-warm2" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-7">
          {days.map((iso, i) => {
            const inMonth = scale === "week" || isoToUTCNoon(iso).getUTCMonth() === anchorMonth;
            const isToday = iso === today;
            const dayTasks = byDay.get(iso) ?? [];
            // A week cell is tall enough to hold everything, so the "+N more"
            // collapse only exists in month scale.
            const cap = scale === "month" && !expanded.has(iso);
            const shown = cap ? dayTasks.slice(0, MAX_CHIPS) : dayTasks;
            const hiddenCount = dayTasks.length - shown.length;

            return (
              <div
                key={iso}
                className={cn(
                  "border-rule p-2",
                  scale === "month" ? "min-h-[88px]" : "min-h-[380px]",
                  // The card already draws the outer frame, so the last column
                  // and last row skip their rules — otherwise they double up on
                  // the border and read heavier than the interior grid.
                  (i + 1) % 7 !== 0 && "border-r",
                  i < days.length - 7 && "border-b",
                  isToday && "bg-warm",
                )}
              >
                <div className="mb-1.5 flex h-[22px] items-center">
                  {isToday ? (
                    <span className="grid h-[22px] w-[22px] place-items-center rounded-full bg-brand-violet text-[11px] font-bold text-white">
                      {isoToUTCNoon(iso).getUTCDate()}
                    </span>
                  ) : (
                    <span
                      className={cn(
                        "text-[11.5px] font-medium",
                        // Out-of-month days keep the white cell and just fade
                        // their number — the mock treats them as context, not
                        // as disabled space.
                        inMonth ? "text-mute" : "text-hint",
                      )}
                    >
                      {isoToUTCNoon(iso).getUTCDate()}
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-1">
                  {shown.map((t) => (
                    <TaskChip key={t.id} task={t} onClick={() => router.push(`/records/${t.leadNumber}`)} />
                  ))}

                  {hiddenCount > 0 && (
                    <button
                      type="button"
                      onClick={() => toggleExpanded(iso)}
                      className="pl-1 text-left text-[9.5px] text-hint transition hover:text-ink"
                    >
                      +{hiddenCount} more
                    </button>
                  )}
                  {!cap && scale === "month" && dayTasks.length > MAX_CHIPS && (
                    <button
                      type="button"
                      onClick={() => toggleExpanded(iso)}
                      className="pl-1 text-left text-[9.5px] text-hint transition hover:text-ink"
                    >
                      Show less
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NavButton({
  label, onClick, children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-[8px] border border-rule bg-paper text-[13px] font-semibold text-ink2 transition hover:border-rule2 hover:text-ink"
    >
      {children}
    </button>
  );
}

function TaskChip({ task, onClick }: { task: LeadTask; onClick: () => void }) {
  const style = taskKindStyles[task.kind];
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${task.title}${task.assigneeName ? ` · ${task.assigneeName}` : ""}`}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-[6px] px-2 py-[4px] text-left text-[10.5px] font-medium transition hover:brightness-95",
        style.bg,
        style.text,
        task.status === "done" && "line-through opacity-60",
      )}
    >
      <span className={cn("h-1.5 w-1.5 flex-shrink-0 rounded-full", style.dot)} />
      <span className="truncate">{taskChipLabel(task)}</span>
    </button>
  );
}
