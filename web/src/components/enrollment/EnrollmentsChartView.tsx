"use client";

// Enrollments > Chart. Pure SVG/CSS, mirroring LeadsChartView's card chrome.
//   1 — Collections by week (bar): fees collected, bucketed by the enrolment's
//       registration week. Best-effort — the API carries a running fee_paid
//       total, not per-instalment payment dates, so this attributes each
//       enrolment's collected fee to the week it was registered.
//   2 — Payment-health donut: counts by health band.
//   3 — Enrollments by family (bar).
//   4 — Time-to-batch: omitted with a note — the row shape doesn't carry the
//       batch-assignment timestamp needed to measure it.

import { useMemo } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import type { Enrollment, PaymentHealth } from "@/lib/types";

export type EnrollChartRange = "30d" | "90d" | "all";
export const ENROLL_CHART_RANGES: Array<{ value: EnrollChartRange; label: string }> = [
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

const istDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
});
const DAY_MS = 86_400_000;
function istDayStart(d: Date): number { return Date.parse(istDayFmt.format(d)); }
function istWeekStart(d: Date): number {
  const day = istDayStart(d);
  const dow = (new Date(day).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return day - dow * DAY_MS;
}

function fmtINR(n: number): string {
  if (!n) return "₹0";
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(2).replace(/\.?0+$/, "")}Cr`;
  if (n >= 1_00_000)    return `₹${(n / 1_00_000).toFixed(2).replace(/\.?0+$/, "")}L`;
  if (n >= 1_000)       return `₹${Math.round(n / 1_000)}k`;
  return `₹${Math.round(n)}`;
}

const HEALTH_META: Record<PaymentHealth, { label: string; hex: string }> = {
  paid_in_full: { label: "Paid in full", hex: "#2E9E6A" },
  on_track:     { label: "On track",     hex: "#1F3FCF" },
  due_soon:     { label: "Due soon",      hex: "#E08A1E" },
  overdue:      { label: "Overdue",       hex: "#D9534F" },
  critical:     { label: "Critical",      hex: "#C7197A" },
};
const HEALTH_ORDER: PaymentHealth[] = ["paid_in_full", "on_track", "due_soon", "overdue", "critical"];
const FAMILY_PALETTE = ["#6B1FB8", "#C7197A", "#1F3FCF", "#2E9E6A", "#E08A1E", "#A89DAC"];

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

export function EnrollmentsChartView({ rows, range }: { rows: Enrollment[]; range: EnrollChartRange }) {
  const scoped = useMemo(() => {
    const now = new Date();
    const floor = range === "30d" ? istDayStart(now) - 30 * DAY_MS
      : range === "90d" ? istDayStart(now) - 90 * DAY_MS
      : null;
    if (floor === null) return rows;
    return rows.filter((e) => {
      const ref = e.registeredDate ?? e.createdAt;
      if (!ref) return false;
      const t = Date.parse(ref);
      return Number.isFinite(t) && istDayStart(new Date(t)) >= floor;
    });
  }, [rows, range]);

  const weekly = useMemo(() => {
    const thisWeek = istWeekStart(new Date());
    const starts = Array.from({ length: 8 }, (_, i) => thisWeek - (7 - i) * 7 * DAY_MS);
    const sums = starts.map(() => 0);
    for (const e of scoped) {
      const ref = e.registeredDate ?? e.createdAt;
      if (!ref) continue;
      const t = Date.parse(ref);
      if (!Number.isFinite(t)) continue;
      const idx = starts.indexOf(istWeekStart(new Date(t)));
      if (idx >= 0) sums[idx] += e.feePaid ? Number(e.feePaid) : 0;
    }
    return sums;
  }, [scoped]);

  const byHealth = useMemo(() => {
    return HEALTH_ORDER.map((h) => ({
      key: h,
      label: HEALTH_META[h].label,
      hex: HEALTH_META[h].hex,
      count: scoped.filter((e) => e.paymentHealth === h).length,
    })).filter((d) => d.count > 0);
  }, [scoped]);

  const byFamily = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of scoped) {
      const k = e.family || "TBD";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, count], i) => ({ label, count, hex: FAMILY_PALETTE[i % FAMILY_PALETTE.length] }));
  }, [scoped]);

  if (scoped.length === 0) {
    return (
      <div className="rounded-[14px] border border-rule bg-paper p-12 text-center text-[13px] text-mute">
        No enrollments match the current filter.
      </div>
    );
  }

  const maxWeek = Math.max(1, ...weekly);
  const healthTotal = byHealth.reduce((s, d) => s + d.count, 0);
  const maxFamily = Math.max(1, ...byFamily.map((d) => d.count));

  // Donut geometry.
  const R = 54, C = 2 * Math.PI * R;
  let dashCursor = 0;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      {/* 1 — Collections by week */}
      <Card title="Collections by week" subtitle="FEES COLLECTED · BY REGISTRATION WEEK">
        <div className="flex h-[180px] items-end gap-2 border-b border-rule">
          {weekly.map((v, i) => (
            <div key={i} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
              <div className="font-mono text-[10px] text-mute">{fmtINR(v)}</div>
              <div
                className="w-full rounded-t-[4px]"
                style={{ height: `${Math.max(4, (v / maxWeek) * 140)}px`, background: "linear-gradient(180deg,#6B1FB8,#6B1FB8cc)", opacity: v === 0 ? 0.25 : 1 }}
                title={fmtINR(v)}
              />
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between">
          {weekly.map((_, i) => (
            <span key={i} className="mono-cap flex-1 text-center text-[9px] text-hint">W{i + 1}</span>
          ))}
        </div>
      </Card>

      {/* 2 — Payment health */}
      <Card title="Payment health" subtitle="ENROLLMENTS · BY HEALTH BAND">
        <div className="flex items-center gap-6">
          <div className="relative h-[140px] w-[140px] flex-shrink-0">
            <svg viewBox="0 0 140 140" className="h-full w-full">
              <g transform="rotate(-90 70 70)">
                {byHealth.map((d) => {
                  const frac = healthTotal > 0 ? d.count / healthTotal : 0;
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
              <div className="text-[20px] font-bold text-ink">{healthTotal}</div>
              <div className="mono-cap text-[8.5px] text-hint">TOTAL</div>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            {byHealth.map((d) => (
              <div key={d.key} className="flex items-center gap-2 text-[12px]">
                <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: d.hex }} />
                <span className="min-w-0 flex-1 truncate text-ink2">{d.label}</span>
                <span className="font-bold text-ink">{d.count}</span>
                <span className="w-9 text-right font-mono text-[10px] text-mute">{healthTotal > 0 ? Math.round((d.count / healthTotal) * 100) : 0}%</span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* 3 — Enrollments by family */}
      <Card title="Enrollments by family" subtitle="HEADCOUNT · BY FAMILY">
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

      {/* 4 — Time-to-batch (unavailable) */}
      <Card title="Time to batch" subtitle="AVG DAYS · ENROLLED → BATCHED">
        <div className="flex h-[180px] flex-col items-center justify-center gap-2 text-center">
          <Icon name="info" size={22} strokeWidth={1.8} className="text-hint" />
          <div className="text-[13px] font-semibold text-ink2">Not available yet</div>
          <div className="max-w-[280px] text-[11.5px] text-mute">
            Measuring time-to-batch needs the batch-assignment timestamp per learner, which this list doesn’t carry. It’ll light up once the enrolment row exposes it.
          </div>
        </div>
      </Card>
    </div>
  );
}
