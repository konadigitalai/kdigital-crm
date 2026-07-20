"use client";

// Learners > Kanban. Cards grouped by the chosen axis (status default, program,
// stack, advisor). Read-only columns — a learner's batch/course state is
// mutated on the record page, not by a drag gesture here, so the board surfaces
// the grouping without letting you change it. Mirrors EnrollmentsKanban.

import Link from "next/link";
import { cn } from "@/lib/cn";
import { avatarGradClass, gradFor, initialsOf, shortName } from "@/lib/ui";
import type { LearnerSummary } from "@/lib/types";

export type LearnerGroupBy = "status" | "program" | "stack" | "advisor";

export const LEARNER_GROUP_BY_OPTIONS: { value: LearnerGroupBy; label: string }[] = [
  { value: "status",  label: "Status" },
  { value: "program", label: "Program" },
  { value: "stack",   label: "Stack" },
  { value: "advisor", label: "Advisor" },
];

export function learnerGroupKey(l: LearnerSummary, by: LearnerGroupBy): string {
  if (by === "status")  return l.status || "—";
  if (by === "program") return l.programName || "—";
  if (by === "stack")   return l.stackName   || "TBD";
  if (by === "advisor") return l.advisorName || "Unassigned";
  return "—";
}

// Canonical order for the status axis so the columns read as a lifecycle
// rather than an alphabetised jumble.
const STATUS_LABEL_ORDER = ["In batch", "Assigned", "Enrolled"];

const STATUS_CLS: Record<string, string> = {
  "In batch": "bg-[rgba(46,158,106,.10)] text-state-ok",
  "Assigned": "bg-[rgba(31,63,207,.10)]  text-brand-blue",
  "Enrolled": "bg-warm2                  text-mute",
};

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

export function LearnersKanban({ rows, groupBy }: { rows: LearnerSummary[]; groupBy: LearnerGroupBy }) {
  const byColumn = new Map<string, LearnerSummary[]>();
  for (const l of rows) {
    const k = learnerGroupKey(l, groupBy);
    const arr = byColumn.get(k);
    if (arr) arr.push(l); else byColumn.set(k, [l]);
  }

  const keys = [...byColumn.keys()];
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
        No learners match the current filter.
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
        const inBatch = colRows.filter((l) => l.activeBatches > 0).length;
        return (
          <div key={key} className="flex flex-col rounded-2xl border border-rule bg-warm" style={{ maxHeight: "calc(100vh - 320px)" }}>
            <div className="flex items-center gap-[9px] p-[14px_16px_12px]">
              <span className={cn("h-[9px] w-[9px] flex-shrink-0 rounded-full", palette.dot)} />
              <span className="truncate text-[13.5px] font-bold tracking-[-.01em]" title={key}>{key}</span>
              <span className="rounded-full border border-rule bg-warm2 px-2 py-0.5 font-mono text-[10px] font-semibold text-mute">
                {colRows.length}
              </span>
              <span className="ml-auto font-mono text-[10px] tracking-[.04em] text-mute" title="Learners in an active batch">
                {inBatch} in batch
              </span>
            </div>

            <div className="flex flex-col gap-2.5 overflow-y-auto px-3 pb-3">
              {colRows.map((l) => (
                <Link
                  key={l.partyId}
                  href={`/learners/${l.partyId}`}
                  className="group block rounded-[13px] border border-rule bg-paper p-3.5 transition hover:-translate-y-0.5 hover:border-rule2 hover:shadow-card"
                >
                  <div className="mb-2.5 flex items-center gap-2.5">
                    <div className={cn("flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white", avatarGradClass[gradFor(l.name)])}>
                      {initialsOf(l.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-semibold tracking-[-.005em]">{l.name}</div>
                      <div className="mt-px truncate text-[10px] text-mute">{l.email ?? "—"}</div>
                    </div>
                    <span className={cn("mono-cap inline-flex items-center rounded-full px-2 py-0.5 text-[8.5px] font-semibold", STATUS_CLS[l.status] ?? "bg-warm2 text-mute")}>
                      {l.status}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[12px] font-medium text-ink2">{l.programName ?? "—"}</span>
                    {l.batchCode ? (
                      <span className="mono-cap rounded-full bg-warm2 px-1.5 py-0.5 text-[9px] font-semibold tracking-[.04em] text-ink2">{l.batchCode}</span>
                    ) : (
                      <span className="mono-cap rounded-full border border-dashed border-rule2 px-1.5 py-0.5 text-[9px] font-semibold tracking-[.04em] text-hint">Not batched</span>
                    )}
                  </div>

                  {l.courseModules.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {l.courseModules.slice(0, 3).map((m) => (
                        <span key={m} className="mono-cap rounded-full bg-warm2 px-1.5 py-0.5 text-[8.5px] font-semibold tracking-[.04em] text-ink2">{m}</span>
                      ))}
                      {l.courseModules.length > 3 && (
                        <span className="mono-cap px-1 text-[8.5px] font-semibold text-hint">+{l.courseModules.length - 3}</span>
                      )}
                    </div>
                  )}

                  <div className="mt-[11px] flex items-center gap-2 border-t border-dashed border-rule pt-2.5 text-[11.5px] text-ink2">
                    <span className="font-mono text-[10.5px] text-mute">
                      {l.activeCourses}/{l.totalCourses} courses · {l.activeBatches}/{l.totalBatches} batches
                    </span>
                    {l.advisorName && (
                      <span className="ml-auto flex items-center gap-1.5" title={l.advisorName}>
                        <span className={cn("flex h-[18px] w-[18px] items-center justify-center rounded-full text-[8px] font-bold text-white", avatarGradClass[gradFor(l.advisorName)])}>
                          {initialsOf(l.advisorName)}
                        </span>
                        <span className="hidden text-[10.5px] text-mute sm:inline">{shortName(l.advisorName)}</span>
                      </span>
                    )}
                  </div>
                </Link>
              ))}
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
