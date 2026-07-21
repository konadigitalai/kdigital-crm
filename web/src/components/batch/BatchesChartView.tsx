"use client";

// Batches > Chart. Pure SVG/CSS, mirroring LearnersChartView's card chrome.
//   1 — Batches by status (bar): upcoming / running / completed / cancelled.
//   2 — Coverage (avg) — degrades to a clear note when no batch has coverage yet
//       (Phase 1: coveragePct is always null until the session subsystem lands).
//   3 — Attendance (avg) — degrades the same way.
//   4 — Staffing (donut): staffed vs unstaffed.
//   5 — Enrolment health (bar): under-enrolled vs adequately enrolled.

import { useMemo } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import type { BatchBoardRow } from "@/lib/types";

export type BatchChartRange = "30d" | "90d" | "all";
export const BATCH_CHART_RANGES: Array<{ value: BatchChartRange; label: string }> = [
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

const istDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
});
const DAY_MS = 86_400_000;
function istDayStart(d: Date): number { return Date.parse(istDayFmt.format(d)); }

const STATUS_META: Record<string, { label: string; hex: string }> = {
  upcoming:  { label: "Upcoming",  hex: "#1F3FCF" },
  running:   { label: "Running",   hex: "#2E9E6A" },
  completed: { label: "Completed", hex: "#A89DAC" },
  cancelled: { label: "Cancelled", hex: "#D9534F" },
};
const STATUS_ORDER = ["upcoming", "running", "completed", "cancelled"];

function Card({ title, subtitle, className, children }: { title: string; subtitle: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("rounded-[14px] border border-rule bg-paper p-[18px]", className)}>
      <div className="mb-4 min-w-0">
        <div className="text-[14px] font-bold text-ink">{title}</div>
        <div className="mono-cap mt-0.5 text-[9px] tracking-[.1em] text-hint">{subtitle}</div>
      </div>
      {children}
    </div>
  );
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((s, v) => s + v, 0) / values.length);
}

function AvgGauge({ value, label }: { value: number | null; label: string }) {
  if (value == null) {
    return (
      <div className="flex h-[180px] flex-col items-center justify-center gap-2 text-center">
        <Icon name="info" size={22} strokeWidth={1.8} className="text-hint" />
        <div className="text-[13px] font-semibold text-ink2">Not available yet</div>
        <div className="max-w-[280px] text-[11.5px] text-mute">
          No batch has {label} recorded yet. This chart lights up as sessions and attendance are captured.
        </div>
      </div>
    );
  }
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="flex h-[180px] flex-col items-center justify-center gap-4">
      <div className="text-[40px] font-bold leading-none tracking-[-.02em] text-ink">{pct}<span className="text-[20px] text-mute">%</span></div>
      <div className="h-2.5 w-full max-w-[280px] overflow-hidden rounded-full bg-warm2">
        <div className="h-full rounded-full bg-grad" style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
    </div>
  );
}

export function BatchesChartView({ rows, range }: { rows: BatchBoardRow[]; range: BatchChartRange }) {
  const scoped = useMemo(() => {
    const now = new Date();
    const floor = range === "30d" ? istDayStart(now) - 30 * DAY_MS
      : range === "90d" ? istDayStart(now) - 90 * DAY_MS
      : null;
    if (floor === null) return rows;
    return rows.filter((b) => {
      if (!b.startDate) return false;
      const t = Date.parse(b.startDate);
      return Number.isFinite(t) && istDayStart(new Date(t)) >= floor;
    });
  }, [rows, range]);

  const byStatus = useMemo(() => {
    return STATUS_ORDER.map((s) => ({
      key: s,
      label: STATUS_META[s]?.label ?? s,
      hex: STATUS_META[s]?.hex ?? "#A89DAC",
      count: scoped.filter((b) => b.status === s).length,
    })).filter((d) => d.count > 0);
  }, [scoped]);

  const avgCoverage = useMemo(
    () => avg(scoped.map((b) => b.coveragePct).filter((v): v is number => v != null)),
    [scoped],
  );
  const avgAttendance = useMemo(
    () => avg(scoped.map((b) => b.attendancePct).filter((v): v is number => v != null)),
    [scoped],
  );

  const staffing = useMemo(() => {
    const staffed = scoped.filter((b) => b.staffed).length;
    const unstaffed = scoped.length - staffed;
    return [
      { key: "staffed",   label: "Staffed",   hex: "#2E9E6A", count: staffed },
      { key: "unstaffed", label: "Unstaffed", hex: "#E08A1E", count: unstaffed },
    ].filter((d) => d.count > 0);
  }, [scoped]);

  const enrolment = useMemo(() => {
    const under = scoped.filter((b) => b.underEnrolled).length;
    const ok = scoped.length - under;
    return [
      { key: "ok",    label: "Adequately enrolled", hex: "#2E9E6A", count: ok },
      { key: "under", label: "Under-enrolled",      hex: "#E08A1E", count: under },
    ];
  }, [scoped]);

  if (scoped.length === 0) {
    return (
      <div className="rounded-[14px] border border-rule bg-paper p-12 text-center text-[13px] text-mute">
        No batches match the current filter.
      </div>
    );
  }

  const maxStatus = Math.max(1, ...byStatus.map((d) => d.count));
  const staffingTotal = staffing.reduce((s, d) => s + d.count, 0);
  const maxEnrol = Math.max(1, ...enrolment.map((d) => d.count));

  // Donut geometry.
  const R = 54, C = 2 * Math.PI * R;
  let dashCursor = 0;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      {/* 1 — Batches by status */}
      <Card title="Batches by status" subtitle="COUNT · BY STATUS">
        <div className="flex flex-col gap-2">
          {byStatus.map((d) => {
            const pct = (d.count / maxStatus) * 100;
            const inside = pct >= 12;
            return (
              <div key={d.key} className="flex items-center gap-2.5">
                <div className="w-[110px] flex-shrink-0 truncate text-[12px] text-ink2" title={d.label}>{d.label}</div>
                <div className="relative flex-1">
                  <div className="h-6 rounded-md bg-warm2/60" />
                  <div className="absolute inset-y-0 left-0 flex items-center justify-end rounded-md pr-2" style={{ width: `${Math.max(2, pct)}%`, background: d.hex }}>
                    {inside && <span className="text-[11px] font-bold text-white">{d.count}</span>}
                  </div>
                  {!inside && <span className="absolute inset-y-0 flex items-center pl-1.5 text-[11px] font-bold text-ink2" style={{ left: `${Math.max(2, pct)}%` }}>{d.count}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* 4 — Staffing */}
      <Card title="Staffing" subtitle="BATCHES · TRAINER ASSIGNED">
        <div className="flex items-center gap-6">
          <div className="relative h-[140px] w-[140px] flex-shrink-0">
            <svg viewBox="0 0 140 140" className="h-full w-full">
              <g transform="rotate(-90 70 70)">
                {staffing.map((d) => {
                  const frac = staffingTotal > 0 ? d.count / staffingTotal : 0;
                  const dash = frac * C;
                  const offset = -dashCursor;
                  dashCursor += dash;
                  return (
                    <circle key={d.key} cx={70} cy={70} r={R} fill="none" stroke={d.hex} strokeWidth={18} strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={offset} />
                  );
                })}
              </g>
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <div className="text-[20px] font-bold text-ink">{staffingTotal}</div>
              <div className="mono-cap text-[8.5px] text-hint">TOTAL</div>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            {staffing.map((d) => (
              <div key={d.key} className="flex items-center gap-2 text-[12px]">
                <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: d.hex }} />
                <span className="min-w-0 flex-1 truncate text-ink2">{d.label}</span>
                <span className="font-bold text-ink">{d.count}</span>
                <span className="w-9 text-right font-mono text-[10px] text-mute">{staffingTotal > 0 ? Math.round((d.count / staffingTotal) * 100) : 0}%</span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* 2 — Coverage */}
      <Card title="Average coverage" subtitle="BATCHES · SESSION COVERAGE">
        <AvgGauge value={avgCoverage} label="coverage" />
      </Card>

      {/* 3 — Attendance */}
      <Card title="Average attendance" subtitle="BATCHES · LEARNER ATTENDANCE">
        <AvgGauge value={avgAttendance} label="attendance" />
      </Card>

      {/* 5 — Enrolment health */}
      <Card title="Enrolment health" subtitle="BATCHES · BY ENROLMENT LEVEL" className="lg:col-span-2">
        <div className="flex flex-col gap-2">
          {enrolment.map((d) => {
            const pct = (d.count / maxEnrol) * 100;
            const inside = pct >= 12;
            return (
              <div key={d.key} className="flex items-center gap-2.5">
                <div className="w-[160px] flex-shrink-0 truncate text-[12px] text-ink2" title={d.label}>{d.label}</div>
                <div className="relative flex-1">
                  <div className="h-6 rounded-md bg-warm2/60" />
                  <div className="absolute inset-y-0 left-0 flex items-center justify-end rounded-md pr-2" style={{ width: `${Math.max(2, pct)}%`, background: d.hex }}>
                    {inside && <span className="text-[11px] font-bold text-white">{d.count}</span>}
                  </div>
                  {!inside && <span className="absolute inset-y-0 flex items-center pl-1.5 text-[11px] font-bold text-ink2" style={{ left: `${Math.max(2, pct)}%` }}>{d.count}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
