"use client";

// Batches > Kanban. Cards grouped by the chosen axis (status default, stack,
// slot, trainer). Read-only columns — a batch's fields are edited in the admin
// CRUD (Admin · Batches), not by a drag gesture here, so the board surfaces the
// grouping without letting you change it. Mirrors LearnersKanban.

import Link from "next/link";
import { cn } from "@/lib/cn";
import { avatarGradClass, gradFor, initialsOf, shortName } from "@/lib/ui";
import type { BatchBoardRow } from "@/lib/types";
import { BATCH_STATUS_CLS as STATUS_CLS } from "@/lib/batchStatus";

export type BatchGroupBy = "status" | "stack" | "slot" | "trainer";

export const BATCH_GROUP_BY_OPTIONS: { value: BatchGroupBy; label: string }[] = [
  { value: "status",  label: "Status" },
  { value: "stack",   label: "Stack" },
  { value: "slot",    label: "Slot" },
  { value: "trainer", label: "Trainer" },
];

function slotTitle(slot: string | null): string | null {
  if (!slot) return null;
  return slot[0]!.toUpperCase() + slot.slice(1);
}

export function batchGroupKey(b: BatchBoardRow, by: BatchGroupBy): string {
  if (by === "status")  return b.status;
  if (by === "stack")   return b.stackName || "No stack";
  if (by === "slot")    return slotTitle(b.slot) || "No slot";
  if (by === "trainer") return b.trainerName || "Not assigned";
  return "—";
}

// Canonical order for the status axis so the columns read as a lifecycle
// rather than an alphabetised jumble.
const STATUS_ORDER = ["upcoming", "running", "completed", "cancelled"];


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

function pct(v: number | null): string {
  return v == null ? "—" : `${v}%`;
}

export function BatchesKanban({ rows, groupBy }: { rows: BatchBoardRow[]; groupBy: BatchGroupBy }) {
  const byColumn = new Map<string, BatchBoardRow[]>();
  for (const b of rows) {
    const k = batchGroupKey(b, groupBy);
    const arr = byColumn.get(k);
    if (arr) arr.push(b); else byColumn.set(k, [b]);
  }

  const keys = [...byColumn.keys()];
  if (groupBy === "status") {
    keys.sort((a, b) => {
      const ia = STATUS_ORDER.indexOf(a);
      const ib = STATUS_ORDER.indexOf(b);
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
        No batches match the current filter.
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
        const active = colRows.reduce((s, b) => s + b.activeCount, 0);
        return (
          <div key={key} className="flex flex-col rounded-2xl border border-rule bg-warm" style={{ maxHeight: "calc(100vh - 320px)" }}>
            <div className="flex items-center gap-[9px] p-[14px_16px_12px]">
              <span className={cn("h-[9px] w-[9px] flex-shrink-0 rounded-full", palette.dot)} />
              <span className="truncate text-[13.5px] font-bold tracking-[-.01em] capitalize" title={key}>{key}</span>
              <span className="rounded-full border border-rule bg-warm2 px-2 py-0.5 font-mono text-[10px] font-semibold text-mute">
                {colRows.length}
              </span>
              <span className="ml-auto font-mono text-[10px] tracking-[.04em] text-mute" title="Active learners in these batches">
                {active} active
              </span>
            </div>

            <div className="flex flex-col gap-2.5 overflow-y-auto px-3 pb-3">
              {colRows.map((b) => (
                <Link
                  key={b.id}
                  href={`/batches/${b.id}`}
                  className="group block rounded-[13px] border border-rule bg-paper p-3.5 transition hover:-translate-y-0.5 hover:border-rule2 hover:shadow-card"
                >
                  <div className="mb-2.5 flex items-center gap-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-semibold tracking-[-.005em]">{b.name}</div>
                      <div className="mt-px truncate font-mono text-[10px] text-mute">{b.code ?? "—"}</div>
                    </div>
                    <span className={cn("mono-cap inline-flex items-center rounded-full px-2 py-0.5 text-[8.5px] font-semibold capitalize", STATUS_CLS[b.status] ?? "bg-warm2 text-mute")}>
                      {b.status}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[12px] font-medium text-ink2">{b.stackName ?? b.programName ?? "—"}</span>
                    {b.slot && (
                      <span className="mono-cap rounded-full bg-warm2 px-1.5 py-0.5 text-[9px] font-semibold tracking-[.04em] text-ink2">{slotTitle(b.slot)}</span>
                    )}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="mono-cap rounded-full bg-warm2 px-1.5 py-0.5 text-[8.5px] font-semibold tracking-[.04em] text-ink2">{pct(b.coveragePct)} cov</span>
                    <span className="mono-cap rounded-full bg-warm2 px-1.5 py-0.5 text-[8.5px] font-semibold tracking-[.04em] text-ink2">{pct(b.attendancePct)} att</span>
                  </div>

                  <div className="mt-[11px] flex items-center gap-2 border-t border-dashed border-rule pt-2.5 text-[11.5px] text-ink2">
                    <span className="font-mono text-[10.5px] text-mute">
                      {b.activeCount}{b.seats != null ? `/${b.seats}` : ""} learners
                    </span>
                    {b.trainerName ? (
                      <span className="ml-auto flex items-center gap-1.5" title={b.trainerName}>
                        <span className={cn("flex h-[18px] w-[18px] items-center justify-center rounded-full text-[8px] font-bold text-white", avatarGradClass[gradFor(b.trainerName)])}>
                          {initialsOf(b.trainerName)}
                        </span>
                        <span className="hidden text-[10.5px] text-mute sm:inline">{shortName(b.trainerName)}</span>
                      </span>
                    ) : (
                      <span className="ml-auto text-[10.5px] text-hint">Not assigned</span>
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
