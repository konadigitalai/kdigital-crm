"use client";

// Learners > Chart. Pure SVG/CSS, mirroring EnrollmentsChartView's card chrome.
//   1 — Learners by family (bar).
//   2 — Status breakdown (donut): In batch / Assigned / Enrolled.
//   3 — Placement breakdown (bar) from learner_profile.placement_status —
//       degrades to a clear note when every learner's placement is null.
//   4 — Batches per learner (bar histogram): 0 / 1 / 2 / 3+ active batches.

import { useMemo } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import type { LearnerSummary } from "@/lib/types";

export type LearnerChartRange = "30d" | "90d" | "all";
export const LEARNER_CHART_RANGES: Array<{ value: LearnerChartRange; label: string }> = [
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
  "In batch": { label: "In batch", hex: "#2E9E6A" },
  "Assigned": { label: "Assigned", hex: "#1F3FCF" },
  "Enrolled": { label: "Enrolled", hex: "#A89DAC" },
};
const STATUS_ORDER = ["In batch", "Assigned", "Enrolled"];
const FAMILY_PALETTE = ["#6B1FB8", "#C7197A", "#1F3FCF", "#2E9E6A", "#E08A1E", "#A89DAC"];

const PLACEMENT_META: Record<string, { label: string; hex: string }> = {
  placed:      { label: "Placed",       hex: "#2E9E6A" },
  in_progress: { label: "In progress",  hex: "#1F3FCF" },
  not_started: { label: "Not started",  hex: "#A89DAC" },
  deferred:    { label: "Deferred",     hex: "#E08A1E" },
};
const PLACEMENT_ORDER = ["placed", "in_progress", "not_started", "deferred"];

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

export function LearnersChartView({ rows, range }: { rows: LearnerSummary[]; range: LearnerChartRange }) {
  const scoped = useMemo(() => {
    const now = new Date();
    const floor = range === "30d" ? istDayStart(now) - 30 * DAY_MS
      : range === "90d" ? istDayStart(now) - 90 * DAY_MS
      : null;
    if (floor === null) return rows;
    return rows.filter((l) => {
      if (!l.learnerSince) return false;
      const t = Date.parse(l.learnerSince);
      return Number.isFinite(t) && istDayStart(new Date(t)) >= floor;
    });
  }, [rows, range]);

  const byFamily = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of scoped) {
      const k = l.family || "TBD";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, count], i) => ({ label, count, hex: FAMILY_PALETTE[i % FAMILY_PALETTE.length] }));
  }, [scoped]);

  const byStatus = useMemo(() => {
    return STATUS_ORDER.map((s) => ({
      key: s,
      label: STATUS_META[s]?.label ?? s,
      hex: STATUS_META[s]?.hex ?? "#A89DAC",
      count: scoped.filter((l) => l.status === s).length,
    })).filter((d) => d.count > 0);
  }, [scoped]);

  const byPlacement = useMemo(() => {
    return PLACEMENT_ORDER.map((p) => ({
      key: p,
      label: PLACEMENT_META[p]?.label ?? p,
      hex: PLACEMENT_META[p]?.hex ?? "#A89DAC",
      count: scoped.filter((l) => l.placementStatus === p).length,
    })).filter((d) => d.count > 0);
  }, [scoped]);

  const batchBuckets = useMemo(() => {
    const buckets = [0, 0, 0, 0]; // 0, 1, 2, 3+
    for (const l of scoped) {
      const n = l.activeBatches;
      buckets[Math.min(n, 3)] += 1;
    }
    return buckets.map((count, i) => ({ label: i === 3 ? "3+" : String(i), count }));
  }, [scoped]);

  if (scoped.length === 0) {
    return (
      <div className="rounded-[14px] border border-rule bg-paper p-12 text-center text-[13px] text-mute">
        No learners match the current filter.
      </div>
    );
  }

  const maxFamily = Math.max(1, ...byFamily.map((d) => d.count));
  const statusTotal = byStatus.reduce((s, d) => s + d.count, 0);
  const maxBatch = Math.max(1, ...batchBuckets.map((d) => d.count));
  const placementTotal = byPlacement.reduce((s, d) => s + d.count, 0);

  // Donut geometry.
  const R = 54, C = 2 * Math.PI * R;
  let dashCursor = 0;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      {/* 1 — Learners by family */}
      <Card title="Learners by family" subtitle="HEADCOUNT · BY FAMILY">
        <div className="flex flex-col gap-2">
          {byFamily.map((d) => {
            const pct = (d.count / maxFamily) * 100;
            const inside = pct >= 12;
            return (
              <div key={d.label} className="flex items-center gap-2.5">
                <div className="w-[130px] flex-shrink-0 truncate text-[12px] text-ink2" title={d.label}>{d.label}</div>
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

      {/* 2 — Status breakdown */}
      <Card title="Status breakdown" subtitle="LEARNERS · BY BOARD STATUS">
        <div className="flex items-center gap-6">
          <div className="relative h-[140px] w-[140px] flex-shrink-0">
            <svg viewBox="0 0 140 140" className="h-full w-full">
              <g transform="rotate(-90 70 70)">
                {byStatus.map((d) => {
                  const frac = statusTotal > 0 ? d.count / statusTotal : 0;
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
              <div className="text-[20px] font-bold text-ink">{statusTotal}</div>
              <div className="mono-cap text-[8.5px] text-hint">TOTAL</div>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            {byStatus.map((d) => (
              <div key={d.key} className="flex items-center gap-2 text-[12px]">
                <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: d.hex }} />
                <span className="min-w-0 flex-1 truncate text-ink2">{d.label}</span>
                <span className="font-bold text-ink">{d.count}</span>
                <span className="w-9 text-right font-mono text-[10px] text-mute">{statusTotal > 0 ? Math.round((d.count / statusTotal) * 100) : 0}%</span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* 3 — Placement breakdown (degrades when all null) */}
      <Card title="Placement breakdown" subtitle="LEARNERS · BY PLACEMENT STATUS">
        {placementTotal === 0 ? (
          <div className="flex h-[180px] flex-col items-center justify-center gap-2 text-center">
            <Icon name="info" size={22} strokeWidth={1.8} className="text-hint" />
            <div className="text-[13px] font-semibold text-ink2">Not available yet</div>
            <div className="max-w-[280px] text-[11.5px] text-mute">
              No learner has a placement status recorded yet. This chart lights up as the learner profile’s placement field is filled in.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {byPlacement.map((d) => {
              const pct = (d.count / Math.max(1, ...byPlacement.map((x) => x.count))) * 100;
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
        )}
      </Card>

      {/* 4 — Batches per learner */}
      <Card title="Batches per learner" subtitle="LEARNERS · BY ACTIVE BATCH COUNT">
        <div className="flex h-[180px] items-end gap-4 border-b border-rule">
          {batchBuckets.map((b) => (
            <div key={b.label} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
              <div className="font-mono text-[10px] text-mute">{b.count}</div>
              <div
                className="w-full rounded-t-[4px]"
                style={{ height: `${Math.max(4, (b.count / maxBatch) * 140)}px`, background: "linear-gradient(180deg,#6B1FB8,#6B1FB8cc)", opacity: b.count === 0 ? 0.25 : 1 }}
                title={`${b.count} learner${b.count === 1 ? "" : "s"}`}
              />
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between">
          {batchBuckets.map((b) => (
            <span key={b.label} className="mono-cap flex-1 text-center text-[9px] text-hint">{b.label} batch{b.label === "1" ? "" : "es"}</span>
          ))}
        </div>
      </Card>
    </div>
  );
}
