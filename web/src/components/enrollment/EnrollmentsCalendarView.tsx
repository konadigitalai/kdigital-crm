"use client";

// Enrollments > Calendar. A month grid of fee events, mirroring LeadsCalendarView's
// layout. Best-effort from the fields the row carries: each enrolment's next due
// date becomes an "instalment due" (or "overdue") event, coloured by payment
// health. Batch-start and completion events aren't plotted — the row shape
// doesn't carry those dates yet; when it does, add them as extra event kinds.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import type { Enrollment } from "@/lib/types";

const IST = "Asia/Kolkata";
const istDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" });
const monthTitleFmt = new Intl.DateTimeFormat("en-IN", { timeZone: IST, month: "long", year: "numeric" });
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_CHIPS = 3;

function todayIST(): string { return istDayFmt.format(new Date()); }
function istDayOf(iso: string): string { return istDayFmt.format(new Date(iso)); }
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

function fmtINR(n: number): string {
  if (!n) return "₹0";
  if (n >= 1_00_000) return `₹${(n / 1_00_000).toFixed(2).replace(/\.?0+$/, "")}L`;
  if (n >= 1_000)    return `₹${Math.round(n / 1_000)}k`;
  return `₹${Math.round(n)}`;
}

type CalEvent = { id: string; enrollment: Enrollment; overdue: boolean; due: number };

const CHIP_STYLE = {
  overdue: { bg: "bg-[rgba(217,83,79,.12)]", text: "text-state-warn", dot: "bg-state-warn" },
  due:     { bg: "bg-[rgba(224,138,30,.12)]", text: "text-state-amber", dot: "bg-state-amber" },
} as const;

export function EnrollmentsCalendarView({ rows, advisorFilter }: { rows: Enrollment[]; advisorFilter: string }) {
  const router = useRouter();
  const [anchor, setAnchor] = useState<string>(todayIST);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const today = todayIST();
  const days = useMemo(() => monthGrid(anchor), [anchor]);
  const anchorMonth = isoToUTCNoon(anchor).getUTCMonth();

  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of rows) {
      if (advisorFilter !== "all" && (e.advisorName ?? "") !== advisorFilter) continue;
      if (!e.dueDate) continue;
      const due = e.feeDue ? Number(e.feeDue) : 0;
      if (due <= 0) continue; // paid up — no instalment event
      const day = istDayOf(e.dueDate);
      const overdue = e.paymentHealth === "overdue" || e.paymentHealth === "critical";
      const ev: CalEvent = { id: e.id, enrollment: e, overdue, due };
      const list = m.get(day);
      if (list) list.push(ev); else m.set(day, [ev]);
    }
    for (const list of m.values()) list.sort((a, b) => b.due - a.due);
    return m;
  }, [rows, advisorFilter]);

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
        <div className="mono-cap text-[9.5px] tracking-[.1em] text-hint">Instalments due · Overdue fees</div>
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
                {shown.map((ev) => {
                  const s = ev.overdue ? CHIP_STYLE.overdue : CHIP_STYLE.due;
                  const who = ev.enrollment.name.trim().split(/\s+/)[0] || "Learner";
                  return (
                    <button
                      key={ev.id}
                      type="button"
                      onClick={() => router.push(`/enrollments/${encodeURIComponent(ev.enrollment.number ?? ev.enrollment.id)}`)}
                      title={`${ev.enrollment.name} · ${fmtINR(ev.due)} due${ev.overdue ? " · overdue" : ""}`}
                      className={cn("flex w-full items-center gap-1.5 rounded-[6px] px-2 py-[4px] text-left text-[10.5px] font-medium transition hover:brightness-95", s.bg, s.text)}
                    >
                      <span className={cn("h-1.5 w-1.5 flex-shrink-0 rounded-full", s.dot)} />
                      <span className="truncate">{who} · {fmtINR(ev.due)}</span>
                    </button>
                  );
                })}
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
