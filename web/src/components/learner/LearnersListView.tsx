"use client";

// Learners > List. Sticky-header table with a column picker, Export CSV, and
// optional group-by sections. Rows click through to /learners/:partyId.
// Mirrors EnrollmentsListView — a learner's course/batch state is edited on the
// record page, so this view is read-only.

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnchoredPopover } from "@/components/ui/AnchoredPopover";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { avatarGradClass, gradFor, initialsOf, shortName } from "@/lib/ui";
import type { LearnerSummary } from "@/lib/types";
import { learnerGroupKey, type LearnerGroupBy } from "./LearnersKanban";

const STATUS_CLS: Record<string, string> = {
  "In batch": "bg-[rgba(46,158,106,.10)] text-state-ok",
  "Assigned": "bg-[rgba(31,63,207,.10)]  text-brand-blue",
  "Enrolled": "bg-warm2                  text-mute",
};

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
  render: (l: LearnerSummary) => React.ReactNode;
  csv: (l: LearnerSummary) => string;
}

function countBadge(active: number, total: number): React.ReactNode {
  if (total === 0) return <span className="text-mute">—</span>;
  return active > 0 ? (
    <span className="rounded-full bg-grad-soft px-2 py-0.5 font-mono text-[11px] font-semibold text-brand-violet">
      {active}{total > active ? `/${total}` : ""}
    </span>
  ) : (
    <span className="font-mono text-[11px] text-mute">{total}</span>
  );
}

const COLUMNS: ColumnDef[] = [
  {
    key: "learner", label: "Learner", width: "minmax(200px, 2.2fr)",
    render: (l) => (
      <div className="flex min-w-0 items-center gap-3">
        <div className={cn("flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white", avatarGradClass[gradFor(l.name)])}>
          {initialsOf(l.name)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold tracking-[-.005em]">{l.name}</div>
          <div className="truncate font-mono text-[10.5px] text-mute">{l.email ?? "—"}</div>
        </div>
      </div>
    ),
    csv: (l) => l.name,
  },
  {
    key: "program", label: "Program", width: "minmax(160px, 1.6fr)",
    render: (l) => (
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-ink2">{l.programName ?? "—"}</div>
        {l.courseModules.length > 0 && (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {l.courseModules.slice(0, 3).map((m) => (
              <span key={m} className="mono-cap rounded-full bg-warm2 px-1.5 py-0.5 text-[8.5px] font-semibold tracking-[.04em] text-ink2">{m}</span>
            ))}
            {l.courseModules.length > 3 && (
              <span className="mono-cap px-1 text-[8.5px] font-semibold text-hint">+{l.courseModules.length - 3}</span>
            )}
          </div>
        )}
      </div>
    ),
    csv: (l) => [l.programName ?? "", ...l.courseModules].filter(Boolean).join(" | "),
  },
  {
    key: "stack", label: "Stack", width: "120px",
    render: (l) => <span className="truncate text-[12px] text-mute">{l.stackName ?? "TBD"}</span>,
    csv: (l) => l.stackName ?? "",
  },
  {
    key: "status", label: "Status", width: "100px",
    render: (l) => (
      <span className={cn("mono-cap inline-flex items-center rounded-full px-2 py-0.5 text-[9.5px] font-semibold", STATUS_CLS[l.status] ?? "bg-warm2 text-mute")}>
        {l.status}
      </span>
    ),
    csv: (l) => l.status,
  },
  {
    key: "courses", label: "Courses", width: "90px", align: "right",
    render: (l) => countBadge(l.activeCourses, l.totalCourses),
    csv: (l) => `${l.activeCourses}/${l.totalCourses}`,
  },
  {
    key: "batches", label: "Batches", width: "90px", align: "right",
    render: (l) => countBadge(l.activeBatches, l.totalBatches),
    csv: (l) => `${l.activeBatches}/${l.totalBatches}`,
  },
  {
    key: "batch", label: "Batch", width: "110px",
    render: (l) => l.batchCode
      ? <span className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[9.5px] font-semibold tracking-[.04em] text-ink2">{l.batchCode}</span>
      : <span className="mono-cap rounded-full border border-dashed border-rule2 px-2 py-0.5 text-[9.5px] font-semibold tracking-[.04em] text-hint">Not batched</span>,
    csv: (l) => l.batchCode ?? "",
  },
  {
    key: "advisor", label: "Advisor", width: "minmax(120px, 1fr)",
    render: (l) => l.advisorName
      ? (
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white", avatarGradClass[gradFor(l.advisorName)])}>
            {initialsOf(l.advisorName)}
          </span>
          <span className="truncate text-[12px] text-ink2">{shortName(l.advisorName)}</span>
        </div>
      )
      : <span className="text-[12px] text-hint">Unassigned</span>,
    csv: (l) => l.advisorName ?? "",
  },
  {
    key: "city", label: "City", width: "110px",
    render: (l) => <span className="truncate text-[12px] text-mute">{l.city ?? "—"}</span>,
    csv: (l) => l.city ?? "",
  },
  {
    key: "placement", label: "Placement", width: "120px",
    render: (l) => l.placementStatus
      ? <span className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[9px] font-semibold tracking-[.04em] text-ink2">{l.placementStatus.replace(/_/g, " ")}</span>
      : <span className="text-[12px] text-hint">—</span>,
    csv: (l) => l.placementStatus ?? "",
  },
  {
    key: "learnerSince", label: "Learner since", width: "130px", align: "right",
    render: (l) => <span className="font-mono text-[11px] text-mute">{fmtDate(l.learnerSince)}</span>,
    csv: (l) => l.learnerSince ?? "",
  },
];

export const LEARNER_LIST_COLUMNS: ReadonlyArray<{ key: string; label: string }> =
  COLUMNS.map((c) => ({ key: c.key, label: c.label }));

export const LEARNER_LIST_DEFAULT_COLUMNS: readonly string[] = [
  "learner", "program", "status", "courses", "batches", "batch", "advisor", "learnerSince",
];

const COL_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c] as const));

export function LearnersListView({
  rows,
  groupBy,
  viewColumns,
  onColumnsChange,
  toolbarSlot,
  hasActiveFilter,
  onClearFilter,
}: {
  rows: LearnerSummary[];
  groupBy: LearnerGroupBy | null;
  viewColumns: string[] | null;
  onColumnsChange?: (cols: string[]) => void;
  toolbarSlot?: React.ReactNode;
  hasActiveFilter?: boolean;
  onClearFilter?: () => void;
}) {
  const [visibleKeys, setVisibleKeys] = useState<string[]>(
    () => (viewColumns && viewColumns.length > 0 ? viewColumns : [...LEARNER_LIST_DEFAULT_COLUMNS]),
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
    const m = new Map<string, LearnerSummary[]>();
    for (const l of rows) {
      const k = learnerGroupKey(l, groupBy);
      const arr = m.get(k);
      if (arr) arr.push(l); else m.set(k, [l]);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length).map(([key, rs]) => ({ key, label: key, rows: rs }));
  }, [rows, groupBy]);

  function exportCsv() {
    const header = cols.map((c) => c.label);
    const lines = [header, ...rows.map((l) => cols.map((c) => c.csv(l)))];
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
    a.download = `learners-${new Date().toISOString().slice(0, 10)}.csv`;
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
        <div style={{ minWidth: "980px" }}>
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
                  No learners match the current filter.
                  {onClearFilter && (
                    <button type="button" onClick={onClearFilter} className="ml-2 font-semibold text-brand-violet hover:underline">
                      Clear
                    </button>
                  )}
                </>
              ) : (
                "No learners yet. Convert an enrollment from its record page to start."
              )}
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.key}>
                {groupBy && (
                  <div className="mono-cap flex items-center gap-2 border-b border-rule bg-warm/50 px-[22px] py-2 text-[9.5px] font-semibold tracking-[.12em] text-brand-violet">
                    <span>{section.label}</span>
                    <span className="text-hint">· {section.rows.length}</span>
                  </div>
                )}
                {section.rows.map((l) => (
                  <Link key={l.partyId} href={`/learners/${l.partyId}`}>
                    <div
                      className="grid items-center gap-4 border-b border-rule px-[22px] py-3.5 transition last:border-b-0 hover:bg-warm"
                      style={{ gridTemplateColumns: gridTemplate }}
                    >
                      {cols.map((c) => (
                        <div key={c.key} className={cn("min-w-0", c.align === "right" && "flex flex-col items-end")}>
                          {c.render(l)}
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
