"use client";

import { useMemo } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";
import { LEAD_STATUS_OPTIONS } from "@/components/pipeline/PipelineListView";
import { ratingStyles } from "@/lib/ui";
import { cn } from "@/lib/cn";
import { LEAD_RATINGS, type Lead, type LeadRating } from "@/lib/types";

// ─── money ────────────────────────────────────────────────────────────────
//
// The ₹ fields reach us as strings in two different shapes and we have to cope
// with both:
//   - `lead.value` is a text column. PATCH /leads validates it as a bare number
//     ("15000"), which is what every real row holds — but the seeded/demo rows
//     carry the display form ("₹1.49L"), and PipelineBoard's parser only ever
//     handled the latter. A parser that accepts only "₹1.49L" silently scores
//     every genuine lead as zero, which is how "Pipeline ₹" came to read ₹0
//     across the board.
//   - `fee_paid` / `fee_due` are numeric columns; pg hands them back as plain
//     decimal strings ("15000.00").
//
// Returns null — not 0 — when there's nothing there, because "no price quoted"
// and "quoted at zero" are different facts, and averaging must not count the
// former in its denominator.
function parseMoney(s: string | number | null | undefined): number | null {
  if (s === null || s === undefined || s === "") return null;
  if (typeof s === "number") return Number.isFinite(s) ? s : null;

  const raw = s.trim();
  if (!raw) return null;

  const suffixed = raw.match(/^₹?\s*([\d.]+)\s*(Cr|L|k)$/i);
  if (suffixed) {
    const n = Number(suffixed[1]);
    if (!Number.isFinite(n)) return null;
    const unit = suffixed[2].toLowerCase();
    if (unit === "cr") return n * 1_00_00_000;
    if (unit === "l")  return n * 1_00_000;
    return n * 1_000;
  }

  // Bare number, with or without a ₹ and thousands separators: "15000",
  // "₹15,000", "15000.00".
  const plain = Number(raw.replace(/[₹,\s]/g, ""));
  return Number.isFinite(plain) ? plain : null;
}

function fmtINR(n: number): string {
  if (!n) return "—";
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(1).replace(/\.0$/, "")}Cr`;
  if (n >= 1_00_000)    return `₹${Math.round(n / 1_00_000)}L`;
  if (n >= 1_000)       return `₹${Math.round(n / 1_000)}k`;
  return `₹${Math.round(n)}`;
}

// ─── IST date math ────────────────────────────────────────────────────────
// Every bucket boundary below (week starts, quarter starts) is resolved in IST,
// never in the runtime's local zone. This view server-renders and then hydrates:
// the server runs in UTC and the browser in IST, so a local-zone week boundary
// would put a lead in W6 on the server and W7 in the browser and mismatch.

const istDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
});

/** Midnight-in-IST for a given instant, as a UTC epoch — safe to subtract. */
function istDayStart(d: Date): number {
  // en-CA gives an ISO-shaped "YYYY-MM-DD", which Date.parse reads as UTC
  // midnight. Two of these subtract to a whole number of days.
  return Date.parse(istDayFmt.format(d));
}

const DAY_MS = 86_400_000;

/** Monday-midnight-IST of the week containing `d`, as a UTC epoch. */
function istWeekStart(d: Date): number {
  const day = istDayStart(d);
  // getUTCDay is safe here precisely because istDayStart already normalised the
  // instant to a UTC-midnight stamp of the IST calendar date.
  const dow = (new Date(day).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return day - dow * DAY_MS;
}

/** Start of the calendar quarter containing `d`, in IST, as a UTC epoch. */
function istQuarterStart(d: Date): number {
  const [y, m] = istDayFmt.format(d).split("-").map(Number);
  const qMonth = Math.floor((m - 1) / 3) * 3 + 1;
  return Date.parse(`${y}-${String(qMonth).padStart(2, "0")}-01`);
}

// ─── palettes ─────────────────────────────────────────────────────────────

const ratingHex: Record<LeadRating, string> = {
  "new lead": "#1F3FCF",
  attempted:  "#6B1FB8",
  cold:       "#A89DAC",
  lukewarm:   "#E7B15E",
  warm:       "#E08A1E",
  hot:        "#C7197A",
  superhot:   "#C7197A",
  enrolled:   "#2E9E6A",
};

const PALETTE = ["#6B1FB8", "#C7197A", "#1F3FCF", "#A89DAC", "#2E9E6A", "#E08A1E"];

const VIOLET = "#6B1FB8";

// Canonical funnel order for the status axis. LEAD_STATUS_OPTIONS carries the
// labels but is ordered for a <select>, not for a funnel read-out.
const STATUS_ORDER = [
  "new", "contacted", "interested", "interested_in_demo",
  "advance_talk_with_trainer", "demo_attended", "visiting", "visited",
  "payment_link_sent", "enrolled", "lost_lead", "unqualified",
] as const;

const STATUS_LABEL: Record<string, string> = Object.fromEntries(
  LEAD_STATUS_OPTIONS.map((o) => [o.value, o.label]),
);

const CLOSED_STATUSES = new Set(["enrolled", "lost_lead", "unqualified"]);
const DEMO_STATUSES   = new Set(["demo_attended", "visiting", "visited", "payment_link_sent", "enrolled"]);
const VISIT_STATUSES  = new Set(["visited", "payment_link_sent", "enrolled"]);
const OFFER_STATUSES  = new Set(["payment_link_sent", "enrolled"]);

// ─── measures ─────────────────────────────────────────────────────────────
//
// A measure is "what the bars are made of". Two things vary, so both are part
// of the spec rather than hard-coded:
//
//   `of`   — what one lead contributes. Returning null means "this lead has
//            nothing to say about this measure": it's skipped entirely, so a
//            lead with no price quoted doesn't drag Avg deal size toward zero.
//   `agg`  — how the contributions combine. Count and the ₹ totals are sums;
//            averages need their own denominator, which a sum-only design
//            (the original `weigh` + reduce) simply couldn't express.
//
// Cards 3, 5 and 6 ignore the measure entirely and stay count-based — see the
// note at their aggregation sites.

export type LeadsChartMeasure =
  | "count" | "value" | "avgValue" | "feePaid" | "feeDue" | "avgScore";

export type LeadsChartRange = "30d" | "90d" | "quarter" | "all";

interface MeasureSpec {
  label: string;
  agg: "sum" | "avg";
  of: (l: Lead) => number | null;
  fmt: (n: number) => string;
}

const fmtCount = (n: number) => String(Math.round(n));

export const MEASURE_SPECS: Record<LeadsChartMeasure, MeasureSpec> = {
  count: {
    label: "Lead count",
    agg: "sum",
    of: () => 1,
    fmt: fmtCount,
  },
  value: {
    label: "Pipeline ₹",
    agg: "sum",
    of: (l) => parseMoney(l.value),
    fmt: fmtINR,
  },
  avgValue: {
    label: "Avg deal size",
    agg: "avg",
    of: (l) => parseMoney(l.value),
    fmt: fmtINR,
  },
  feePaid: {
    label: "Fee collected",
    agg: "sum",
    of: (l) => parseMoney(l.feePaid),
    fmt: fmtINR,
  },
  feeDue: {
    label: "Fee outstanding",
    agg: "sum",
    of: (l) => parseMoney(l.feeDue),
    fmt: fmtINR,
  },
  avgScore: {
    label: "Avg score",
    agg: "avg",
    of: (l) => (Number.isFinite(l.score) ? l.score : null),
    fmt: fmtCount,
  },
};

/** Drives the Measure pill in the toolbar, so the pill and the maths can't drift. */
export const LEADS_CHART_MEASURES = (
  Object.keys(MEASURE_SPECS) as LeadsChartMeasure[]
).map((value) => ({ value, label: MEASURE_SPECS[value].label }));

/** Collapse a bucket of leads to a single number under the given measure. */
function aggregate(rows: Lead[], spec: MeasureSpec): number {
  let total = 0;
  let n = 0;
  for (const l of rows) {
    const v = spec.of(l);
    if (v === null) continue;
    total += v;
    n += 1;
  }
  if (spec.agg === "sum") return total;
  return n === 0 ? 0 : total / n;
}

// ─── card chrome ──────────────────────────────────────────────────────────

function Card({
  title,
  subtitle,
  className,
  children,
}: {
  title: string;
  subtitle: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-[14px] border border-rule bg-paper p-[18px]", className)}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[14px] font-bold text-ink">{title}</div>
          <div className="mono-cap mt-0.5 text-[9px] tracking-[.1em] text-hint">{subtitle}</div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <CardAction icon="send" label={`Share ${title}`} />
          <CardAction icon="chevron-down" label={`More options for ${title}`} />
        </div>
      </div>
      {children}
    </div>
  );
}

// Decorative for now — the share / overflow menus aren't wired to anything yet,
// so these are inert buttons rather than fake affordances that throw.
function CardAction({ icon, label }: { icon: IconName; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {}}
      className="flex h-6 w-6 items-center justify-center rounded-md text-hint transition hover:bg-warm hover:text-ink"
    >
      <Icon name={icon} size={13} strokeWidth={2} />
    </button>
  );
}

// ─── component ────────────────────────────────────────────────────────────

export function LeadsChartView({
  leads,
  measure,
  advisorFilter,
  range,
}: {
  leads: Lead[];
  measure: LeadsChartMeasure;
  /** advisorName, or "all". */
  advisorFilter: string;
  range: LeadsChartRange;
}) {
  // One filter pass; every card below derives from `rows`.
  const rows = useMemo(() => {
    const now = new Date();
    const floor =
      range === "30d"     ? istDayStart(now) - 30 * DAY_MS
      : range === "90d"   ? istDayStart(now) - 90 * DAY_MS
      : range === "quarter" ? istQuarterStart(now)
      : null;

    return leads.filter((l) => {
      if (advisorFilter !== "all" && (l.advisorName ?? "") !== advisorFilter) return false;
      if (floor === null) return true;
      if (!l.createdAt) return false;
      const t = Date.parse(l.createdAt);
      return Number.isFinite(t) && istDayStart(new Date(t)) >= floor;
    });
  }, [leads, advisorFilter, range]);

  // `measure` scales cards 1, 2 and 4 only. Cards 3, 5 and 6 stay count-based
  // whatever the toggle says: "₹ arriving per week", a ₹-weighted source donut
  // and a ₹-weighted funnel all answer questions those cards aren't asking.
  const spec = MEASURE_SPECS[measure];
  const fmt = spec.fmt;
  // Cards 1/2/4 replot themselves under the active measure, so their subtitles
  // have to say so — a bar labelled "₹15k" under a caption reading "ALL LEADS"
  // is just a puzzle.
  const measureCap = spec.label.toUpperCase();

  const byRating = useMemo(() => {
    return LEAD_RATINGS.map((r) => {
      const inRating = rows.filter((l) => l.rating === r);
      return {
        key: r,
        label: ratingStyles[r].label,
        hex: ratingHex[r],
        count: inRating.length,
        amount: aggregate(inRating, spec),
      };
    }).filter((d) => d.count > 0);
  }, [rows, spec]);

  const byStatus = useMemo(() => {
    const present = STATUS_ORDER.filter((s) => rows.some((l) => l.leadStatus === s));
    return present.map((s) => {
      const inStatus = rows.filter((l) => l.leadStatus === s);
      return {
        key: s as string,
        label: STATUS_LABEL[s] ?? s,
        count: inStatus.length,
        amount: aggregate(inStatus, spec),
      };
    });
  }, [rows, spec]);

  const weekly = useMemo(() => {
    const thisWeek = istWeekStart(new Date());
    const starts = Array.from({ length: 8 }, (_, i) => thisWeek - (7 - i) * 7 * DAY_MS);
    const counts = starts.map(() => 0);
    for (const l of rows) {
      if (!l.createdAt) continue;
      const t = Date.parse(l.createdAt);
      if (!Number.isFinite(t)) continue;
      const ws = istWeekStart(new Date(t));
      const idx = starts.indexOf(ws);
      if (idx >= 0) counts[idx] += 1;
    }
    return counts;
  }, [rows]);

  const byAdvisor = useMemo(() => {
    const open = rows.filter((l) => !CLOSED_STATUSES.has(l.leadStatus ?? ""));
    const m = new Map<string, Lead[]>();
    for (const l of open) {
      const k = l.advisorName || "Unassigned";
      const bucket = m.get(k);
      if (bucket) bucket.push(l);
      else m.set(k, [l]);
    }
    return [...m.entries()]
      .map(([label, bucket]) => ({
        label,
        count: bucket.length,
        amount: aggregate(bucket, spec),
      }))
      // Sorted by the measure on screen, not always by headcount — under "Fee
      // outstanding" the advisor to look at first is the one carrying the most
      // unpaid fees, not the one with the longest list. For `count` the two are
      // the same thing, since `amount` is the headcount there.
      .sort((a, b) => b.amount - a.amount)
      .map((d, i) => ({ ...d, hex: PALETTE[i % PALETTE.length] }));
  }, [rows, spec]);

  const bySource = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of rows) {
      const k = l.sourceLabel ?? l.source ?? "Unknown";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count], i) => ({ label, count, hex: PALETTE[i % PALETTE.length] }));
  }, [rows]);

  const funnel = useMemo(() => {
    const has = (l: Lead, set: Set<string>) => set.has(l.leadStatus ?? "");
    // Each stage is defined as "reached this point OR anything downstream of it",
    // so the counts are monotonically non-increasing by construction — no clamp
    // is needed to keep the bars reading as a funnel.
    const captured = rows.length;
    const demo = rows.filter((l) => !!l.demoAttendedAt || has(l, DEMO_STATUSES)).length;
    const visit = rows.filter((l) => !!l.visitedDate || has(l, VISIT_STATUSES)).length;
    const offer = rows.filter((l) => has(l, OFFER_STATUSES)).length;
    const enrolled = rows.filter((l) => l.leadStatus === "enrolled" || l.rating === "enrolled").length;
    return [
      { label: "Leads captured", count: captured, hex: "#6B1FB8" },
      { label: "Demo attended",  count: demo,     hex: "#C7197A" },
      { label: "Campus visit",   count: visit,    hex: "#E08A1E" },
      { label: "Offer made",     count: offer,    hex: "#1F3FCF" },
      { label: "Enrolled",       count: enrolled, hex: "#2E9E6A" },
    ];
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="rounded-[14px] border border-rule bg-paper p-12 text-center text-[13px] text-mute">
        No leads match the current filter.
      </div>
    );
  }

  // `amount` already holds the aggregate for whichever measure is active — for
  // `count` it IS the headcount — so there's nothing left to branch on here.
  const val = (d: { count: number; amount: number }) => d.amount;

  const maxRating  = Math.max(1, ...byRating.map(val));
  const maxStatus  = Math.max(1, ...byStatus.map(val));
  const maxAdvisor = Math.max(1, ...byAdvisor.map(val));
  const maxWeek    = Math.max(1, ...weekly);
  const sourceTotal = bySource.reduce((s, d) => s + d.count, 0);
  const funnelTop  = Math.max(1, funnel[0].count);

  // Card 3 geometry — a plain polyline over an 8-point series.
  const W = 300, H = 132, PAD_X = 8, PAD_TOP = 10, PAD_BOT = 8;
  const px = (i: number) => PAD_X + (i * (W - PAD_X * 2)) / 7;
  const py = (v: number) => PAD_TOP + (1 - v / maxWeek) * (H - PAD_TOP - PAD_BOT);
  const points = weekly.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  const areaPath = `M ${px(0)},${H} L ${points.split(" ").join(" L ")} L ${px(7)},${H} Z`;

  // Card 5 geometry — dasharray arcs on a single r=54 circle.
  const R = 54, C = 2 * Math.PI * R;
  let dashCursor = 0;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-4">
      {/* 1 — Leads by rating */}
      <Card title="Leads by rating" subtitle={`${measureCap} · GROUPED BY RATING`}>
        <div className="flex h-[170px] items-end gap-2 border-b border-rule">
          {byRating.map((d) => (
            <div key={d.key} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
              <div className="text-[11px] font-bold text-ink">{fmt(val(d))}</div>
              <div
                className="w-full rounded-t-[4px]"
                style={{
                  height: `${Math.max(4, (val(d) / maxRating) * 132)}px`,
                  background: d.hex,
                }}
                title={`${d.label}: ${fmt(val(d))}`}
              />
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          {byRating.map((d) => (
            <div key={d.key} className="min-w-0 flex-1 text-center text-[10px] leading-tight text-mute">
              {d.label}
            </div>
          ))}
        </div>
      </Card>

      {/* 2 — Pipeline stages */}
      <Card title="Pipeline stages" subtitle={`${measureCap} · BY STATUS`}>
        <div className="flex flex-col gap-2">
          {byStatus.map((d) => {
            const pct = (val(d) / maxStatus) * 100;
            const inside = pct >= 12;
            return (
              <div key={d.key} className="flex items-center gap-2.5">
                <div className="w-[130px] flex-shrink-0 truncate text-[12px] text-ink2" title={d.label}>
                  {d.label}
                </div>
                <div className="relative flex-1">
                  <div className="h-6 rounded-md bg-warm2/60" />
                  <div
                    className="absolute inset-y-0 left-0 flex items-center justify-end rounded-md pr-2"
                    style={{ width: `${Math.max(2, pct)}%`, background: VIOLET }}
                  >
                    {inside && <span className="text-[11px] font-bold text-white">{fmt(val(d))}</span>}
                  </div>
                  {!inside && (
                    <span
                      className="absolute inset-y-0 flex items-center pl-1.5 text-[11px] font-bold text-ink2"
                      style={{ left: `${Math.max(2, pct)}%` }}
                    >
                      {fmt(val(d))}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* 3 — Leads over time */}
      <Card title="Leads over time" subtitle="NEW LEADS · LAST 8 WEEKS">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-[170px] w-full" preserveAspectRatio="none">
          <defs>
            <linearGradient id="leads-over-time-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="rgba(107,31,184,.25)" />
              <stop offset="1" stopColor="rgba(107,31,184,0)" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill="url(#leads-over-time-fill)" />
          <polyline points={points} fill="none" stroke={VIOLET} strokeWidth={1.5} />
          {weekly.map((v, i) => (
            <circle key={i} cx={px(i)} cy={py(v)} r={2.5} fill="#fff" stroke={VIOLET} strokeWidth={1.5} />
          ))}
        </svg>
        <div className="mt-2 flex justify-between">
          {weekly.map((v, i) => (
            <span key={i} className="mono-cap text-[9px] text-hint" title={`${v} lead${v === 1 ? "" : "s"}`}>
              W{i + 1}
            </span>
          ))}
        </div>
      </Card>

      {/* 4 — Advisor workload */}
      <Card title="Advisor workload" subtitle={`${measureCap} · OPEN LEADS PER ADVISOR`}>
        <div className="flex flex-col gap-2">
          {byAdvisor.map((d) => {
            const pct = (val(d) / maxAdvisor) * 100;
            const inside = pct >= 12;
            return (
              <div key={d.label} className="flex items-center gap-2.5">
                <div className="w-[110px] flex-shrink-0 truncate text-[12px] text-ink2" title={d.label}>
                  {d.label}
                </div>
                <div className="relative flex-1">
                  <div className="h-6 rounded-md bg-warm2/60" />
                  <div
                    className="absolute inset-y-0 left-0 flex items-center justify-end rounded-md pr-2"
                    style={{ width: `${Math.max(2, pct)}%`, background: d.hex }}
                  >
                    {inside && <span className="text-[11px] font-bold text-white">{fmt(val(d))}</span>}
                  </div>
                  {!inside && (
                    <span
                      className="absolute inset-y-0 flex items-center pl-1.5 text-[11px] font-bold text-ink2"
                      style={{ left: `${Math.max(2, pct)}%` }}
                    >
                      {fmt(val(d))}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {byAdvisor.length === 0 && (
            <div className="py-6 text-center text-[12px] text-mute">No open leads.</div>
          )}
        </div>
      </Card>

      {/* 5 — Lead sources */}
      <Card title="Lead sources" subtitle="ALL LEADS · BY SOURCE" className="xl:col-span-2">
        <div className="flex items-center gap-6">
          <div className="relative h-[140px] w-[140px] flex-shrink-0">
            <svg viewBox="0 0 140 140" className="h-full w-full">
              <g transform="rotate(-90 70 70)">
                {bySource.map((d) => {
                  const frac = sourceTotal > 0 ? d.count / sourceTotal : 0;
                  const dash = frac * C;
                  const offset = -dashCursor;
                  dashCursor += dash;
                  return (
                    <circle
                      key={d.label}
                      cx={70}
                      cy={70}
                      r={R}
                      fill="none"
                      stroke={d.hex}
                      strokeWidth={18}
                      strokeDasharray={`${dash} ${C - dash}`}
                      strokeDashoffset={offset}
                    />
                  );
                })}
              </g>
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <div className="text-[20px] font-bold text-ink">{sourceTotal}</div>
              <div className="mono-cap text-[8.5px] text-hint">LEADS</div>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            {bySource.map((d) => (
              <div key={d.label} className="flex items-center gap-2 text-[12px]">
                <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: d.hex }} />
                <span className="min-w-0 flex-1 truncate text-ink2" title={d.label}>{d.label}</span>
                <span className="font-bold text-ink">{d.count}</span>
                <span className="w-9 text-right font-mono text-[10px] text-mute">
                  {sourceTotal > 0 ? Math.round((d.count / sourceTotal) * 100) : 0}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* 6 — Conversion funnel */}
      <Card title="Conversion funnel" subtitle="LEAD → ENROLLED · THIS QUARTER" className="xl:col-span-2">
        <div className="flex flex-col gap-2">
          {funnel.map((d) => {
            const pct = (d.count / funnelTop) * 100;
            const inside = pct >= 12;
            return (
              <div key={d.label} className="flex items-center gap-2.5">
                <div className="w-[110px] flex-shrink-0 truncate text-[12px] text-ink2">{d.label}</div>
                <div className="relative flex-1">
                  <div className="h-7 rounded-md bg-warm2/60" />
                  <div
                    className="absolute inset-y-0 left-0 flex items-center justify-end rounded-md pr-2.5"
                    style={{ width: `${Math.max(2, pct)}%`, background: d.hex }}
                  >
                    {inside && <span className="text-[11px] font-bold text-white">{d.count}</span>}
                  </div>
                  {!inside && (
                    <span
                      className="absolute inset-y-0 flex items-center pl-1.5 text-[11px] font-bold text-ink2"
                      style={{ left: `${Math.max(2, pct)}%` }}
                    >
                      {d.count}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
