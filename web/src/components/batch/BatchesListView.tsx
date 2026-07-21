"use client";

// Batches > List. Sticky-header table with a column picker, Export CSV, and
// optional group-by sections. Rows click through to /batches/:id. Mirrors
// LearnersListView — a batch's fields are edited in Admin · Batches, so this
// view is read-only.

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnchoredPopover } from "@/components/ui/AnchoredPopover";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { avatarGradClass, gradFor, initialsOf, shortName } from "@/lib/ui";
import type { BatchBoardRow, WeekDay } from "@/lib/types";
import { batchGroupKey, type BatchGroupBy } from "./BatchesKanban";

const STATUS_CLS: Record<string, string> = {
  upcoming:  "bg-[rgba(31,63,207,.08)]  text-brand-blue",
  running:   "bg-[rgba(46,158,106,.10)] text-state-ok",
  completed: "bg-warm2                  text-mute",
  cancelled: "bg-[rgba(217,83,79,.10)]  text-state-warn",
};

const WEEKDAY_LABEL: Record<WeekDay, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
};

function slotTitle(slot: string | null): string | null {
  if (!slot) return null;
  return slot[0]!.toUpperCase() + slot.slice(1);
}

function scheduleOf(b: BatchBoardRow): string {
  if (b.schedule) return b.schedule;
  if (b.daysOfWeek && b.daysOfWeek.length > 0) return b.daysOfWeek.map((d) => WEEKDAY_LABEL[d]).join(" ");
  return "—";
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

interface ColumnDef {
  key: string;
  label: string;
  width: string;         // grid-template-columns track
  align?: "left" | "right";
  render: (b: BatchBoardRow) => React.ReactNode;
  csv: (b: BatchBoardRow) => string;
}

// A small progress bar (active / total) — used for seat fill.
function FillBar({ value, total }: { value: number; total: number | null }) {
  if (total == null || total === 0) {
    return <span className="font-mono text-[11px] text-mute">{value > 0 ? value : "—"}</span>;
  }
  const pct = Math.min(100, Math.round((value / total) * 100));
  return (
    <div className="min-w-0">
      <div className="mb-1 font-mono text-[11px] text-ink2">{value}<span className="text-hint">/{total}</span></div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-warm2">
        <div className="h-full rounded-full bg-grad" style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
    </div>
  );
}

// A percentage bar for coverage / attendance — degrades to "—" when null.
function PctBar({ value }: { value: number | null }) {
  if (value == null) return <span className="font-mono text-[11px] text-mute">—</span>;
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="min-w-0">
      <div className="mb-1 font-mono text-[11px] text-ink2">{pct}%</div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-warm2">
        <div className="h-full rounded-full bg-grad" style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
    </div>
  );
}

const COLUMNS: ColumnDef[] = [
  {
    key: "batch", label: "Batch", width: "minmax(200px, 2.2fr)",
    render: (b) => (
      <div className="min-w-0">
        <div className="truncate text-[14px] font-semibold tracking-[-.005em]">{b.name}</div>
        <div className="truncate font-mono text-[10.5px] text-mute">{b.code ?? "—"}</div>
      </div>
    ),
    csv: (b) => b.name,
  },
  {
    key: "stack", label: "Stack", width: "130px",
    render: (b) => b.stackName
      ? <span className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[9.5px] font-semibold tracking-[.04em] text-ink2">{b.stackName}</span>
      : <span className="text-[12px] text-mute">—</span>,
    csv: (b) => b.stackName ?? "",
  },
  {
    key: "status", label: "Status", width: "100px",
    render: (b) => (
      <span className={cn("mono-cap inline-flex items-center rounded-full px-2 py-0.5 text-[9.5px] font-semibold capitalize", STATUS_CLS[b.status] ?? "bg-warm2 text-mute")}>
        {b.status}
      </span>
    ),
    csv: (b) => b.status,
  },
  {
    key: "trainer", label: "Trainer", width: "minmax(130px, 1.2fr)",
    render: (b) => b.trainerName
      ? (
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white", avatarGradClass[gradFor(b.trainerName)])}>
            {initialsOf(b.trainerName)}
          </span>
          <span className="truncate text-[12px] text-ink2">{shortName(b.trainerName)}</span>
        </div>
      )
      : <span className="text-[12px] text-hint">Not assigned</span>,
    csv: (b) => b.trainerName ?? "",
  },
  {
    key: "slotTime", label: "Slot · Time", width: "150px",
    render: (b) => {
      const parts = [slotTitle(b.slot), b.timeLabel].filter(Boolean);
      return parts.length > 0
        ? <span className="truncate text-[12px] text-ink2">{parts.join(" · ")}</span>
        : <span className="text-[12px] text-mute">—</span>;
    },
    csv: (b) => [slotTitle(b.slot), b.timeLabel].filter(Boolean).join(" · "),
  },
  {
    key: "days", label: "Days", width: "130px",
    render: (b) => <span className="truncate text-[12px] text-mute">{scheduleOf(b)}</span>,
    csv: (b) => scheduleOf(b) === "—" ? "" : scheduleOf(b),
  },
  {
    key: "startDate", label: "Starts", width: "120px", align: "right",
    render: (b) => b.startDate
      ? <span className="font-mono text-[11px] text-mute">{fmtDate(b.startDate)}</span>
      : <span className="text-[12px] text-hint">Not set</span>,
    csv: (b) => b.startDate ?? "",
  },
  {
    key: "learners", label: "Learners", width: "120px",
    render: (b) => <FillBar value={b.activeCount} total={b.seats} />,
    csv: (b) => `${b.activeCount}${b.seats != null ? `/${b.seats}` : ""}`,
  },
  {
    key: "coverage", label: "Coverage", width: "110px",
    render: (b) => <PctBar value={b.coveragePct} />,
    csv: (b) => b.coveragePct == null ? "" : `${b.coveragePct}%`,
  },
  {
    key: "attendance", label: "Attendance", width: "110px",
    render: (b) => <PctBar value={b.attendancePct} />,
    csv: (b) => b.attendancePct == null ? "" : `${b.attendancePct}%`,
  },
];

export const BATCH_LIST_COLUMNS: ReadonlyArray<{ key: string; label: string }> =
  COLUMNS.map((c) => ({ key: c.key, label: c.label }));

export const BATCH_LIST_DEFAULT_COLUMNS: readonly string[] = [
  "batch", "stack", "status", "trainer", "slotTime", "days", "startDate", "learners", "coverage", "attendance",
];

const COL_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c] as const));

export function BatchesListView({
  rows,
  groupBy,
  viewColumns,
  onColumnsChange,
  toolbarSlot,
  hasActiveFilter,
  onClearFilter,
}: {
  rows: BatchBoardRow[];
  groupBy: BatchGroupBy | null;
  viewColumns: string[] | null;
  onColumnsChange?: (cols: string[]) => void;
  toolbarSlot?: React.ReactNode;
  hasActiveFilter?: boolean;
  onClearFilter?: () => void;
}) {
  const [visibleKeys, setVisibleKeys] = useState<string[]>(
    () => (viewColumns && viewColumns.length > 0 ? viewColumns : [...BATCH_LIST_DEFAULT_COLUMNS]),
  );

  // Mirror pushed saved-view columns.
  const pushedKey = viewColumns ? viewColumns.join("|") : "";
  useEffect(() => {
    if (viewColumns && viewColumns.length > 0) setVisibleKeys(viewColumns);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushedKey]);

  useEffect(() => { onColumnsChange?.(visibleKeys); }, [visibleKeys, onColumnsChange]);

  const cols = useMemo(
    () => visibleKeys.map((k) => COL_BY_KEY.get(k)).filter((c): c is ColumnDef => !!c),
    [visibleKeys],
  );
  const gridTemplate = cols.map((c) => c.width).join(" ");

  // Group-by sections.
  const sections = useMemo(() => {
    if (!groupBy) return [{ key: "__all__", label: "", rows }];
    const m = new Map<string, BatchBoardRow[]>();
    for (const b of rows) {
      const k = batchGroupKey(b, groupBy);
      const arr = m.get(k);
      if (arr) arr.push(b); else m.set(k, [b]);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length).map(([key, rs]) => ({ key, label: key, rows: rs }));
  }, [rows, groupBy]);

  function exportCsv() {
    const header = cols.map((c) => c.label);
    const lines = [header, ...rows.map((b) => cols.map((c) => c.csv(b)))];
    const csv = lines
      .map((row) => row.map((cell) => {
        const s = String(cell ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `batches-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      {/* Toolbar row: board's toolbar (view switcher + filters) on the left,
          Export / Columns pinned on the right. */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">{toolbarSlot}</div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-ink2 transition hover:border-rule2 hover:text-ink"
          >
            <Icon name="doc" size={13} strokeWidth={2} />
            Export
          </button>
          <ColumnsPicker visibleKeys={visibleKeys} onChange={setVisibleKeys} />
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-rule bg-paper">
        <div style={{ minWidth: "1160px" }}>
          {/* Sticky header */}
          <div
            className="mono-cap sticky top-0 z-10 grid items-center gap-4 border-b border-rule bg-warm px-[22px] py-3 text-[9.5px] font-semibold tracking-[.12em] text-mute"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {cols.map((c) => (
              <div key={c.key} className={c.align === "right" ? "text-right" : ""}>{c.label}</div>
            ))}
          </div>

          {rows.length === 0 ? (
            <div className="px-[22px] py-12 text-center text-[13px] text-mute">
              {hasActiveFilter ? (
                <>
                  No batches match the current filter.
                  {onClearFilter && (
                    <button type="button" onClick={onClearFilter} className="ml-2 font-semibold text-brand-violet hover:underline">
                      Clear
                    </button>
                  )}
                </>
              ) : (
                "No batches yet. Create one from Admin · Batches to start."
              )}
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.key}>
                {groupBy && (
                  <div className="mono-cap flex items-center gap-2 border-b border-rule bg-warm/50 px-[22px] py-2 text-[9.5px] font-semibold tracking-[.12em] text-brand-violet">
                    <span className="capitalize">{section.label}</span>
                    <span className="text-hint">· {section.rows.length}</span>
                  </div>
                )}
                {section.rows.map((b) => (
                  <Link key={b.id} href={`/batches/${b.id}`}>
                    <div
                      className="grid items-center gap-4 border-b border-rule px-[22px] py-3.5 transition last:border-b-0 hover:bg-warm"
                      style={{ gridTemplateColumns: gridTemplate }}
                    >
                      {cols.map((c) => (
                        <div key={c.key} className={cn("min-w-0", c.align === "right" && "flex flex-col items-end")}>
                          {c.render(b)}
                        </div>
                      ))}
                    </div>
                  </Link>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

// ─── Columns picker ─────────────────────────────────────────────────────────

function ColumnsPicker({ visibleKeys, onChange }: { visibleKeys: string[]; onChange: (keys: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const visibleSet = new Set(visibleKeys);
  function toggle(key: string) {
    if (visibleSet.has(key)) {
      if (visibleKeys.length <= 1) return;
      onChange(visibleKeys.filter((k) => k !== key));
    } else {
      const next = COLUMNS.map((c) => c.key).filter((k) => visibleSet.has(k) || k === key);
      onChange(next);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-ink2 transition hover:border-rule2 hover:text-ink"
      >
        <Icon name="settings" size={13} strokeWidth={2} />
        Columns
      </button>
      {open && (
        <AnchoredPopover anchor={ref.current} align="right" className="min-w-[200px] p-1.5">
          <div className="mono-cap px-2 py-1 text-[9px] font-semibold tracking-[.12em] text-hint">
            Show columns
          </div>
          {COLUMNS.map((c) => (
            <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-warm">
              <input type="checkbox" checked={visibleSet.has(c.key)} onChange={() => toggle(c.key)} className="h-3.5 w-3.5 accent-brand-violet" />
              <span className="text-[12.5px] text-ink2">{c.label}</span>
            </label>
          ))}
        </AnchoredPopover>
      )}
    </div>
  );
}
