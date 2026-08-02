"use client";

// Enrollments > Kanban. Cards grouped by the chosen axis (status default,
// advisor, family, program). Read-only columns — a status change on an enrolment
// has side effects (batch/fee state) that don't belong in a drag gesture, so the
// board surfaces the grouping without letting you mutate it here.

import Link from "next/link";
import { cn } from "@/lib/cn";
import { avatarGradClass, gradFor, initialsOf, shortName } from "@/lib/ui";
import type { Enrollment } from "@/lib/types";
import { PaymentHealthBadge } from "./PaymentHealthBadge";

export type EnrollGroupBy = "status" | "advisor" | "family" | "program";

export const ENROLL_GROUP_BY_OPTIONS: { value: EnrollGroupBy; label: string }[] = [
  { value: "status",  label: "Status" },
  { value: "advisor", label: "Advisor" },
  { value: "family",   label: "Family" },
  { value: "program", label: "Program" },
];

export function enrollGroupKey(e: Enrollment, by: EnrollGroupBy): string {
  if (by === "status")  return e.statusLabel || "—";
  if (by === "advisor") return e.advisorName || "Unassigned";
  if (by === "family")   return e.family   || "TBD";
  if (by === "program") return e.programName || "—";
  return "—";
}

// Canonical order for the status axis so the columns read as a lifecycle
// rather than an alphabetised jumble.
const STATUS_LABEL_ORDER = [
  "In Training", "Batched", "Active", "Pending", "On hold", "Completed", "Dropped", "Deferred",
];

const PALETTE = [
  { dot: "bg-brand-violet",  hex: "#6B1FB8" },
  { dot: "bg-brand-magenta", hex: "#C7197A" },
  { dot: "bg-brand-blue",    hex: "#1F3FCF" },
  { dot: "bg-state-ok",      hex: "#2E9E6A" },
  { dot: "bg-state-amber",   hex: "#E08A1E" },
  { dot: "bg-mute",          hex: "#A89DAC" },
];
function paletteFor(key: string) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

function fmtDue(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}
function fmtINR(n: number): string {
  if (!n) return "₹0";
  if (n >= 1_00_000) return `₹${(n / 1_00_000).toFixed(2).replace(/\.?0+$/, "")}L`;
  if (n >= 1_000)    return `₹${Math.round(n / 1_000)}k`;
  return `₹${Math.round(n)}`;
}

export function EnrollmentsKanban({ rows, groupBy }: { rows: Enrollment[]; groupBy: EnrollGroupBy }) {
  const byColumn = new Map<string, Enrollment[]>();
  for (const e of rows) {
    const k = enrollGroupKey(e, groupBy);
    const arr = byColumn.get(k);
    if (arr) arr.push(e); else byColumn.set(k, [e]);
  }

  let keys = [...byColumn.keys()];
  if (groupBy === "status") {
    keys.sort((a, b) => {
      const ia = STATUS_LABEL_ORDER.indexOf(a);
      const ib = STATUS_LABEL_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  } else {
    keys.sort((a, b) => (byColumn.get(b)?.length ?? 0) - (byColumn.get(a)?.length ?? 0));
  }

  if (keys.length === 0) {
    return (
      <div className="rounded-2xl border border-rule bg-paper p-12 text-center text-[13px] text-mute">
        No enrollments match the current filter.
      </div>
    );
  }

  return (
    <div
      className="grid items-start gap-3.5 overflow-x-auto pb-2"
      style={{ gridTemplateColumns: `repeat(${keys.length}, minmax(258px, 1fr))` }}
    >
      {keys.map((key) => {
        const colRows = byColumn.get(key) ?? [];
        const palette = paletteFor(key);
        const dueSum = colRows.reduce((s, e) => s + (e.feeDue ? Number(e.feeDue) : 0), 0);
        return (
          <div key={key} className="flex flex-col rounded-2xl border border-rule bg-warm" style={{ maxHeight: "calc(100vh - 320px)" }}>
            <div className="flex items-center gap-[9px] p-[14px_16px_12px]">
              <span className={cn("h-[9px] w-[9px] flex-shrink-0 rounded-full", palette.dot)} />
              <span className="truncate text-[13.5px] font-bold tracking-[-.01em]" title={key}>{key}</span>
              <span className="rounded-full border border-rule bg-warm2 px-2 py-0.5 font-mono text-[10px] font-semibold text-mute">
                {colRows.length}
              </span>
              <span className="ml-auto font-mono text-[10px] tracking-[.04em] text-mute" title="Fee due in this column">
                {fmtINR(dueSum)} due
              </span>
            </div>

            <div className="flex flex-col gap-2.5 overflow-y-auto px-3 pb-3">
              {colRows.map((e) => {
                const quoted = e.feeQuoted ? Number(e.feeQuoted) : 0;
                const pct = e.paidPct ?? (quoted > 0 ? Math.round(((e.feePaid ? Number(e.feePaid) : 0) / quoted) * 100) : 0);
                const due = e.feeDue ? Number(e.feeDue) : 0;
                return (
                  <Link
                    key={e.id}
                    href={`/enrollments/${encodeURIComponent(e.number ?? e.id)}`}
                    className="group block rounded-[13px] border border-rule bg-paper p-3.5 transition hover:-translate-y-0.5 hover:border-rule2 hover:shadow-card"
                  >
                    <div className="mb-2.5 flex items-center gap-2.5">
                      <div className={cn("flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white", avatarGradClass[gradFor(e.name)])}>
                        {initialsOf(e.name)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-semibold tracking-[-.005em]">{e.name}</div>
                        <div className="mt-px font-mono text-[9px] tracking-[.04em] text-mute">{e.number ?? "—"}</div>
                      </div>
                      <span className="font-mono text-[11px] font-semibold text-ink2">{pct}%</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[12px] font-medium text-ink2">{e.programName ?? "—"}</span>
                      {e.batchCode ? (
                        <span className="mono-cap rounded-full bg-warm2 px-1.5 py-0.5 text-[9px] font-semibold tracking-[.04em] text-ink2">{e.batchCode}</span>
                      ) : (
                        <span className="mono-cap rounded-full border border-dashed border-rule2 px-1.5 py-0.5 text-[9px] font-semibold tracking-[.04em] text-hint">+ Assign</span>
                      )}
                    </div>

                    {/* Paid progress bar */}
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-warm2">
                      <div className="h-full rounded-full bg-grad" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
                    </div>

                    <div className="mt-[11px] flex items-center gap-2 border-t border-dashed border-rule pt-2.5 text-[11.5px] text-ink2">
                      <PaymentHealthBadge health={e.paymentHealth} />
                      <span className="font-mono text-[10.5px] text-mute">
                        {due > 0 ? `${fmtINR(due)} due · ${fmtDue(e.dueDate)}` : "Paid up"}
                      </span>
                      {e.advisorName && (
                        <span className="ml-auto flex items-center gap-1.5" title={e.advisorName}>
                          <span className={cn("flex h-[18px] w-[18px] items-center justify-center rounded-full text-[8px] font-bold text-white", avatarGradClass[gradFor(e.advisorName)])}>
                            {initialsOf(e.advisorName)}
                          </span>
                          <span className="hidden text-[10.5px] text-mute sm:inline">{shortName(e.advisorName)}</span>
                        </span>
                      )}
                    </div>
                  </Link>
                );
              })}
              {colRows.length === 0 && (
                <div className="rounded-[11px] border border-dashed border-rule2 p-4 text-center text-[11.5px] text-mute">
                  Empty.
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
