"use client";

// Learners > Calendar. A month grid of learner-join events, mirroring
// EnrollmentsCalendarView's layout. The only genuine per-learner date the row
// carries is `learnerSince` (when the party became a learner), so each learner
// is plotted on the day they joined — real data, not fabricated. Per-batch
// session dates aren't on the list row; when they land, add them as a second
// event kind. A learner with no join date is simply not plotted.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { avatarGradClass, gradFor, initialsOf } from "@/lib/ui";
import type { LearnerSummary } from "@/lib/types";

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

type CalEvent = { id: string; learner: LearnerSummary };

export function LearnersCalendarView({ rows, advisorFilter }: { rows: LearnerSummary[]; advisorFilter: string }) {
  const router = useRouter();
  const [anchor, setAnchor] = useState<string>(todayIST);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const today = todayIST();
  const days = useMemo(() => monthGrid(anchor), [anchor]);
  const anchorMonth = isoToUTCNoon(anchor).getUTCMonth();

  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const l of rows) {
      if (advisorFilter !== "all" && (l.advisorName ?? "") !== advisorFilter) continue;
      if (!l.learnerSince) continue;
      const day = istDayOf(l.learnerSince);
      const ev: CalEvent = { id: l.partyId, learner: l };
      const list = m.get(day);
      if (list) list.push(ev); else m.set(day, [ev]);
    }
    for (const list of m.values()) list.sort((a, b) => a.learner.name.localeCompare(b.learner.name));
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
        <div className="mono-cap text-[9.5px] tracking-[.1em] text-hint">Learners joined · by date</div>
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
                  const who = ev.learner.name.trim().split(/\s+/)[0] || "Learner";
                  return (
                    <button
                      key={ev.id}
                      type="button"
                      onClick={() => router.push(`/learners/${ev.learner.partyId}`)}
                      title={`${ev.learner.name}${ev.learner.programName ? ` · ${ev.learner.programName}` : ""}`}
                      className="flex w-full items-center gap-1.5 rounded-[6px] bg-[rgba(107,31,184,.10)] px-2 py-[4px] text-left text-[10.5px] font-medium text-brand-violet transition hover:brightness-95"
                    >
                      <span className={cn("flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full text-[6.5px] font-bold text-white", avatarGradClass[gradFor(ev.learner.name)])}>
                        {initialsOf(ev.learner.name)}
                      </span>
                      <span className="truncate">{who}</span>
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
