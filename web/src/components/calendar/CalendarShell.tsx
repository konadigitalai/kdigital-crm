"use client";

// Outlook-style calendar shell. Owns the active view (day / week / month) and
// the date anchor; re-fetches events / blocks / leaves / batch sessions when
// either changes. Three view bodies live below.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  getBatchSessions,
  getEvents,
  getTimesheetRange,
} from "@/lib/api";
import type {
  BatchSession,
  CalendarEventSummary,
  EventRsvp,
  LeaveDay,
  LeaveKind,
  TimeBlock,
} from "@/lib/types";
import { EventDialog } from "./EventDialog";
import { BatchSessionPopover } from "./BatchSessionPopover";

type View = "day" | "week" | "month";

interface Props {
  meId: string;
  people: { id: string; name: string; email: string; role: string }[];
  initialAnchorISO: string;          // a date in the initial week (today's IST date)
  initialView?: View;
  initialEvents: CalendarEventSummary[];
  initialBlocks: TimeBlock[];
  initialLeaves: LeaveDay[];
  initialSessions: BatchSession[];
  initialFrom: string;                // ISO date corresponding to initial range start
  initialTo: string;
}

const HOUR_START = 7;
const HOUR_END = 22;
const HOURS = Array.from({ length: HOUR_END - HOUR_START + 1 }, (_, i) => HOUR_START + i);
const PX_PER_HOUR = 56;

const LEAVE_LABEL: Record<LeaveKind, string> = {
  sick: "Sick", personal: "Personal", vacation: "Vacation", wfh: "WFH", holiday: "Holiday",
};

const RSVP_TONE: Record<EventRsvp, string> = {
  pending:   "ring-1 ring-state-amber/40 bg-state-amber/10 text-state-amber",
  accepted:  "ring-1 ring-brand-violet/40 bg-brand-violet/10 text-brand-violet",
  declined:  "ring-1 ring-state-warn/40 bg-state-warn/10 text-state-warn line-through opacity-70",
  tentative: "ring-1 ring-state-amber/40 bg-state-amber/15 text-state-amber",
};

// ── IST helpers ────────────────────────────────────────────────────────────
function istNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (5 * 60 + 30) * 60_000);
}
function istDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function todayISTDate(): string {
  return istDateString(istNow());
}
function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekDatesIST(anchorISO: string): string[] {
  const anchor = new Date(`${anchorISO}T12:00:00Z`);
  const dow = anchor.getUTCDay();
  const sinceMon = (dow + 6) % 7;
  const monday = new Date(anchor);
  monday.setUTCDate(monday.getUTCDate() - sinceMon);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + i);
    return istDateString(d);
  });
}
// 6×7 month grid: from the Monday on/before the 1st of the anchor's month, 42 days.
function monthGridIST(anchorISO: string): { dates: string[]; monthStart: string; monthEnd: string } {
  const anchor = new Date(`${anchorISO}T12:00:00Z`);
  const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1, 12));
  const dow = first.getUTCDay();
  const sinceMon = (dow + 6) % 7;
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - sinceMon);
  const dates: string[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    dates.push(istDateString(d));
  }
  const lastOfMonth = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0, 12));
  return {
    dates,
    monthStart: istDateString(first),
    monthEnd: istDateString(lastOfMonth),
  };
}
function istHour(iso: string): number {
  const d = new Date(iso);
  const ist = new Date(d.getTime() + (5 * 60 + 30) * 60_000);
  return ist.getUTCHours() + ist.getUTCMinutes() / 60;
}
function istDate(iso: string): string {
  const d = new Date(iso);
  const ist = new Date(d.getTime() + (5 * 60 + 30) * 60_000);
  return ist.toISOString().slice(0, 10);
}
function fmtHour(h: number): string {
  return `${Math.floor(h).toString().padStart(2, "0")}:00`;
}
function fmtHourMinIST(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata",
  });
}
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const ist = new Date(d.getTime() + (5 * 60 + 30) * 60_000);
  return ist.toISOString().slice(0, 16);
}
function pad(n: number): string { return n.toString().padStart(2, "0"); }

// Compute the [from, to] inclusive range for a given view + anchor.
function rangeFor(view: View, anchorISO: string): { from: string; to: string; dates: string[] } {
  if (view === "day") {
    return { from: anchorISO, to: anchorISO, dates: [anchorISO] };
  }
  if (view === "week") {
    const dates = weekDatesIST(anchorISO);
    return { from: dates[0]!, to: dates[6]!, dates };
  }
  const grid = monthGridIST(anchorISO);
  return { from: grid.dates[0]!, to: grid.dates[grid.dates.length - 1]!, dates: grid.dates };
}

export function CalendarShell({
  meId, people,
  initialAnchorISO, initialView = "week",
  initialEvents, initialBlocks, initialLeaves, initialSessions,
  initialFrom, initialTo,
}: Props) {
  const router = useRouter();
  const [view, setView] = useState<View>(initialView);
  const [anchor, setAnchor] = useState<string>(initialAnchorISO);
  const [events, setEvents] = useState(initialEvents);
  const [blocks, setBlocks] = useState(initialBlocks);
  const [leaves, setLeaves] = useState(initialLeaves);
  const [sessions, setSessions] = useState(initialSessions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState<{ start: string; end: string } | null>(null);
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const [openSession, setOpenSession] = useState<BatchSession | null>(null);

  // Track the range backing the current data so we don't refetch unnecessarily.
  const [loadedRange, setLoadedRange] = useState<{ from: string; to: string }>({ from: initialFrom, to: initialTo });

  // ── fetch effect: re-pull when the visible range changes ────────────────
  useEffect(() => {
    const { from, to } = rangeFor(view, anchor);
    if (from === loadedRange.from && to === loadedRange.to) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    Promise.all([
      getEvents(from, to),
      getTimesheetRange(from, to),
      getBatchSessions(from, to),
    ])
      .then(([ev, tr, sess]) => {
        if (cancelled) return;
        setEvents(ev);
        setBlocks(tr.blocks);
        setLeaves(tr.leaves);
        setSessions(sess);
        setLoadedRange({ from, to });
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [view, anchor, loadedRange]);

  const reload = useCallback(() => {
    // After a write, re-fetch the current range and refresh server data.
    const { from, to } = rangeFor(view, anchor);
    setBusy(true);
    Promise.all([
      getEvents(from, to),
      getTimesheetRange(from, to),
      getBatchSessions(from, to),
    ])
      .then(([ev, tr, sess]) => {
        setEvents(ev);
        setBlocks(tr.blocks);
        setLeaves(tr.leaves);
        setSessions(sess);
        setLoadedRange({ from, to });
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => {
        setBusy(false);
        setCreating(null);
        setOpenEventId(null);
        router.refresh();
      });
  }, [view, anchor, router]);

  function step(direction: -1 | 1) {
    if (view === "day")  setAnchor(addDaysISO(anchor, direction));
    if (view === "week") setAnchor(addDaysISO(anchor, direction * 7));
    if (view === "month") {
      const d = new Date(`${anchor}T12:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + direction);
      setAnchor(istDateString(d));
    }
  }
  function goToday() { setAnchor(todayISTDate()); }

  function newEventAt(date: string, hour: number) {
    const start = new Date(`${date}T${pad(hour)}:00:00+05:30`);
    const end = new Date(start.getTime() + 30 * 60_000);
    setCreating({ start: toLocalInput(start.toISOString()), end: toLocalInput(end.toISOString()) });
  }
  function newEventAtDay(date: string, hour = 9) {
    const start = new Date(`${date}T${pad(hour)}:00:00+05:30`);
    const end = new Date(start.getTime() + 30 * 60_000);
    setCreating({ start: toLocalInput(start.toISOString()), end: toLocalInput(end.toISOString()) });
  }
  function quickNewEvent() {
    // Default to "now rounded to top of hour, 30 minutes long".
    const d = new Date(); d.setMinutes(0, 0, 0);
    const startISO = d.toISOString();
    const endISO = new Date(d.getTime() + 30 * 60_000).toISOString();
    setCreating({ start: toLocalInput(startISO), end: toLocalInput(endISO) });
  }

  // Title bar string by view.
  const title = useMemo(() => {
    const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) =>
      new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { ...opts, timeZone: "Asia/Kolkata" });
    if (view === "day") {
      return fmt(anchor, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    }
    if (view === "week") {
      const dates = weekDatesIST(anchor);
      const left = fmt(dates[0]!, { day: "numeric", month: "short" });
      const right = fmt(dates[6]!, { day: "numeric", month: "short", year: "numeric" });
      return `${left} – ${right}`;
    }
    return fmt(anchor, { month: "long", year: "numeric" });
  }, [view, anchor]);

  return (
    <>
      {/* ── Toolbar ── */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button onClick={() => step(-1)} className="rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet" title="Previous">
          ‹
        </button>
        <button onClick={() => step(1)} className="rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet" title="Next">
          ›
        </button>
        <button onClick={goToday} className="rounded-md border border-rule bg-paper px-3 py-1.5 text-[12px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet">
          Today
        </button>
        <div className="ml-2 text-[14px] font-semibold tracking-[-.005em] text-ink">{title}</div>
        {busy && <span className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">syncing…</span>}
        <div className="flex-1" />
        <div className="inline-flex rounded-[10px] border border-rule bg-paper p-0.5">
          {(["day", "week", "month"] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                "rounded-[8px] px-3 py-1 text-[12px] font-semibold capitalize transition",
                view === v ? "bg-grad text-white shadow-glow" : "text-ink2 hover:text-brand-violet",
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <button onClick={quickNewEvent} className="btn-grad">
          <Icon name="plus" size={14} strokeWidth={2.2} /> New event
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">{error}</div>
      )}

      {/* ── View bodies ── */}
      {view === "day" && (
        <DayView
          date={anchor}
          todayISO={todayISTDate()}
          events={events}
          blocks={blocks}
          leaves={leaves}
          sessions={sessions}
          onNewAt={(hour) => newEventAt(anchor, hour)}
          onOpenEvent={setOpenEventId}
          onOpenSession={setOpenSession}
        />
      )}
      {view === "week" && (
        <WeekView
          weekDates={weekDatesIST(anchor)}
          todayISO={todayISTDate()}
          events={events}
          blocks={blocks}
          leaves={leaves}
          sessions={sessions}
          onNewAt={newEventAt}
          onOpenEvent={setOpenEventId}
          onOpenSession={setOpenSession}
        />
      )}
      {view === "month" && (
        <MonthView
          anchorISO={anchor}
          todayISO={todayISTDate()}
          events={events}
          sessions={sessions}
          leaves={leaves}
          onPickDay={(iso) => { setAnchor(iso); setView("day"); }}
          onNewEvent={(iso) => newEventAtDay(iso)}
          onOpenEvent={setOpenEventId}
        />
      )}

      {creating && (
        <EventDialog
          mode="create"
          meId={meId}
          people={people}
          defaultStart={creating.start}
          defaultEnd={creating.end}
          onClose={() => setCreating(null)}
          onSaved={reload}
        />
      )}
      {openEventId && (
        <EventDialog
          mode="detail"
          meId={meId}
          people={people}
          eventId={openEventId}
          onClose={() => setOpenEventId(null)}
          onSaved={reload}
        />
      )}
      {openSession && (
        <BatchSessionPopover session={openSession} onClose={() => setOpenSession(null)} />
      )}
    </>
  );
}

// ── DayView ────────────────────────────────────────────────────────────────
function DayView({
  date, todayISO, events, blocks, leaves, sessions,
  onNewAt, onOpenEvent, onOpenSession,
}: {
  date: string;
  todayISO: string;
  events: CalendarEventSummary[];
  blocks: TimeBlock[];
  leaves: LeaveDay[];
  sessions: BatchSession[];
  onNewAt: (hour: number) => void;
  onOpenEvent: (id: string) => void;
  onOpenSession: (s: BatchSession) => void;
}) {
  const isToday = date === todayISO;
  const dayEvents = events.filter((e) => istDate(e.startAt) === date);
  const dayBlocks = blocks.filter((b) => b.date === date);
  const daySessions = sessions.filter((s) => istDate(s.startAt) === date);
  const leave = leaves.find((l) => l.date === date);

  return (
    <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
      <div className="border-b border-rule bg-warm px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">
            {new Date(`${date}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", timeZone: "Asia/Kolkata" })}
          </div>
          <div className={cn("text-[20px] font-bold tracking-tight", isToday ? "text-brand-violet" : "text-ink")}>
            {new Date(`${date}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" })}
          </div>
          {leave && (
            <span className="ml-2 inline-flex rounded-full bg-state-warn/10 px-2 py-0.5 text-[10px] font-semibold text-state-warn">
              {LEAVE_LABEL[leave.kind]}
            </span>
          )}
        </div>
      </div>
      <div className="relative grid" style={{ gridTemplateColumns: "60px 1fr", height: HOURS.length * PX_PER_HOUR }}>
        <HourRail />
        <div className={cn("relative", isToday && "bg-warm/30")}>
          {HOURS.slice(0, -1).map((h) => (
            <button
              key={h}
              onClick={() => onNewAt(h)}
              className="absolute left-0 right-0 cursor-pointer border-b border-rule/60 hover:bg-brand-violet/5"
              style={{ top: (h - HOUR_START) * PX_PER_HOUR, height: PX_PER_HOUR }}
              title={`Add event at ${fmtHour(h)}`}
            />
          ))}
          {dayBlocks.map((b) => <BlockCard key={b.id} b={b} />)}
          {daySessions.map((s) => <SessionCard key={`sess-${s.cohortId}-${s.startAt}`} s={s} onClick={() => onOpenSession(s)} />)}
          {dayEvents.map((e) => <EventCard key={e.id} e={e} onClick={() => onOpenEvent(e.id)} />)}
        </div>
      </div>
    </div>
  );
}

// ── WeekView ───────────────────────────────────────────────────────────────
function WeekView({
  weekDates, todayISO, events, blocks, leaves, sessions,
  onNewAt, onOpenEvent, onOpenSession,
}: {
  weekDates: string[];
  todayISO: string;
  events: CalendarEventSummary[];
  blocks: TimeBlock[];
  leaves: LeaveDay[];
  sessions: BatchSession[];
  onNewAt: (date: string, hour: number) => void;
  onOpenEvent: (id: string) => void;
  onOpenSession: (s: BatchSession) => void;
}) {
  const eventsByDay = useMemo(() => {
    const m = new Map<string, CalendarEventSummary[]>();
    for (const e of events) {
      const d = istDate(e.startAt);
      if (!weekDates.includes(d)) continue;
      const list = m.get(d) ?? [];
      list.push(e);
      m.set(d, list);
    }
    return m;
  }, [events, weekDates]);

  const blocksByDay = useMemo(() => {
    const m = new Map<string, TimeBlock[]>();
    for (const b of blocks) {
      const list = m.get(b.date) ?? [];
      list.push(b);
      m.set(b.date, list);
    }
    return m;
  }, [blocks]);

  const sessionsByDay = useMemo(() => {
    const m = new Map<string, BatchSession[]>();
    for (const s of sessions) {
      const d = istDate(s.startAt);
      if (!weekDates.includes(d)) continue;
      const list = m.get(d) ?? [];
      list.push(s);
      m.set(d, list);
    }
    return m;
  }, [sessions, weekDates]);

  const leavesByDay = useMemo(() => {
    const m = new Map<string, LeaveDay>();
    for (const l of leaves) m.set(l.date, l);
    return m;
  }, [leaves]);

  return (
    <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
      <div className="grid border-b border-rule bg-warm" style={{ gridTemplateColumns: "60px repeat(7, minmax(0, 1fr))" }}>
        <div />
        {weekDates.map((iso) => {
          const isToday = iso === todayISO;
          return (
            <div key={iso} className={cn("px-2 py-3 text-center", isToday && "bg-warm2")}>
              <div className="mono-cap text-[9px] font-semibold tracking-[.12em] text-mute">
                {new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", timeZone: "Asia/Kolkata" })}
              </div>
              <div className={cn("mt-0.5 text-[18px] font-bold tracking-tight", isToday ? "text-brand-violet" : "text-ink")}>
                {new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", timeZone: "Asia/Kolkata" })}
              </div>
              {leavesByDay.get(iso) && (
                <div className="mt-1 inline-flex rounded-full bg-state-warn/10 px-2 py-0.5 text-[9px] font-semibold text-state-warn">
                  {LEAVE_LABEL[leavesByDay.get(iso)!.kind]}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="relative grid" style={{ gridTemplateColumns: "60px repeat(7, minmax(0, 1fr))", height: HOURS.length * PX_PER_HOUR }}>
        <HourRail />
        {weekDates.map((iso) => {
          const isToday = iso === todayISO;
          return (
            <div key={iso} className={cn("relative border-r border-rule last:border-r-0", isToday && "bg-warm/30")}>
              {HOURS.slice(0, -1).map((h) => (
                <button
                  key={h}
                  onClick={() => onNewAt(iso, h)}
                  className="absolute left-0 right-0 cursor-pointer border-b border-rule/60 hover:bg-brand-violet/5"
                  style={{ top: (h - HOUR_START) * PX_PER_HOUR, height: PX_PER_HOUR }}
                  title={`Add event at ${fmtHour(h)}`}
                />
              ))}
              {(blocksByDay.get(iso) ?? []).map((b) => <BlockCard key={b.id} b={b} />)}
              {(sessionsByDay.get(iso) ?? []).map((s) => (
                <SessionCard key={`sess-${s.cohortId}-${s.startAt}`} s={s} onClick={() => onOpenSession(s)} />
              ))}
              {(eventsByDay.get(iso) ?? []).map((e) => (
                <EventCard key={e.id} e={e} onClick={() => onOpenEvent(e.id)} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── MonthView ──────────────────────────────────────────────────────────────
function MonthView({
  anchorISO, todayISO, events, sessions, leaves,
  onPickDay, onNewEvent, onOpenEvent,
}: {
  anchorISO: string;
  todayISO: string;
  events: CalendarEventSummary[];
  sessions: BatchSession[];
  leaves: LeaveDay[];
  onPickDay: (iso: string) => void;
  onNewEvent: (iso: string) => void;
  onOpenEvent: (id: string) => void;
}) {
  const { dates } = monthGridIST(anchorISO);
  const monthIdx = new Date(`${anchorISO}T12:00:00Z`).getUTCMonth();

  const eventsByDay = useMemo(() => {
    const m = new Map<string, CalendarEventSummary[]>();
    for (const e of events) {
      const d = istDate(e.startAt);
      const list = m.get(d) ?? [];
      list.push(e);
      m.set(d, list);
    }
    return m;
  }, [events]);
  const sessionsByDay = useMemo(() => {
    const m = new Map<string, BatchSession[]>();
    for (const s of sessions) {
      const d = istDate(s.startAt);
      const list = m.get(d) ?? [];
      list.push(s);
      m.set(d, list);
    }
    return m;
  }, [sessions]);
  const leavesByDay = useMemo(() => {
    const m = new Map<string, LeaveDay>();
    for (const l of leaves) m.set(l.date, l);
    return m;
  }, [leaves]);

  return (
    <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
      <div className="grid grid-cols-7 border-b border-rule bg-warm">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="px-2 py-2 text-center mono-cap text-[9px] font-semibold tracking-[.12em] text-mute">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {dates.map((iso, i) => {
          const inMonth = new Date(`${iso}T12:00:00Z`).getUTCMonth() === monthIdx;
          const isToday = iso === todayISO;
          const dayEvents = eventsByDay.get(iso) ?? [];
          const daySessions = sessionsByDay.get(iso) ?? [];
          const leave = leavesByDay.get(iso);
          return (
            <div
              key={iso}
              className={cn(
                "group/cell relative min-h-[110px] border-b border-r border-rule p-1.5",
                !inMonth && "bg-warm/30",
                isToday && "bg-warm2",
                (i + 1) % 7 === 0 && "border-r-0",
                i >= 35 && "border-b-0",
              )}
            >
              <div className="mb-1 flex items-center justify-between">
                <button
                  onClick={() => onPickDay(iso)}
                  className={cn(
                    "rounded px-1 py-0.5 text-[12px] font-semibold transition hover:bg-warm",
                    isToday ? "text-brand-violet" : inMonth ? "text-ink" : "text-mute",
                  )}
                  title="Open day view"
                >
                  {new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", timeZone: "Asia/Kolkata" })}
                </button>
                <button
                  onClick={() => onNewEvent(iso)}
                  className="rounded p-0.5 text-mute opacity-0 transition hover:text-brand-violet group-hover/cell:opacity-100"
                  title="New event on this day"
                >
                  <Icon name="plus" size={12} strokeWidth={2.4} />
                </button>
              </div>
              {leave && (
                <div className="mb-1 inline-flex rounded-full bg-state-warn/10 px-1.5 py-0.5 text-[9px] font-semibold text-state-warn">
                  {LEAVE_LABEL[leave.kind]}
                </div>
              )}
              <div className="space-y-0.5">
                {daySessions.slice(0, 2).map((s) => (
                  <div
                    key={`sess-${s.cohortId}-${s.startAt}`}
                    className="truncate rounded border-l-[3px] border-brand-blue bg-brand-blue/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand-blue"
                    title={`${s.title} · ${fmtHourMinIST(s.startAt)}`}
                  >
                    🎓 {fmtHourMinIST(s.startAt)} {s.title}
                  </div>
                ))}
                {dayEvents.slice(0, 3).map((e) => (
                  <button
                    key={e.id}
                    onClick={() => onOpenEvent(e.id)}
                    className={cn(
                      "block w-full truncate rounded px-1.5 py-0.5 text-left text-[10px] font-semibold",
                      RSVP_TONE[e.rsvp ?? "pending"],
                    )}
                    title={`${e.title} · ${e.allDay ? "all day" : fmtHourMinIST(e.startAt)}`}
                  >
                    {e.allDay ? "● " : `${fmtHourMinIST(e.startAt)} `}{e.title}
                  </button>
                ))}
                {dayEvents.length + daySessions.length > 5 && (
                  <button
                    onClick={() => onPickDay(iso)}
                    className="text-[10px] font-semibold text-mute hover:text-brand-violet"
                  >
                    +{dayEvents.length + daySessions.length - 5} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── shared cards ───────────────────────────────────────────────────────────
function HourRail() {
  return (
    <div className="relative border-r border-rule">
      {HOURS.map((h) => (
        <div key={h} className="absolute -translate-y-1/2 px-1.5 text-right" style={{ top: (h - HOUR_START) * PX_PER_HOUR }}>
          <span className="mono-cap text-[9px] font-semibold tracking-[.04em] text-mute">{fmtHour(h)}</span>
        </div>
      ))}
    </div>
  );
}

function BlockCard({ b }: { b: TimeBlock }) {
  const top = (istHour(b.startAt) - HOUR_START) * PX_PER_HOUR;
  const height = (istHour(b.endAt) - istHour(b.startAt)) * PX_PER_HOUR;
  if (top + height < 0 || top > HOURS.length * PX_PER_HOUR) return null;
  return (
    <div
      className="pointer-events-none absolute left-1 right-1 rounded bg-ink/[.04] px-1 py-0.5"
      style={{ top, height: Math.max(8, height - 1) }}
      title={`${b.clientName ?? "Time block"}`}
    >
      <div className="truncate text-[9px] text-mute">{b.clientName ?? "Logged"}</div>
    </div>
  );
}

function SessionCard({ s, onClick }: { s: BatchSession; onClick: () => void }) {
  const top = (istHour(s.startAt) - HOUR_START) * PX_PER_HOUR;
  const height = (istHour(s.endAt) - istHour(s.startAt)) * PX_PER_HOUR;
  if (top + height < 0 || top > HOURS.length * PX_PER_HOUR) return null;
  return (
    <button
      onClick={onClick}
      className="absolute left-1 right-1 z-[5] overflow-hidden rounded border-l-[3px] border-brand-blue bg-brand-blue/10 px-1.5 py-1 text-left text-brand-blue ring-1 ring-brand-blue/40"
      style={{ top, height: Math.max(20, height - 2) }}
      title={`${s.title}${s.courseName ? " · " + s.courseName : ""}`}
    >
      <div className="mono-cap text-[8px] font-semibold tracking-[.12em] opacity-80">🎓 BATCH</div>
      <div className="mt-0.5 truncate text-[11px] font-semibold leading-tight">{s.title}</div>
      <div className="mt-0.5 truncate text-[9.5px] opacity-80">
        {fmtHourMinIST(s.startAt)}–{fmtHourMinIST(s.endAt)}
        {s.courseName ? ` · ${s.courseName}` : ""}
      </div>
    </button>
  );
}

function EventCard({ e, onClick }: { e: CalendarEventSummary; onClick: () => void }) {
  if (e.allDay) {
    return (
      <button
        onClick={onClick}
        className={cn(
          "absolute left-1 right-1 top-0 z-10 rounded px-1.5 py-1 text-left text-[10px] font-semibold",
          RSVP_TONE[e.rsvp ?? "pending"],
        )}
      >
        <span className="truncate">{e.title} · all day</span>
      </button>
    );
  }
  const top = (istHour(e.startAt) - HOUR_START) * PX_PER_HOUR;
  const height = (istHour(e.endAt) - istHour(e.startAt)) * PX_PER_HOUR;
  if (top + height < 0 || top > HOURS.length * PX_PER_HOUR) return null;
  return (
    <button
      onClick={onClick}
      className={cn(
        "absolute left-1 right-1 z-10 overflow-hidden rounded px-1.5 py-1 text-left",
        RSVP_TONE[e.rsvp ?? "pending"],
      )}
      style={{ top, height: Math.max(20, height - 2) }}
    >
      <div className="truncate text-[11px] font-semibold leading-tight">{e.title}</div>
      <div className="mt-0.5 truncate text-[9.5px] opacity-80">
        {fmtHourMinIST(e.startAt)}–{fmtHourMinIST(e.endAt)}
        {e.location ? ` · ${e.location}` : ""}
      </div>
    </button>
  );
}
