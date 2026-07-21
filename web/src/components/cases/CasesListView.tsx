"use client";

// Cases > List. Sticky-header table with a column picker, Export CSV, and
// optional group-by sections. Rows click through to /cases/:number. Mirrors
// BatchesListView — a case's fields are edited on the detail page, so this
// view is read-only.

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnchoredPopover } from "@/components/ui/AnchoredPopover";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { avatarGradClass, gradFor, initialsOf, shortName } from "@/lib/ui";
import { SeverityChip } from "./SeverityChip";
import type { Case, CaseCategory, CaseStatus, CaseRequesterKind, CaseSlaState } from "@/lib/types";

const CATEGORY_LABEL: Record<CaseCategory, string> = {
  billing: "Billing",
  technical: "Technical",
  content_lms: "Content / LMS",
  onboarding: "Onboarding",
  cohort_batch: "Cohort / Batch",
  refund: "Refund",
  certificate: "Certificate",
  data_privacy: "Data / Privacy",
  other: "Other",
};

const REQUESTER_KIND_LABEL: Record<CaseRequesterKind, string> = {
  learner: "Learner",
  lead: "Lead",
  external: "External",
};

// Status pill colours, keyed by the raw status. The label shown is the case's
// displayStatus ("In Progress" / "Pending Learner" / "Reopened"), but the tint
// tracks the underlying status so a scan reads the same as the detail page.
const STATUS_PILL_CLS: Record<CaseStatus, string> = {
  open:        "bg-[rgba(31,63,207,.08)]  text-brand-blue",
  in_progress: "bg-[rgba(107,31,184,.08)] text-brand-violet",
  pending:     "bg-[rgba(224,138,30,.12)] text-state-amber",
  resolved:    "bg-[rgba(46,158,106,.10)] text-state-ok",
  closed:      "bg-warm2                  text-mute",
  cancelled:   "bg-warm                   text-hint",
};
const REOPENED_PILL_CLS = "bg-[rgba(224,138,30,.12)] text-state-amber";

// ── small helpers ───────────────────────────────────────────────────────────

/** "3h" / "45m" — an absolute-minutes duration, humanised coarsely. */
function humanMins(absMinutes: number): string {
  const m = Math.max(0, Math.round(absMinutes));
  return m >= 60 ? `${Math.floor(m / 60)}h` : `${m}m`;
}

/** SLA cell copy + colour, derived from the state + signed minutes-to-due. */
function slaLabel(state: CaseSlaState, minutes: number | null): { text: string; cls: string } {
  switch (state) {
    case "active": {
      if (minutes == null) return { text: "—", cls: "text-mute" };
      const m = Math.max(0, minutes);
      const text = m >= 60 ? `${Math.floor(m / 60)}h left` : `${m}m left`;
      return { text, cls: m < 60 ? "text-state-amber" : "text-ink2" };
    }
    case "breached":
      return { text: `BREACHED ${humanMins(Math.abs(minutes ?? 0))}`, cls: "text-state-warn" };
    case "paused":
      return { text: "Paused", cls: "text-mute" };
    default:
      return { text: "—", cls: "text-mute" };
  }
}

/** "just now" / "4h" / "2d" — age from a created-at timestamp. */
function ageLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function requesterKindLabel(kind: CaseRequesterKind): string {
  return REQUESTER_KIND_LABEL[kind] ?? kind;
}

interface ColumnDef {
  key: string;
  label: string;
  width: string;         // grid-template-columns track
  align?: "left" | "right";
  render: (c: Case) => React.ReactNode;
  csv: (c: Case) => string;
}

const COLUMNS: ColumnDef[] = [
  {
    key: "case", label: "Case", width: "minmax(220px, 2.4fr)",
    render: (c) => (
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-mono text-[10.5px] text-mute">{c.number}</span>
          {c.isAuto && (
            <span className="mono-cap inline-flex flex-shrink-0 items-center rounded-full bg-[rgba(46,158,106,.10)] px-1.5 py-0.5 text-[8.5px] font-semibold tracking-[.06em] text-state-ok">
              +AUTO
            </span>
          )}
        </div>
        <div className="truncate text-[14px] font-semibold tracking-[-.005em]">{c.subject}</div>
      </div>
    ),
    csv: (c) => `${c.number} ${c.subject}`,
  },
  {
    key: "party", label: "Party", width: "minmax(150px, 1.4fr)",
    render: (c) => (
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white", avatarGradClass[gradFor(c.requesterName)])}>
          {initialsOf(c.requesterName)}
        </span>
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-semibold text-ink2">{shortName(c.requesterName)}</div>
          <div className="mono-cap truncate text-[9px] tracking-[.06em] text-hint">{requesterKindLabel(c.requesterKind)}</div>
        </div>
      </div>
    ),
    csv: (c) => c.requesterName,
  },
  {
    key: "type", label: "Type", width: "minmax(140px, 1.2fr)",
    render: (c) => (
      <div className="min-w-0">
        <div className="truncate text-[12.5px] text-ink2">{c.typeLabel ?? CATEGORY_LABEL[c.category] ?? c.category}</div>
        <span className="mono-cap mt-0.5 inline-flex items-center rounded-full bg-warm2 px-1.5 py-0.5 text-[8.5px] font-semibold tracking-[.06em] text-mute">
          {c.typeGroup}
        </span>
      </div>
    ),
    csv: (c) => c.typeLabel ?? CATEGORY_LABEL[c.category] ?? c.category,
  },
  {
    key: "severity", label: "Severity", width: "110px",
    render: (c) => <SeverityChip severity={c.severity} size="sm" />,
    csv: (c) => c.severity,
  },
  {
    key: "status", label: "Status", width: "130px",
    render: (c) => (
      <span className={cn(
        "mono-cap inline-flex items-center rounded-full px-2 py-0.5 text-[9.5px] font-semibold",
        c.displayStatus === "Reopened" ? REOPENED_PILL_CLS : (STATUS_PILL_CLS[c.status] ?? "bg-warm2 text-mute"),
      )}>
        {c.displayStatus}
      </span>
    ),
    csv: (c) => c.displayStatus,
  },
  {
    key: "owner", label: "Owner", width: "minmax(130px, 1.1fr)",
    render: (c) => c.assigneeName
      ? (
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white", avatarGradClass[gradFor(c.assigneeName)])}>
            {initialsOf(c.assigneeName)}
          </span>
          <span className="truncate text-[12px] text-ink2">{shortName(c.assigneeName)}</span>
        </div>
      )
      : <span className="text-[12px] text-hint">Unassigned</span>,
    csv: (c) => c.assigneeName ?? "",
  },
  {
    key: "sla", label: "SLA", width: "130px",
    render: (c) => {
      const s = slaLabel(c.slaState, c.slaMinutes);
      return <span className={cn("mono-cap text-[10.5px] font-semibold tracking-[.04em]", s.cls)}>{s.text}</span>;
    },
    csv: (c) => slaLabel(c.slaState, c.slaMinutes).text,
  },
  {
    key: "about", label: "About", width: "minmax(130px, 1.1fr)",
    render: (c) => c.aboutHref && c.aboutLabel
      ? (
        <Link
          href={c.aboutHref}
          onClick={(e) => e.stopPropagation()}
          className="relative z-10 truncate text-[12px] text-brand-violet hover:underline"
        >
          {c.aboutLabel}
        </Link>
      )
      : <span className="text-[12px] text-mute">—</span>,
    csv: (c) => c.aboutLabel ?? "",
  },
  {
    key: "age", label: "Age", width: "80px", align: "right",
    render: (c) => <span className="font-mono text-[11px] text-mute">{ageLabel(c.createdAt)}</span>,
    csv: (c) => ageLabel(c.createdAt),
  },
];

export const CASE_LIST_COLUMNS: ReadonlyArray<{ key: string; label: string }> =
  COLUMNS.map((c) => ({ key: c.key, label: c.label }));

export const CASE_LIST_DEFAULT_COLUMNS: readonly string[] = [
  "case", "party", "type", "severity", "status", "owner", "sla", "about", "age",
];

const COL_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c] as const));

// Optional group axis. The board runs flat (no group-by pill), but the prop is
// kept so the surface matches BatchesListView's shape.
export type CaseGroupBy = "severity" | "typeGroup" | "status" | "owner";

function caseGroupKey(c: Case, groupBy: CaseGroupBy): string {
  switch (groupBy) {
    case "severity":  return c.severity;
    case "typeGroup": return c.typeGroup;
    case "status":    return c.displayStatus;
    case "owner":     return c.assigneeName ?? "Unassigned";
    default:          return "—";
  }
}

export function CasesListView({
  rows,
  groupBy,
  viewColumns,
  onColumnsChange,
  toolbarSlot,
  hasActiveFilter,
  onClearFilter,
}: {
  rows: Case[];
  groupBy: CaseGroupBy | null;
  viewColumns: string[] | null;
  onColumnsChange?: (cols: string[]) => void;
  toolbarSlot?: React.ReactNode;
  hasActiveFilter?: boolean;
  onClearFilter?: () => void;
}) {
  const [visibleKeys, setVisibleKeys] = useState<string[]>(
    () => (viewColumns && viewColumns.length > 0 ? viewColumns : [...CASE_LIST_DEFAULT_COLUMNS]),
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
    const m = new Map<string, Case[]>();
    for (const c of rows) {
      const k = caseGroupKey(c, groupBy);
      const arr = m.get(k);
      if (arr) arr.push(c); else m.set(k, [c]);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length).map(([key, rs]) => ({ key, label: key, rows: rs }));
  }, [rows, groupBy]);

  function exportCsv() {
    const header = cols.map((c) => c.label);
    const lines = [header, ...rows.map((c) => cols.map((col) => col.csv(c)))];
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
    a.download = `cases-${new Date().toISOString().slice(0, 10)}.csv`;
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
                  No cases match the current filter.
                  {onClearFilter && (
                    <button type="button" onClick={onClearFilter} className="ml-2 font-semibold text-brand-violet hover:underline">
                      Clear
                    </button>
                  )}
                </>
              ) : (
                "No cases yet. New ones show up here as they're raised."
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
                {section.rows.map((c) => (
                  // Stretched-link row: a transparent overlay Link covers the row
                  // and navigates to the case, while the About cell keeps its own
                  // link (they're siblings, so no invalid anchor nesting).
                  <div
                    key={c.id}
                    className="relative grid items-center gap-4 border-b border-rule px-[22px] py-3.5 transition last:border-b-0 hover:bg-warm"
                    style={{ gridTemplateColumns: gridTemplate }}
                  >
                    <Link
                      href={`/cases/${c.number}`}
                      aria-label={`Open case ${c.number}`}
                      className="absolute inset-0 z-0"
                    />
                    {cols.map((col) => (
                      <div key={col.key} className={cn("relative min-w-0", col.align === "right" && "flex flex-col items-end", col.key === "about" && "z-10")}>
                        {col.render(c)}
                      </div>
                    ))}
                  </div>
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
