"use client";

// Enrollments > List. Sticky-header table with a column picker, Export CSV, and
// optional group-by sections. Rows click through to /enrollments/:id. Inline
// editing is intentionally omitted — the enrolment fee ledger + status live on
// the record page, where the side effects (payment verification, conversion)
// are surfaced.

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnchoredPopover } from "@/components/ui/AnchoredPopover";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { avatarGradClass, gradFor, initialsOf, shortName } from "@/lib/ui";
import type { Enrollment } from "@/lib/types";
import { PaymentHealthBadge } from "./PaymentHealthBadge";
import { enrollGroupKey, type EnrollGroupBy } from "./EnrollmentsKanban";

const STATUS_CLS: Record<string, string> = {
  pending:   "bg-[rgba(224,138,30,.12)] text-state-amber",
  active:    "bg-[rgba(46,158,106,.10)] text-state-ok",
  on_hold:   "bg-warm2                  text-mute",
  completed: "bg-warm2                  text-mute",
  dropped:   "bg-[rgba(217,83,79,.10)]  text-state-warn",
  deferred:  "bg-[rgba(224,138,30,.12)] text-state-amber",
};

function fmtINRFull(v: string | null): string {
  if (v == null || v === "") return "—";
  return `₹${Number(v).toLocaleString("en-IN")}`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

interface ColumnDef {
  key: string;
  label: string;
  width: string;         // grid-template-columns track
  align?: "left" | "right";
  render: (e: Enrollment) => React.ReactNode;
  csv: (e: Enrollment) => string;
}

const COLUMNS: ColumnDef[] = [
  {
    key: "learner", label: "Learner", width: "minmax(200px, 2.2fr)",
    render: (e) => (
      <div className="flex min-w-0 items-center gap-3">
        <div className={cn("flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white", avatarGradClass[gradFor(e.name)])}>
          {initialsOf(e.name)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold tracking-[-.005em]">{e.name}</div>
          <div className="truncate font-mono text-[10.5px] text-mute">{e.number ?? "—"}{e.email ? ` · ${e.email}` : ""}</div>
        </div>
      </div>
    ),
    csv: (e) => e.name,
  },
  {
    key: "course", label: "Course", width: "minmax(160px, 1.6fr)",
    render: (e) => (
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-ink2">{e.programName ?? "—"}</div>
        {e.courseModules.length > 0 && (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {e.courseModules.slice(0, 3).map((m) => (
              <span key={m} className="mono-cap rounded-full bg-warm2 px-1.5 py-0.5 text-[8.5px] font-semibold tracking-[.04em] text-ink2">{m}</span>
            ))}
            {e.courseModules.length > 3 && (
              <span className="mono-cap px-1 text-[8.5px] font-semibold text-hint">+{e.courseModules.length - 3}</span>
            )}
          </div>
        )}
      </div>
    ),
    csv: (e) => [e.programName ?? "", ...e.courseModules].filter(Boolean).join(" | "),
  },
  {
    key: "status", label: "Status", width: "110px",
    render: (e) => (
      <span className={cn("mono-cap inline-flex items-center rounded-full px-2 py-0.5 text-[9.5px] font-semibold", STATUS_CLS[e.status] ?? "bg-warm2 text-mute")}>
        {e.statusLabel}
      </span>
    ),
    csv: (e) => e.statusLabel,
  },
  {
    key: "feeQuoted", label: "Total fee", width: "110px", align: "right",
    render: (e) => <span className="font-mono text-[12px] text-ink">{fmtINRFull(e.feeQuoted)}</span>,
    csv: (e) => e.feeQuoted ?? "",
  },
  {
    key: "paid", label: "Paid", width: "150px", align: "right",
    render: (e) => {
      const pct = e.paidPct;
      return (
        <div className="flex flex-col items-end gap-1">
          <div className="font-mono text-[12px] text-ink">
            {fmtINRFull(e.feePaid)}{pct != null && <span className="ml-1 text-[10px] text-mute">({pct}%)</span>}
          </div>
          {pct != null && (
            <div className="h-1.5 w-[70px] overflow-hidden rounded-full bg-warm2">
              <div className="h-full rounded-full bg-grad" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
            </div>
          )}
        </div>
      );
    },
    csv: (e) => e.feePaid ?? "",
  },
  {
    key: "dueDate", label: "Next due", width: "90px", align: "right",
    render: (e) => <span className="font-mono text-[11px] text-mute">{fmtDate(e.dueDate)}</span>,
    csv: (e) => e.dueDate ?? "",
  },
  {
    key: "paymentHealth", label: "Payment", width: "110px",
    render: (e) => <PaymentHealthBadge health={e.paymentHealth} />,
    csv: (e) => e.paymentHealth,
  },
  {
    key: "batch", label: "Batch", width: "100px",
    render: (e) => e.batchCode
      ? <span className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[9.5px] font-semibold tracking-[.04em] text-ink2">{e.batchCode}</span>
      : <span className="mono-cap rounded-full border border-dashed border-rule2 px-2 py-0.5 text-[9.5px] font-semibold tracking-[.04em] text-hint">+ Assign</span>,
    csv: (e) => e.batchCode ?? "",
  },
  {
    key: "advisor", label: "Advisor", width: "minmax(120px, 1fr)",
    render: (e) => e.advisorName
      ? (
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white", avatarGradClass[gradFor(e.advisorName)])}>
            {initialsOf(e.advisorName)}
          </span>
          <span className="truncate text-[12px] text-ink2">{shortName(e.advisorName)}</span>
        </div>
      )
      : <span className="text-[12px] text-hint">Unassigned</span>,
    csv: (e) => e.advisorName ?? "",
  },
  {
    key: "city", label: "City", width: "110px",
    render: (e) => <span className="truncate text-[12px] text-mute">{e.city ?? "—"}</span>,
    csv: (e) => e.city ?? "",
  },
  {
    key: "registeredDate", label: "Registered", width: "110px", align: "right",
    render: (e) => <span className="font-mono text-[11px] text-mute">{fmtDate(e.registeredDate)}</span>,
    csv: (e) => e.registeredDate ?? "",
  },
];

export const ENROLLMENT_LIST_COLUMNS: ReadonlyArray<{ key: string; label: string }> =
  COLUMNS.map((c) => ({ key: c.key, label: c.label }));

export const ENROLLMENT_LIST_DEFAULT_COLUMNS: readonly string[] = [
  "learner", "course", "status", "feeQuoted", "paid", "dueDate", "paymentHealth", "batch", "advisor",
];

const COL_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c] as const));

export function EnrollmentsListView({
  rows,
  groupBy,
  viewColumns,
  onColumnsChange,
  toolbarSlot,
  hasActiveFilter,
  onClearFilter,
}: {
  rows: Enrollment[];
  groupBy: EnrollGroupBy | null;
  viewColumns: string[] | null;
  onColumnsChange?: (cols: string[]) => void;
  toolbarSlot?: React.ReactNode;
  hasActiveFilter?: boolean;
  onClearFilter?: () => void;
}) {
  const [visibleKeys, setVisibleKeys] = useState<string[]>(
    () => (viewColumns && viewColumns.length > 0 ? viewColumns : [...ENROLLMENT_LIST_DEFAULT_COLUMNS]),
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
    const m = new Map<string, Enrollment[]>();
    for (const e of rows) {
      const k = enrollGroupKey(e, groupBy);
      const arr = m.get(k);
      if (arr) arr.push(e); else m.set(k, [e]);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length).map(([key, rs]) => ({ key, label: key, rows: rs }));
  }, [rows, groupBy]);

  function exportCsv() {
    const header = cols.map((c) => c.label);
    const lines = [header, ...rows.map((e) => cols.map((c) => c.csv(e)))];
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
    a.download = `enrollments-${new Date().toISOString().slice(0, 10)}.csv`;
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
                  No enrollments match the current filter.
                  {onClearFilter && (
                    <button type="button" onClick={onClearFilter} className="ml-2 font-semibold text-brand-violet hover:underline">
                      Clear
                    </button>
                  )}
                </>
              ) : (
                "No enrollments yet. Enroll a lead from its record page to start."
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
                {section.rows.map((e) => (
                  <Link key={e.id} href={`/enrollments/${encodeURIComponent(e.number ?? e.id)}`}>
                    <div
                      className="grid items-center gap-4 border-b border-rule px-[22px] py-3.5 transition last:border-b-0 hover:bg-warm"
                      style={{ gridTemplateColumns: gridTemplate }}
                    >
                      {cols.map((c) => (
                        <div key={c.key} className={cn("min-w-0", c.align === "right" && "flex flex-col items-end")}>
                          {c.render(e)}
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
      // Keep at least one column visible.
      if (visibleKeys.length <= 1) return;
      onChange(visibleKeys.filter((k) => k !== key));
    } else {
      // Re-insert in the canonical column order.
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
