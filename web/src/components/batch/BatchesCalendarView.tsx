"use client";

// Batches > Calendar. A month grid of batch sessions, mirroring
// LearnersCalendarView's layout. The event source is the persisted
// `getBoardSessions(from, to)` feed (materialized batch_session rows), so the
// calendar reflects the same sessions the detail page manages. The fetch is
// isolated in one function (`fetchSessions`) so the source stays easy to swap.
// Sessions are scoped to the batches the board is currently showing, so the
// board filter carries through. Clicking a session opens BatchSessionPopover.

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { getBoardSessions } from "@/lib/api";
import type { BatchBoardRow, BatchBoardSession, BatchSession, BatchSessionStatus } from "@/lib/types";
import { BatchSessionPopover } from "@/components/calendar/BatchSessionPopover";

const IST = "Asia/Kolkata";
const istDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" });
const monthTitleFmt = new Intl.DateTimeFormat("en-IN", { timeZone: IST, month: "long", year: "numeric" });
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_CHIPS = 3;

// Pill colour by session status: planned reads as brand/neutral, delivered as
// done (green), cancelled as struck-through and dim.
const PILL_CLS: Record<BatchSessionStatus, string> = {
  planned:   "bg-[rgba(31,63,207,.10)]  text-brand-blue",
  delivered: "bg-[rgba(46,158,106,.12)] text-state-ok",
  cancelled: "bg-warm2                  text-hint line-through",
};

function todayIST(): string { return istDayFmt.format(new Date()); }
function isoToUTCNoon(iso: string): Date { return new Date(`${iso}T12:00:00Z`); }
function utcNoonToISO(d: Date): string { return d.toISOString().slice(0, 10); }
function addMonthsISO(iso: string, n: number): string {
  const d = isoToUTCNoon(iso);
  return utcNoonToISO(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, 12)));
}
function monthGrid(anchorISO: string): string[] {
  const anchor = isoToUTCNoon(anchorISO);
  const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1, 12));
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - first.getUTCDay());
  return Array.from({ length: 42 }, (_, i) =>
    utcNoonToISO(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + i, 12))),
  );
}
function firstWord(title: string): string { return title.trim().split(/\s+/)[0] || "Batch"; }

// Pin a session's date + "HH:MM" to an IST instant so the popover renders the
// right day/time regardless of the runtime's zone.
function istISO(sessionDate: string, time: string | null): string {
  return new Date(`${sessionDate}T${time ?? "00:00"}:00+05:30`).toISOString();
}

type CalEvent = {
  id: string;
  day: string;                 // sessionDate (already an IST day)
  time: string | null;         // "HH:MM"
  status: BatchSessionStatus;
  recordingMissing: boolean;   // delivered but no recording published yet
  title: string;
  session: BatchSession;       // constructed for the popover
};

function toEvent(s: BatchBoardSession, seq: number): CalEvent {
  const startAt = istISO(s.sessionDate, s.startTime);
  const endAt = istISO(s.sessionDate, s.endTime ?? s.startTime);
  return {
    id: `${s.id}-${seq}`,
    day: s.sessionDate,
    time: s.startTime,
    status: s.status,
    recordingMissing: s.status === "delivered" && !s.recordingPublishedAt,
    title: s.title,
    session: {
      cohortId: s.cohortId,
      title: s.title,
      courseName: s.courseName,
      startAt,
      endAt,
      isTrainer: false,
      isCoTrainer: false,
      trainerName: s.trainerName,
      coTrainerName: s.coTrainerName,
      location: s.courseName,
    },
  };
}

export function BatchesCalendarView({ rows }: { rows: BatchBoardRow[] }) {
  const [anchor, setAnchor] = useState<string>(todayIST);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sessions, setSessions] = useState<BatchBoardSession[]>([]);
  const [selected, setSelected] = useState<BatchSession | null>(null);

  const today = todayIST();
  const days = useMemo(() => monthGrid(anchor), [anchor]);
  const anchorMonth = isoToUTCNoon(anchor).getUTCMonth();

  // Cohort ids the board is currently showing — sessions outside this set are
  // filtered out so the calendar honours the board's active filter.
  const visibleIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);

  // Isolated fetch: pull persisted sessions for the visible month range.
  useEffect(() => {
    let cancelled = false;
    async function fetchSessions() {
      const from = days[0]!;
      const to = days[days.length - 1]!;
      try {
        const fresh = await getBoardSessions(from, to);
        if (!cancelled) setSessions(fresh);
      } catch {
        if (!cancelled) setSessions([]);
      }
    }
    fetchSessions();
    return () => { cancelled = true; };
  }, [days]);

  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    let seq = 0;
    for (const s of sessions) {
      if (!visibleIds.has(s.cohortId)) continue;
      const ev = toEvent(s, seq++);
      const list = m.get(ev.day);
      if (list) list.push(ev); else m.set(ev.day, [ev]);
    }
    for (const list of m.values()) list.sort((a, b) => a.session.startAt.localeCompare(b.session.startAt));
    return m;
  }, [sessions, visibleIds]);

  function step(direction: -1 | 1) { setExpanded(new Set()); setAnchor(addMonthsISO(anchor, direction)); }
  function goToday() { setExpanded(new Set()); setAnchor(todayIST()); }
  function toggleExpanded(iso: string) {
    setExpanded((prev) => { const next = new Set(prev); if (next.has(iso)) next.delete(iso); else next.add(iso); return next; });
  }

  return (
    <div className="overflow-hidden rounded-[14px] border border-rule bg-paper">
      <div className="flex flex-wrap items-center gap-3 border-b border-rule px-4 py-3">
        <div className="flex items-center gap-2.5">
          <NavButton label="Previous month" onClick={() => step(-1)}>‹</NavButton>
          <div className="min-w-[104px] text-center text-[15px] font-bold tracking-[-.01em] text-ink">
            {monthTitleFmt.format(isoToUTCNoon(anchor))}
          </div>
          <NavButton label="Next month" onClick={() => step(1)}>›</NavButton>
        </div>
        <div className="mono-cap text-[9.5px] tracking-[.1em] text-hint">Batch sessions · by date</div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={goToday}
          className="rounded-full border border-rule bg-paper px-3.5 py-1.5 text-[12px] font-semibold text-ink2 transition hover:border-rule2 hover:text-ink"
        >
          Today
        </button>
      </div>

      <div className="grid grid-cols-7 border-b border-rule">
        {WEEKDAYS.map((d) => (
          <div key={d} className="mono-cap px-3 py-2 text-[9.5px] tracking-[.1em] text-mute">{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {days.map((iso, i) => {
          const inMonth = isoToUTCNoon(iso).getUTCMonth() === anchorMonth;
          const isToday = iso === today;
          const dayEvents = byDay.get(iso) ?? [];
          const cap = !expanded.has(iso);
          const shown = cap ? dayEvents.slice(0, MAX_CHIPS) : dayEvents;
          const hiddenCount = dayEvents.length - shown.length;
          return (
            <div
              key={iso}
              className={cn(
                "min-h-[88px] border-rule p-2",
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
                  <span className={cn("text-[11.5px] font-medium", inMonth ? "text-mute" : "text-hint")}>
                    {isoToUTCNoon(iso).getUTCDate()}
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-1">
                {shown.map((ev) => (
                  <button
                    key={ev.id}
                    type="button"
                    onClick={() => setSelected(ev.session)}
                    title={`${ev.title}${ev.session.trainerName ? ` · ${ev.session.trainerName}` : ""}`}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded-[6px] px-2 py-[4px] text-left text-[10.5px] font-medium transition hover:brightness-95",
                      PILL_CLS[ev.status],
                    )}
                  >
                    {ev.time && <span className="font-mono text-[9px] opacity-80">{ev.time}</span>}
                    <span className="truncate">{firstWord(ev.title)}</span>
                    {ev.recordingMissing && (
                      <span className="ml-auto h-1.5 w-1.5 flex-shrink-0 rounded-full bg-state-amber" title="Recording not published" />
                    )}
                  </button>
                ))}
                {hiddenCount > 0 && (
                  <button type="button" onClick={() => toggleExpanded(iso)} className="pl-1 text-left text-[9.5px] text-hint transition hover:text-ink">
                    +{hiddenCount} more
                  </button>
                )}
                {!cap && dayEvents.length > MAX_CHIPS && (
                  <button type="button" onClick={() => toggleExpanded(iso)} className="pl-1 text-left text-[9.5px] text-hint transition hover:text-ink">
                    Show less
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {selected && <BatchSessionPopover session={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function NavButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
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
