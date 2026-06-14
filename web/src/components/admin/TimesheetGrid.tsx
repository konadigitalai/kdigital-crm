"use client";

// Admin team timesheet — Day / Week / Month with date navigation. Owns the
// anchor + scope state and refetches each user's range when the visible
// window changes. The week table from the previous version lives inside
// `WeekBody`; Day uses a single-column variant; Month is a calendar grid.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { getTimesheetRange } from "@/lib/api";
import type { AdminUser, LeaveDay, LeaveKind, TimeBlock, WorkSession } from "@/lib/types";

export interface UserTimesheet {
  user: { id: string; name: string; email: string; role: string };
  sessions: WorkSession[];
  blocks: TimeBlock[];
  leaves: LeaveDay[];
}

type Scope = "day" | "week" | "month";

interface Props {
  users: AdminUser[];
  initialAnchorISO: string;          // todayISO from the server
  initialScope?: Scope;
  initialFrom: string;
  initialTo: string;
  initialRows: UserTimesheet[];
}

const LEAVE_LABEL: Record<LeaveKind, string> = {
  sick: "Sick", personal: "Personal", vacation: "Vacation", wfh: "WFH", holiday: "Holiday",
};

const LEAVE_TONES: Record<LeaveKind, string> = {
  sick:     "bg-state-warn/10 text-state-warn",
  personal: "bg-brand-violet/10 text-brand-violet",
  vacation: "bg-brand-blue/10 text-brand-blue",
  wfh:      "bg-state-amber/10 text-state-amber",
  holiday:  "bg-state-ok/10 text-state-ok",
};

// ── time helpers ──────────────────────────────────────────────────────────
function durMins(startISO: string, endISO: string): number {
  return Math.max(0, Math.round((new Date(endISO).getTime() - new Date(startISO).getTime()) / 60_000));
}
function fmtDur(mins: number): string {
  if (!mins) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}m`;
}
function timeIST(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata",
  });
}

// ── date helpers ──────────────────────────────────────────────────────────
function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function startOfWeekISO(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const sinceMon = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - sinceMon);
  return d.toISOString().slice(0, 10);
}
function weekDatesFor(anchor: string): string[] {
  const start = startOfWeekISO(anchor);
  return Array.from({ length: 7 }, (_, i) => addDaysISO(start, i));
}
function monthGrid(anchor: string): string[] {
  const a = new Date(`${anchor}T12:00:00Z`);
  const first = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1, 12));
  const sinceMon = (first.getUTCDay() + 6) % 7;
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - sinceMon);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}
function rangeFor(scope: Scope, anchor: string): { from: string; to: string; dates: string[] } {
  if (scope === "day") return { from: anchor, to: anchor, dates: [anchor] };
  if (scope === "week") {
    const dates = weekDatesFor(anchor);
    return { from: dates[0]!, to: dates[6]!, dates };
  }
  const grid = monthGrid(anchor);
  return { from: grid[0]!, to: grid[grid.length - 1]!, dates: grid };
}
function todayISTDate(): string {
  const ist = new Date(Date.now() + (5 * 60 + 30) * 60_000);
  return ist.toISOString().slice(0, 10);
}

// ── component ────────────────────────────────────────────────────────────
export function TimesheetGrid({
  users, initialAnchorISO, initialScope = "week",
  initialFrom, initialTo, initialRows,
}: Props) {
  const router = useRouter();
  const [anchor, setAnchor] = useState<string>(initialAnchorISO);
  const [scope, setScope] = useState<Scope>(initialScope);
  const [rows, setRows] = useState<UserTimesheet[]>(initialRows);
  const [loadedRange, setLoadedRange] = useState({ from: initialFrom, to: initialTo });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [drillCell, setDrillCell] = useState<CellInfo | null>(null);
  const [calOpen, setCalOpen] = useState(false);

  // What range we want loaded right now.
  const wanted = useMemo(() => {
    const r = rangeFor(scope, anchor);
    return { from: r.from, to: r.to };
  }, [scope, anchor]);

  // Active users only — exclude deactivated accounts.
  const activeUsers = useMemo(() => users.filter((u) => u.active), [users]);

  // Refetch every user's range when the visible window changes.
  useEffect(() => {
    if (wanted.from === loadedRange.from && wanted.to === loadedRange.to) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    Promise.all(
      activeUsers.map(async (u) => {
        try {
          const r = await getTimesheetRange(wanted.from, wanted.to, u.id);
          return {
            user: { id: u.id, name: u.name ?? u.email, email: u.email, role: u.role },
            sessions: r.sessions, blocks: r.blocks, leaves: r.leaves,
          } as UserTimesheet;
        } catch {
          return {
            user: { id: u.id, name: u.name ?? u.email, email: u.email, role: u.role },
            sessions: [], blocks: [], leaves: [],
          } as UserTimesheet;
        }
      }),
    )
      .then((next) => {
        if (cancelled) return;
        next.sort((a, b) => {
          const aH = a.blocks.length;
          const bH = b.blocks.length;
          if (aH !== bH) return bH - aH;
          return a.user.name.localeCompare(b.user.name);
        });
        setRows(next);
        setLoadedRange(wanted);
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [wanted, loadedRange, activeUsers]);

  const reload = useCallback(() => router.refresh(), [router]);


  function step(dir: -1 | 1) {
    if (scope === "day") setAnchor(addDaysISO(anchor, dir));
    else if (scope === "week") setAnchor(addDaysISO(anchor, dir * 7));
    else {
      const d = new Date(`${anchor}T12:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + dir);
      setAnchor(d.toISOString().slice(0, 10));
    }
  }
  function goToday() { setAnchor(todayISTDate()); }

  // Title bar string by scope.
  const title = useMemo(() => {
    const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) =>
      new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { ...opts, timeZone: "Asia/Kolkata" });
    if (scope === "day") return fmt(anchor, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    if (scope === "week") {
      const d = weekDatesFor(anchor);
      return `${fmt(d[0]!, { day: "numeric", month: "short" })} – ${fmt(d[6]!, { day: "numeric", month: "short", year: "numeric" })}`;
    }
    return fmt(anchor, { month: "long", year: "numeric" });
  }, [scope, anchor]);

  const todayISO = todayISTDate();

  return (
    <>
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button onClick={() => step(-1)} title="Previous"
          className="rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet">‹</button>
        <button onClick={() => step(1)} title="Next"
          className="rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet">›</button>
        <button onClick={goToday}
          className="rounded-md border border-rule bg-paper px-3 py-1.5 text-[12px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet">
          Today
        </button>

        <div className="relative">
          <button
            onClick={() => setCalOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:border-brand-violet"
            title="Pick a date"
          >
            <Icon name="clock" size={12} strokeWidth={2} className="text-mute" />
            {title}
            <span className="text-mute">▾</span>
          </button>
          {calOpen && (
            <MiniCalendar
              anchor={anchor}
              todayISO={todayISO}
              rows={rows}
              onPick={(iso) => { setAnchor(iso); setCalOpen(false); }}
              onClose={() => setCalOpen(false)}
            />
          )}
        </div>

        {busy && <span className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">syncing…</span>}

        <div className="flex-1" />

        <div className="inline-flex rounded-[10px] border border-rule bg-warm/50 p-0.5">
          {(["day", "week", "month"] as Scope[]).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={cn(
                "rounded-[8px] px-3 py-1 text-[12px] font-semibold capitalize transition",
                scope === s ? "bg-grad text-white shadow-glow" : "text-ink2 hover:text-brand-violet",
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">{error}</div>
      )}

      {/* Body */}
      {scope === "day" && (
        <DayBody
          date={anchor}
          todayISO={todayISO}
          rows={rows}
          onDrill={(c) => setDrillCell(c)}
        />
      )}
      {scope === "week" && (
        <WeekBody
          weekDates={weekDatesFor(anchor)}
          todayISO={todayISO}
          rows={rows}
          onDrill={(c) => setDrillCell(c)}
        />
      )}
      {scope === "month" && (
        <MonthBody
          anchor={anchor}
          todayISO={todayISO}
          rows={rows}
          onPickDay={(iso) => { setAnchor(iso); setScope("day"); }}
        />
      )}

      {drillCell && <DayDrillDialog cell={drillCell} onClose={() => { setDrillCell(null); reload(); }} />}
    </>
  );
}

// ── Cell drill-down state ────────────────────────────────────────────────
interface CellInfo {
  userId: string;
  userName: string;
  date: string;
  blocks: TimeBlock[];
  leave: LeaveDay | null;
  totalMins: number;
}

// ── DayBody — single column ──────────────────────────────────────────────
function DayBody({
  date, todayISO, rows, onDrill,
}: {
  date: string;
  todayISO: string;
  rows: UserTimesheet[];
  onDrill: (c: CellInfo) => void;
}) {
  const isToday = date === todayISO;
  return (
    <div className="overflow-x-auto rounded-2xl border border-rule bg-paper">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-rule bg-warm">
            <th className="mono-cap px-4 py-3 text-left text-[9.5px] font-semibold tracking-[.12em] text-mute">User</th>
            <th className={cn("px-2 py-3 text-center", isToday && "bg-warm2")}>
              <div className="mono-cap text-[9px] font-semibold tracking-[.12em] text-mute">
                {new Date(`${date}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", timeZone: "Asia/Kolkata" })}
              </div>
              <div className={cn("mt-0.5 text-[14px] font-bold tracking-tight", isToday ? "text-brand-violet" : "text-ink")}>
                {new Date(`${date}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}
              </div>
            </th>
            <th className="mono-cap px-3 py-3 text-right text-[9.5px] font-semibold tracking-[.12em] text-mute">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={3} className="px-4 py-12 text-center text-[13px] text-mute">No employees found.</td>
            </tr>
          ) : (
            rows.map((r) => {
              const blocksOnDay = r.blocks.filter((b) => b.date === date);
              const totalMins = blocksOnDay.reduce((s, b) => s + durMins(b.startAt, b.endAt), 0);
              const leave = r.leaves.find((l) => l.date === date) ?? null;
              const empty = totalMins === 0 && !leave;
              return (
                <tr key={r.user.id} className="border-b border-rule last:border-b-0">
                  <td className="px-4 py-3 align-middle">
                    <div className="text-[13px] font-semibold tracking-[-.005em]">{r.user.name}</div>
                    <div className="mono-cap mt-0.5 text-[9px] tracking-[.04em] text-mute">{r.user.role}</div>
                  </td>
                  <td
                    className={cn("px-2 py-3 text-center align-middle", isToday && "bg-warm/40", !empty && "cursor-pointer hover:bg-warm")}
                    onClick={() => {
                      if (empty) return;
                      onDrill({ userId: r.user.id, userName: r.user.name, date, blocks: blocksOnDay, leave, totalMins });
                    }}
                  >
                    {leave ? (
                      <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold", LEAVE_TONES[leave.kind])}>
                        {LEAVE_LABEL[leave.kind]}
                      </span>
                    ) : totalMins > 0 ? (
                      <span className="font-mono text-[12.5px] font-semibold text-ink">{fmtDur(totalMins)}</span>
                    ) : (
                      <span className="text-[12px] text-hint">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right align-middle">
                    <span className="font-mono text-[12.5px] font-semibold text-ink">{fmtDur(totalMins)}</span>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── WeekBody — the existing 7-column table ───────────────────────────────
function WeekBody({
  weekDates, todayISO, rows, onDrill,
}: {
  weekDates: string[];
  todayISO: string;
  rows: UserTimesheet[];
  onDrill: (c: CellInfo) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-rule bg-paper">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-rule bg-warm">
            <th className="mono-cap px-4 py-3 text-left text-[9.5px] font-semibold tracking-[.12em] text-mute">User</th>
            {weekDates.map((iso) => {
              const isToday = iso === todayISO;
              return (
                <th key={iso} className={cn("px-2 py-3 text-center", isToday && "bg-warm2")}>
                  <div className="mono-cap text-[9px] font-semibold tracking-[.12em] text-mute">
                    {new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", timeZone: "Asia/Kolkata" })}
                  </div>
                  <div className={cn("mt-0.5 text-[12px] font-bold tracking-tight", isToday ? "text-brand-violet" : "text-ink")}>
                    {new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", timeZone: "Asia/Kolkata" })}
                  </div>
                </th>
              );
            })}
            <th className="mono-cap px-3 py-3 text-right text-[9.5px] font-semibold tracking-[.12em] text-mute">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={weekDates.length + 2} className="px-4 py-12 text-center text-[13px] text-mute">No employees found.</td>
            </tr>
          ) : (
            rows.map((r) => {
              let weekTotal = 0;
              return (
                <tr key={r.user.id} className="border-b border-rule last:border-b-0">
                  <td className="px-4 py-3 align-middle">
                    <div className="text-[13px] font-semibold tracking-[-.005em]">{r.user.name}</div>
                    <div className="mono-cap mt-0.5 text-[9px] tracking-[.04em] text-mute">{r.user.role}</div>
                  </td>
                  {weekDates.map((iso) => {
                    const blocksOnDay = r.blocks.filter((b) => b.date === iso);
                    const totalMins = blocksOnDay.reduce((s, b) => s + durMins(b.startAt, b.endAt), 0);
                    weekTotal += totalMins;
                    const leave = r.leaves.find((l) => l.date === iso) ?? null;
                    const isToday = iso === todayISO;
                    const empty = totalMins === 0 && !leave;
                    return (
                      <td
                        key={iso}
                        className={cn("px-2 py-3 text-center align-middle", isToday && "bg-warm/40", !empty && "cursor-pointer hover:bg-warm")}
                        onClick={() => {
                          if (empty) return;
                          onDrill({ userId: r.user.id, userName: r.user.name, date: iso, blocks: blocksOnDay, leave, totalMins });
                        }}
                      >
                        {leave ? (
                          <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold", LEAVE_TONES[leave.kind])}>
                            {LEAVE_LABEL[leave.kind]}
                          </span>
                        ) : totalMins > 0 ? (
                          <span className="font-mono text-[12.5px] font-semibold text-ink">{fmtDur(totalMins)}</span>
                        ) : (
                          <span className="text-[12px] text-hint">—</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-3 text-right align-middle">
                    <span className="font-mono text-[12.5px] font-semibold text-ink">{fmtDur(weekTotal)}</span>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── MonthBody — per-day team totals on a calendar grid ───────────────────
function MonthBody({
  anchor, todayISO, rows, onPickDay,
}: {
  anchor: string;
  todayISO: string;
  rows: UserTimesheet[];
  onPickDay: (iso: string) => void;
}) {
  const dates = monthGrid(anchor);
  const monthIdx = new Date(`${anchor}T12:00:00Z`).getUTCMonth();

  // (date) → { totalMins, contributors, leaves }
  const dayAgg = useMemo(() => {
    const m = new Map<string, { mins: number; contributors: Set<string>; leaves: number }>();
    for (const r of rows) {
      for (const b of r.blocks) {
        const cur = m.get(b.date) ?? { mins: 0, contributors: new Set(), leaves: 0 };
        cur.mins += durMins(b.startAt, b.endAt);
        cur.contributors.add(r.user.id);
        m.set(b.date, cur);
      }
      for (const l of r.leaves) {
        const cur = m.get(l.date) ?? { mins: 0, contributors: new Set(), leaves: 0 };
        cur.leaves += 1;
        m.set(l.date, cur);
      }
    }
    return m;
  }, [rows]);

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
          const agg = dayAgg.get(iso);
          return (
            <button
              key={iso}
              onClick={() => onPickDay(iso)}
              title="Open day view for this date"
              className={cn(
                "relative min-h-[110px] border-b border-r border-rule p-2 text-left transition hover:bg-warm/60",
                !inMonth && "bg-warm/30",
                isToday && "bg-warm2",
                (i + 1) % 7 === 0 && "border-r-0",
                i >= 35 && "border-b-0",
              )}
            >
              <div className={cn(
                "text-[12px] font-semibold",
                isToday ? "text-brand-violet" : inMonth ? "text-ink" : "text-mute",
              )}>
                {new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", timeZone: "Asia/Kolkata" })}
              </div>
              {agg && agg.mins > 0 && (
                <div className="mt-1.5 font-mono text-[14px] font-bold tracking-tight text-ink">
                  {fmtDur(agg.mins)}
                </div>
              )}
              {agg && agg.contributors.size > 0 && (
                <div className="mono-cap mt-1 text-[9px] font-semibold tracking-[.08em] text-mute">
                  {agg.contributors.size} {agg.contributors.size === 1 ? "person" : "people"}
                </div>
              )}
              {agg && agg.leaves > 0 && (
                <div className="mono-cap mt-1 inline-flex rounded-full bg-state-warn/10 px-1.5 py-0.5 text-[9px] font-semibold text-state-warn">
                  {agg.leaves} on leave
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── MiniCalendar popover ─────────────────────────────────────────────────
function MiniCalendar({
  anchor, todayISO, rows, onPick, onClose,
}: {
  anchor: string;
  todayISO: string;
  rows: UserTimesheet[];
  onPick: (iso: string) => void;
  onClose: () => void;
}) {
  const [shown, setShown] = useState<string>(anchor);
  const grid = monthGrid(shown);
  const monthIdx = new Date(`${shown}T12:00:00Z`).getUTCMonth();
  const monthLabel = new Date(`${shown}T12:00:00Z`).toLocaleDateString("en-IN", {
    month: "long", year: "numeric", timeZone: "Asia/Kolkata",
  });

  // Click-outside to close.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  function shiftMonth(dir: -1 | 1) {
    const d = new Date(`${shown}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + dir);
    setShown(d.toISOString().slice(0, 10));
  }

  // Mark days that have any team activity.
  const active = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) {
      for (const b of r.blocks) s.add(b.date);
      for (const l of r.leaves) s.add(l.date);
    }
    return s;
  }, [rows]);

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-30 mt-1.5 w-[280px] rounded-2xl border border-rule bg-paper p-3 shadow-card"
      role="dialog"
    >
      <div className="mb-2 flex items-center gap-2">
        <button onClick={() => shiftMonth(-1)} className="rounded px-1.5 py-0.5 text-mute hover:bg-warm">‹</button>
        <div className="flex-1 text-center text-[12.5px] font-semibold text-ink">{monthLabel}</div>
        <button onClick={() => shiftMonth(1)} className="rounded px-1.5 py-0.5 text-mute hover:bg-warm">›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center mono-cap text-[8.5px] font-semibold tracking-[.1em] text-mute">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <div key={i}>{d}</div>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {grid.map((iso) => {
          const inMonth = new Date(`${iso}T12:00:00Z`).getUTCMonth() === monthIdx;
          const isToday = iso === todayISO;
          const isSelected = iso === anchor;
          const has = active.has(iso);
          return (
            <button
              key={iso}
              onClick={() => onPick(iso)}
              className={cn(
                "relative rounded-md py-1.5 text-[12px] transition",
                isSelected
                  ? "bg-grad text-white shadow-glow"
                  : isToday
                  ? "bg-warm2 text-brand-violet font-bold"
                  : inMonth
                  ? "text-ink hover:bg-warm"
                  : "text-mute hover:bg-warm",
              )}
            >
              {new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", timeZone: "Asia/Kolkata" })}
              {has && (
                <span className={cn("absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full",
                  isSelected ? "bg-white" : "bg-brand-violet")} />
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <button onClick={() => onPick(todayISO)} className="text-[11px] font-semibold text-brand-violet hover:underline">Today</button>
        <button onClick={onClose} className="text-[11px] font-semibold text-mute hover:text-ink">Close</button>
      </div>
    </div>
  );
}

// ── DayDrillDialog (read-only summary of a user × day) ───────────────────
function DayDrillDialog({ cell, onClose }: { cell: CellInfo; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="my-12 w-full max-w-[560px] rounded-2xl border border-rule bg-paper p-6 shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="font-serif text-[24px] font-normal leading-tight">{cell.userName}</h2>
            <p className="mt-1 text-[13px] text-mute">
              {new Date(`${cell.date}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" })}
              {" · "}
              {fmtDur(cell.totalMins)} logged
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink">✕</button>
        </div>

        {cell.leave && (
          <div className={cn("mb-4 rounded-[10px] px-3 py-2 text-[12.5px] font-semibold", LEAVE_TONES[cell.leave.kind])}>
            {LEAVE_LABEL[cell.leave.kind]}
            {cell.leave.halfDay !== "full" && <span> · {cell.leave.halfDay.toUpperCase()}</span>}
            {cell.leave.note && <span className="ml-2 font-normal opacity-70">— {cell.leave.note}</span>}
          </div>
        )}

        {cell.blocks.length === 0 ? (
          <div className="rounded-[10px] border border-rule bg-warm/40 px-3 py-6 text-center text-[12.5px] text-mute">
            No time blocks logged.
          </div>
        ) : (
          <div className="overflow-hidden rounded-[10px] border border-rule">
            {cell.blocks.map((b) => (
              <div key={b.id} className="grid items-center gap-3 border-b border-rule px-3 py-2 last:border-b-0"
                   style={{ gridTemplateColumns: "100px 1fr" }}>
                <span className="font-mono text-[12px] text-ink">
                  {timeIST(b.startAt)}–{timeIST(b.endAt)}
                </span>
                <span className="text-[12px] text-ink2">{b.note ?? <span className="text-hint">—</span>}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
