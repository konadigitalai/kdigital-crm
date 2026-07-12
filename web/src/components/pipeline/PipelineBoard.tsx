"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/Icon";
import { ScoreRing } from "@/components/ui/ScoreRing";
import { NewLeadButton } from "@/components/leads/NewLeadDialog";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField } from "@/components/filter/types";
import { avatarGradClass, ratingStyles, scoreBand } from "@/lib/ui";
import { cn } from "@/lib/cn";
import { updateLead } from "@/lib/api";
import type { CatalogResponse, CurrentUser, Lead, LeadRating, PipelineColumn, SavedView } from "@/lib/types";
import { LEAD_RATINGS } from "@/lib/types";
import {
  PipelineListView,
  PIPELINE_LIST_COLUMNS,
  PIPELINE_LIST_DEFAULT_COLUMNS,
  LEAD_STATUS_OPTIONS,
} from "./PipelineListView";
import { DEFAULT_VIEW_ID, ViewTabs } from "./ViewTabs";

const DRAG_MIME = "application/x-decrm-lead";

// ─── group-by ─────────────────────────────────────────────────────────────

// The "Group by" axis selector is applied to Kanban + Chart only. Rating is
// the default and the only axis where drag-drop is allowed (since dragging
// across columns writes lead.rating). Other axes are read-only buckets.
export type GroupBy = "rating" | "status" | "program" | "advisor" | "source";

export const GROUP_BY_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "rating",  label: "Rating" },
  { value: "status",  label: "Status" },
  { value: "program", label: "Program" },
  { value: "advisor", label: "Advisor" },
  { value: "source",  label: "Source" },
];

const LEAD_STATUS_LABEL: Record<string, string> = Object.fromEntries(
  LEAD_STATUS_OPTIONS.map((o) => [o.value, o.label]),
);

export function groupKey(l: Lead, by: GroupBy): string {
  if (by === "rating")  return l.rating;
  if (by === "status")  return l.leadStatus || "—";
  if (by === "program") return l.program || "—";
  if (by === "advisor") return l.advisorName || "—";
  if (by === "source")  return l.sourceLabel || l.source || "—";
  return "—";
}

function groupLabel(by: GroupBy, key: string): string {
  if (by === "status") return key === "—" ? "No status" : (LEAD_STATUS_LABEL[key] ?? key);
  // Rating keys are raw enum values ("superhot", "new lead"). /pipeline never
  // hit this — it takes the server's pre-labelled columns — but /leads
  // synthesises its rating columns, so without this the Kanban headers and
  // list sections read "superhot" instead of "Super hot".
  if (by === "rating") return ratingStyles[key as LeadRating]?.label ?? key;
  return key;
}

// ─── helpers ──────────────────────────────────────────────────────────────

// Rating-specific visual constants — only used when groupBy === "rating".
const colDot: Record<LeadRating, string> = {
  "new lead": "bg-brand-blue",
  attempted:  "bg-brand-violet",
  cold:       "bg-mute",
  lukewarm:   "bg-state-amber",
  warm:       "bg-state-amber",
  hot:        "bg-brand-magenta",
  superhot:   "bg-brand-magenta",
  enrolled:   "bg-state-ok",
};

const colHex: Record<LeadRating, string> = {
  "new lead": "#1F3FCF",
  attempted:  "#6B1FB8",
  cold:       "#A89DAC",
  lukewarm:   "#E7B15E",
  warm:       "#E08A1E",
  hot:        "#C7197A",
  superhot:   "#C7197A",
  enrolled:   "#2E9E6A",
};

// Stable palette for non-rating axes — picked deterministically from the
// bucket name so the same advisor / program always gets the same color.
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

const RATING_OPTIONS = LEAD_RATINGS.map((r) => ({ value: r, label: ratingStyles[r].label }));

function unique<T>(xs: T[]): T[] { return [...new Set(xs.filter(Boolean))]; }

function buildFields(allLeads: Lead[]): FilterField[] {
  const programs = unique(allLeads.map((l) => l.program).filter((x): x is string => !!x));
  const cities   = unique(allLeads.map((l) => l.city).filter((x): x is string => !!x));
  const advisors = unique(allLeads.map((l) => l.advisorName).filter((x): x is string => !!x));
  const sources  = unique(allLeads.map((l) => l.sourceLabel ?? l.source).filter((x): x is string => !!x));
  return [
    { key: "name",       label: "Name",        type: "text",   get: (l: Lead) => l.name },
    { key: "number",     label: "Lead #",      type: "text",   get: (l: Lead) => l.number },
    { key: "program",    label: "Program",     type: "enum",   options: programs.map((p) => ({ value: p, label: p })), get: (l: Lead) => l.program },
    { key: "city",       label: "City",        type: "enum",   options: cities.map((c) => ({ value: c, label: c })),   get: (l: Lead) => l.city },
    { key: "advisor",    label: "Advisor",     type: "enum",   options: advisors.map((a) => ({ value: a, label: a })), get: (l: Lead) => l.advisorName },
    { key: "source",     label: "Source",      type: "enum",   options: sources.map((s) => ({ value: s, label: s })),  get: (l: Lead) => l.sourceLabel ?? l.source },
    { key: "rating",     label: "Rating",      type: "enum",   options: RATING_OPTIONS,                                get: (l: Lead) => l.rating },
    { key: "leadStatus", label: "Lead status", type: "enum",   options: LEAD_STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label })), get: (l: Lead) => l.leadStatus },
    { key: "score",      label: "Score",       type: "number", get: (l: Lead) => l.score },
    { key: "nbaLabel",   label: "Next action", type: "text",   get: (l: Lead) => l.nbaLabel },
    { key: "nextFollowupAt", label: "Next follow-up", type: "date", get: (l: Lead) => l.nextFollowupAt },
    { key: "demoAttendedAt", label: "Demo attended",  type: "date", get: (l: Lead) => l.demoAttendedAt },
  ];
}

// Parse "₹1.49L" / "₹99k" / "₹2.4Cr" → number (rupees)
function parseINR(s: string | null | undefined): number {
  if (!s) return 0;
  const m = s.match(/^₹([\d.]+)([CrLk]+)?$/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (m[2] === "Cr") return n * 1_00_00_000;
  if (m[2] === "L")  return n * 1_00_000;
  if (m[2] === "k")  return n * 1_000;
  return n;
}

function fmtINR(n: number): string {
  if (!n) return "—";
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(1).replace(/\.0$/, "")}Cr`;
  if (n >= 1_00_000)    return `₹${Math.round(n / 1_00_000)}L`;
  if (n >= 1_000)       return `₹${Math.round(n / 1_000)}k`;
  return `₹${Math.round(n)}`;
}

// ─── column synthesis ─────────────────────────────────────────────────────

// A "synthetic" column shape that works for any groupBy axis. When groupBy
// is "rating" we re-use the server-computed PipelineColumn[] (ordered + with
// AI notes). When grouping by anything else we synthesise columns on the fly
// from the filtered leads.
export interface SynthColumn {
  key: string;
  label: string;
  count: number;
  sum: string;
  aiNote: string | null;
  // Visual color knobs — present for rating, derived for the others.
  dotClass: string;
  hex: string;
  // Whether this column accepts dropped leads (only true for rating).
  droppable: boolean;
}

export function makeColumns(
  groupBy: GroupBy,
  ratingColumns: PipelineColumn[],
  filtered: Lead[],
  filteredAll: Lead[],
): SynthColumn[] {
  // /pipeline hands us server-computed rating columns (ordered, with AI
  // notes). /leads has no such fetch, so it passes [] and we synthesise the
  // rating buckets from the leads themselves below — same shape, no AI note.
  if (groupBy === "rating" && ratingColumns.length > 0) {
    return ratingColumns.map((c) => ({
      key: c.key,
      label: c.label,
      count: c.count,
      sum: c.sum,
      aiNote: c.aiNote,
      dotClass: colDot[c.key],
      hex: colHex[c.key],
      droppable: true,
    }));
  }

  // Build the bucket list. For "rating" and "status" we show the full
  // canonical set so every bucket is a visible column even when empty. For
  // other axes we synth from the data so we don't invent buckets that don't
  // exist yet.
  const canonical: string[] =
    groupBy === "status" ? LEAD_STATUS_OPTIONS.map((o) => o.value)
    : groupBy === "rating" ? [...LEAD_RATINGS]
    : [];
  const seenKeys = unique(
    [...canonical, ...filteredAll.map((l) => groupKey(l, groupBy))],
  );
  const sorted = canonical.length > 0
    ? seenKeys.sort((a, b) => {
        // Preserve canonical order; unknown / "—" go last.
        const ia = canonical.indexOf(a);
        const ib = canonical.indexOf(b);
        if (ia === -1 && ib === -1) return a.localeCompare(b);
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      })
    : seenKeys.sort((a, b) => a.localeCompare(b));
  return sorted.map((k) => {
    const inAll = filteredAll.filter((l) => groupKey(l, groupBy) === k);
    const inFiltered = filtered.filter((l) => groupKey(l, groupBy) === k);
    const sumNum = inFiltered.reduce((s, l) => s + parseINR(l.value), 0);
    const isRating = groupBy === "rating" && k in colDot;
    const palette = isRating
      ? { dot: colDot[k as LeadRating], hex: colHex[k as LeadRating] }
      : paletteFor(k);
    return {
      key: k,
      label: groupLabel(groupBy, k),
      count: inAll.length,
      sum: fmtINR(sumNum),
      aiNote: null,
      dotClass: palette.dot,
      hex: palette.hex,
      droppable: groupBy === "rating",
    };
  });
}

// ─── top-level component ──────────────────────────────────────────────────

export type ViewMode = "list" | "kanban" | "chart";

export function PipelineBoard({
  columns,
  canWrite = true,
  canCreateLeads = true,
  canDeleteLeads = false,
  catalog,
  initialViews = [],
  currentUser = null,
}: {
  columns: PipelineColumn[];
  canWrite?: boolean;
  canCreateLeads?: boolean;
  canDeleteLeads?: boolean;
  catalog: CatalogResponse;
  /** Saved views for the pipeline list, prefetched server-side. */
  initialViews?: SavedView[];
  /** Used to decide which views are owner-editable. */
  currentUser?: CurrentUser | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Local copy of all leads for optimistic drag-drop. Re-syncs from props when
  // the server returns fresh data (router.refresh) — but only when the prop
  // actually changes, so optimistic edits aren't reverted instantly.
  const incomingAllLeads: Lead[] = useMemo(() => columns.flatMap((c) => c.leads as Lead[]), [columns]);
  const [localLeads, setLocalLeads] = useState<Lead[]>(incomingAllLeads);
  // Fingerprint includes every field a user can edit from the list view.
  // The previous key only watched rating, so non-rating edits (phone, email,
  // program, advisor, dates, etc.) never re-synced from the server and the
  // user had to hard-reload to see their own changes.
  const incomingKey = useMemo(
    () =>
      incomingAllLeads
        .map((l) =>
          [
            l.id, l.rating, l.score, l.name, l.email ?? "", l.phone ?? "",
            l.city ?? "", l.program ?? "", l.programId ?? "",
            l.advisorId ?? "", l.advisorName ?? "",
            l.source ?? "", l.sourceLabel ?? "",
            l.value ?? "", l.description ?? "",
            l.deliveryMode ?? "", l.timeZone ?? "",
            l.feePaid ?? "", l.feeDue ?? "",
            l.dueDate ?? "", l.registeredDate ?? "",
            l.nextFollowupAt ?? "", l.demoAttendedAt ?? "",
          ].join("|"),
        )
        .join("\n"),
    [incomingAllLeads],
  );
  // Re-sync local state when the server data changes.
  useEffect(() => {
    setLocalLeads(incomingAllLeads);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingKey]);

  const fields = useMemo(() => buildFields(localLeads), [localLeads]);
  const [filtered, state, setState] = useFilter(localLeads, fields);
  const [view, setView] = useState<ViewMode>("kanban");
  const [groupBy, setGroupBy] = useState<GroupBy>("rating");
  const [dragError, setDragError] = useState<string | null>(null);

  // ─── saved views (list view only) ──────────────────────────────────────
  const [views, setViews] = useState<SavedView[]>(initialViews);
  const [activeViewId, setActiveViewId] = useState<string>(DEFAULT_VIEW_ID);
  // Live snapshot of which columns the list view is showing — captured here
  // so the saved-view editor can persist them. Starts null until the list
  // view's first onColumnsChange fires.
  const [liveColumns, setLiveColumns] = useState<string[] | null>(null);

  // The columns to *push* into PipelineListView for the active view. Null
  // means "use whatever's in localStorage / your last picks". When the user
  // clicks a saved view, we read its columns and push them; PipelineListView
  // mirrors them into its local state for the column picker.
  const activeView = activeViewId === DEFAULT_VIEW_ID
    ? null
    : views.find((v) => v.id === activeViewId) ?? null;
  const viewColumnsToPush = activeView?.columns ?? null;

  // Switching views: apply the view's filter (or clear it for default).
  function selectView(id: string) {
    setActiveViewId(id);
    if (id === DEFAULT_VIEW_ID) {
      setState({ combinator: "and", rules: [] });
      return;
    }
    const v = views.find((x) => x.id === id);
    if (!v) return;
    // Saved view's filter is opaque JSONB; treat it as the filter shape and
    // fall back to empty if it's malformed.
    const next = (v.filter && typeof v.filter === "object" && Array.isArray((v.filter as Record<string, unknown>).rules))
      ? v.filter
      : { combinator: "and", rules: [] };
    setState(next as { combinator: "and" | "or"; rules: import("@/components/filter/types").FilterRule[] });
  }

  // Optimistic drag-drop: change local state immediately, fire PATCH, roll
  // back on error. router.refresh keeps the per-column sums + AI strip
  // notes accurate after a successful drop. Only valid when grouped by rating.
  async function onDrop(leadId: string, fromKey: string, toKey: string) {
    if (groupBy !== "rating") return;
    if (fromKey === toKey) return;
    if (!canWrite) {
      setDragError("You don't have permission to move leads. Ask an admin for the pipeline.write permission.");
      setTimeout(() => setDragError(null), 4000);
      return;
    }
    const before = localLeads;
    const toRating = toKey as LeadRating;
    setLocalLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, rating: toRating } : l)));
    try {
      const target = before.find((l) => l.id === leadId);
      if (!target) throw new Error("Lead not found in local state");
      await updateLead(target.number, { rating: toRating });
      startTransition(() => router.refresh());
    } catch (err) {
      setLocalLeads(before);
      setDragError(`Couldn't update rating: ${(err as Error).message}`);
      setTimeout(() => setDragError(null), 4000);
    }
  }

  // Recompute rating-column counts from local state so they stay in sync
  // with optimistic drops without waiting for router.refresh.
  const liveRatingColumns = useMemo(() => {
    return columns.map((col) => {
      const inCol = localLeads.filter((l) => l.rating === col.key);
      return { ...col, count: inCol.length, leads: inCol };
    });
  }, [columns, localLeads]);

  const dynamicColumns = useMemo(
    () => makeColumns(groupBy, liveRatingColumns, filtered, localLeads),
    [groupBy, liveRatingColumns, filtered, localLeads],
  );

  // Map from column key → leads that fall in it (after filtering).
  const leadsByColumn = useMemo(() => {
    const m = new Map<string, Lead[]>();
    for (const l of filtered) {
      const k = groupKey(l, groupBy);
      const arr = m.get(k) ?? [];
      arr.push(l);
      m.set(k, arr);
    }
    return m;
  }, [filtered, groupBy]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <ViewSwitcher value={view} onChange={setView} />
        {(view === "kanban" || view === "chart") && (
          <GroupBySelector value={groupBy} onChange={setGroupBy} />
        )}
        <div className="flex-1 rounded-[14px] border border-rule bg-paper p-3">
          <FilterBar
            fields={fields}
            state={state}
            onChange={setState}
            placeholder="Filter pipeline by field…"
            totalRows={localLeads.length}
            filteredRows={filtered.length}
          />
        </div>
      </div>

      {/* Saved-view tabs only make sense for the flat list view. Kanban /
          chart group-by is the existing slicing dimension there. */}
      {view === "list" && (
        <div className="mb-3">
          <ViewTabs
            views={views}
            activeId={activeViewId}
            onSelect={selectView}
            fields={fields}
            allColumns={PIPELINE_LIST_COLUMNS}
            defaultColumns={PIPELINE_LIST_DEFAULT_COLUMNS}
            currentFilter={state}
            currentColumns={liveColumns ?? []}
            onChange={setViews}
            currentUser={currentUser}
            canShare={canWrite}
          />
        </div>
      )}

      {dragError && (
        <div className="mb-3 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
          {dragError}
        </div>
      )}

      {view === "kanban" && (
        <KanbanView
          columns={dynamicColumns}
          leadsByColumn={leadsByColumn}
          filterActive={state.rules.length > 0}
          groupBy={groupBy}
          onDrop={onDrop}
          canCreateLeads={canCreateLeads}
        />
      )}
      {view === "list"  && (
        <PipelineListView
          leads={filtered}
          catalog={catalog}
          canWrite={canCreateLeads}
          canDelete={canDeleteLeads}
          viewColumns={viewColumnsToPush}
          onColumnsChange={setLiveColumns}
          onLocalEdit={(leadId, patch) => {
            setLocalLeads((prev) =>
              prev.map((l) => (l.id === leadId ? { ...l, ...patch } : l)),
            );
          }}
          onLocalDelete={(leadIds) => {
            const dropSet = new Set(leadIds);
            setLocalLeads((prev) => prev.filter((l) => !dropSet.has(l.id)));
          }}
        />
      )}
      {view === "chart" && (
        <ChartView columns={dynamicColumns} leadsByColumn={leadsByColumn} groupByLabel={GROUP_BY_OPTIONS.find((o) => o.value === groupBy)?.label ?? ""} />
      )}
    </>
  );
}

// ─── ViewSwitcher (segmented control) ─────────────────────────────────────

export function ViewSwitcher({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  const items: { key: ViewMode; label: string; icon: IconName }[] = [
    { key: "list",   label: "List",   icon: "bars" },
    { key: "kanban", label: "Kanban", icon: "agents-grid" },
    { key: "chart",  label: "Chart",  icon: "chart" },
  ];
  return (
    <div className="inline-flex rounded-full border border-rule bg-paper p-1 text-[12.5px]">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-semibold transition",
            value === it.key ? "bg-ink text-white" : "text-ink2 hover:bg-warm",
          )}
        >
          <Icon name={it.icon} size={13} strokeWidth={2} />
          {it.label}
        </button>
      ))}
    </div>
  );
}

function GroupBySelector({ value, onChange }: { value: GroupBy; onChange: (v: GroupBy) => void }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-rule bg-paper px-3 py-1 text-[12.5px]">
      <span className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">
        Group by
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as GroupBy)}
        className="cursor-pointer bg-transparent pr-1 font-semibold text-ink focus:outline-none"
      >
        {GROUP_BY_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ─── Kanban ───────────────────────────────────────────────────────────────

export function KanbanView({
  columns,
  leadsByColumn,
  filterActive,
  groupBy,
  onDrop,
  canCreateLeads,
}: {
  columns: SynthColumn[];
  leadsByColumn: Map<string, Lead[]>;
  filterActive: boolean;
  groupBy: GroupBy;
  onDrop: (leadId: string, fromKey: string, toKey: string) => void;
  canCreateLeads: boolean;
}) {
  // Track which column is being hovered with a dragged card so we can
  // highlight it as a valid drop target.
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Safety net: when the optimistic drop reorders the lead into another
  // column, React unmounts the source <Link> before the browser delivers the
  // synthetic `dragend`, so its onDragEnd handler never fires and the card
  // stays stuck at opacity-40. A window-level listener doesn't depend on any
  // particular DOM node and always cleans up.
  useEffect(() => {
    function clear() { setDraggingId(null); setHoverKey(null); }
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);

  if (columns.length === 0) {
    return (
      <div className="rounded-2xl border border-rule bg-paper p-12 text-center text-[13px] text-mute">
        No leads match the current filter.
      </div>
    );
  }

  return (
    <div
      className="grid items-start gap-3.5 overflow-x-auto pb-2"
      style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(248px, 1fr))` }}
    >
      {columns.map((col) => {
        const colLeads = leadsByColumn.get(col.key) ?? [];
        const isHover = hoverKey === col.key && col.droppable;
        return (
          <div
            key={col.key}
            onDragOver={(e) => {
              if (!col.droppable) return;
              if (e.dataTransfer.types.includes(DRAG_MIME)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (hoverKey !== col.key) setHoverKey(col.key);
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setHoverKey((curr) => (curr === col.key ? null : curr));
              }
            }}
            onDrop={(e) => {
              if (!col.droppable) return;
              e.preventDefault();
              setDraggingId(null);
              setHoverKey(null);
              const raw = e.dataTransfer.getData(DRAG_MIME);
              if (!raw) return;
              try {
                const { id, fromKey } = JSON.parse(raw) as { id: string; fromKey: string };
                onDrop(id, fromKey, col.key);
              } catch { /* ignore malformed payload */ }
            }}
            className={cn(
              "flex flex-col rounded-2xl border bg-warm transition",
              isHover ? "border-brand-violet ring-2 ring-brand-violet/30 bg-warm2" : "border-rule",
            )}
            style={{ maxHeight: "calc(100vh - 250px)" }}
          >
            <div className="flex items-center gap-[9px] p-[14px_16px_12px]">
              <span className={cn("h-[9px] w-[9px] flex-shrink-0 rounded-full", col.dotClass)} />
              <span className="truncate text-[13.5px] font-bold tracking-[-.01em]" title={col.label}>{col.label}</span>
              <span className="rounded-full border border-rule bg-warm2 px-2 py-0.5 font-mono text-[10px] font-semibold text-mute">
                {filterActive ? `${colLeads.length}/${col.count}` : col.count}
              </span>
              <span className="ml-auto font-mono text-[10px] tracking-[.04em] text-mute">{col.sum}</span>
            </div>

            {col.aiNote && (
              <div
                className="mx-3 mb-2.5 flex items-center gap-2.5 rounded-[11px] border p-[10px_12px] text-[11.5px] leading-[1.35] text-ink2"
                style={{
                  background: "linear-gradient(120deg,rgba(199,25,122,.08),rgba(107,31,184,.06))",
                  borderColor: "rgba(199,25,122,.2)",
                }}
              >
                <span className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-[7px] bg-grad">
                  <Icon name="star" size={12} strokeWidth={2} className="text-white" />
                </span>
                <span dangerouslySetInnerHTML={{ __html: col.aiNote.replace(/\*\*(.+?)\*\*/g, "<b class='font-bold text-ink'>$1</b>") }} />
              </div>
            )}

            <div className="flex flex-col gap-2.5 overflow-y-auto px-3 pb-3">
              {colLeads.map((l) => {
                const ai = l.score >= 85 && (l.rating === "hot" || l.rating === "superhot");
                const isDragging = draggingId === l.id;
                const draggable = col.droppable; // only when grouped by rating
                return (
                  <Link
                    key={l.id}
                    href={`/records/${l.number}`}
                    draggable={draggable}
                    onDragStart={(e) => {
                      if (!draggable) return;
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData(
                        DRAG_MIME,
                        JSON.stringify({ id: l.id, fromKey: col.key }),
                      );
                      setDraggingId(l.id);
                    }}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setHoverKey(null);
                    }}
                    onClick={(e) => {
                      if (draggingId) e.preventDefault();
                    }}
                    className={cn(
                      "group block rounded-[13px] border bg-paper p-3.5 transition hover:-translate-y-0.5 hover:border-rule2 hover:shadow-card",
                      draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                      ai ? "border-[rgba(199,25,122,.28)] shadow-glowSoft" : "border-rule",
                      isDragging && "opacity-40 ring-2 ring-brand-violet/40",
                    )}
                  >
                    <div className="mb-2.5 flex items-center gap-2.5">
                      <div className={cn("flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white", avatarGradClass[l.avatar])}>
                        {l.initials}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-semibold tracking-[-.005em]">{l.name}</div>
                        <div className="mt-px font-mono text-[9px] tracking-[.04em] text-mute">{l.number} · {l.city}</div>
                      </div>
                      {/* Ring colour tracks the *score*, not lead.heat — heat is
                          derived from the human rating, which is already the
                          column this card sits in. */}
                      <ScoreRing score={l.score} heat={scoreBand(l.score).heat} size={30} inner={23} fontSize={10} />
                    </div>
                    <div className="text-[12px] font-medium text-ink2">{l.program}</div>
                    <div className="mt-1 font-mono text-[10px] tracking-[.04em] text-mute">{l.value}</div>
                    {/* When grouped by something other than rating, surface the rating
                        chip on each card so users still see it inline. */}
                    {groupBy !== "rating" && (
                      <div className="mt-1.5">
                        <span
                          className={cn(
                            "mono-cap inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold tracking-[.06em]",
                            ratingStyles[l.rating].bg,
                            ratingStyles[l.rating].text,
                          )}
                        >
                          <span className={cn("h-1.5 w-1.5 rounded-full", ratingStyles[l.rating].dot)} />
                          {ratingStyles[l.rating].label}
                        </span>
                      </div>
                    )}
                    <div
                      className={cn(
                        "mt-[11px] flex items-center gap-2 border-t border-dashed border-rule pt-2.5 text-[11.5px]",
                        l.nbaGhost ? "text-mute" : "text-ink2",
                      )}
                    >
                      <span className={cn("flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-[5px]", l.nbaGhost ? "bg-warm2" : "bg-grad-soft")}>
                        <Icon name={l.nbaIcon as IconName} size={10} strokeWidth={2} className={l.nbaGhost ? "text-mute" : "text-brand-violet"} />
                      </span>
                      {l.nbaLabel}
                    </div>
                  </Link>
                );
              })}
              {/* New-lead inline only when grouped by rating + no filter applied. */}
              {groupBy === "rating" && !filterActive && canCreateLeads && (
                <NewLeadButton variant="ghost" defaultRating={col.key as LeadRating} />
              )}
              {colLeads.length === 0 && (
                <div className="rounded-[11px] border border-dashed border-rule2 p-4 text-center text-[11.5px] text-mute">
                  {col.droppable
                    ? <>Drop a lead here to mark as <b className="font-semibold text-ink">{col.label}</b>.</>
                    : <>No leads in <b className="font-semibold text-ink">{col.label}</b>.</>}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Chart (funnel + bar, SVG) ────────────────────────────────────────────

export function ChartView({
  columns,
  leadsByColumn,
  groupByLabel,
}: {
  columns: SynthColumn[];
  leadsByColumn: Map<string, Lead[]>;
  groupByLabel: string;
}) {
  // Per column: count + ₹ sum (computed from filtered leads).
  const data = columns.map((col) => {
    const leads = leadsByColumn.get(col.key) ?? [];
    const sumNum = leads.reduce((s, l) => s + parseINR(l.value), 0);
    return {
      key: col.key,
      label: col.label,
      hex: col.hex,
      count: leads.length,
      sum: sumNum,
    };
  });

  const totalCount = data.reduce((s, d) => s + d.count, 0);
  const totalSum   = data.reduce((s, d) => s + d.sum, 0);
  const maxCount   = Math.max(1, ...data.map((d) => d.count));
  const maxSum     = Math.max(1, ...data.map((d) => d.sum));

  if (columns.length === 0) {
    return (
      <div className="rounded-2xl border border-rule bg-paper p-12 text-center text-[13px] text-mute">
        No leads match the current filter.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-5">
      {/* Funnel */}
      <div className="rounded-2xl border border-rule bg-paper p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="mono-cap text-[10px] font-semibold tracking-[.14em] text-brand-violet">Funnel</div>
            <div className="mt-0.5 text-[14px] font-bold">Lead count by {groupByLabel.toLowerCase()}</div>
          </div>
          <div className="font-mono text-[10.5px] text-mute">{totalCount} total</div>
        </div>

        <div className="flex flex-col gap-2.5">
          {data.map((d) => {
            const widthPct = (d.count / maxCount) * 100;
            const sharePct = totalCount > 0 ? Math.round((d.count / totalCount) * 100) : 0;
            return (
              <div key={d.key} className="flex items-center gap-3">
                <div className="w-[110px] flex-shrink-0 truncate text-[12.5px] font-medium text-ink2" title={d.label}>{d.label}</div>
                <div className="relative flex-1 overflow-hidden rounded-md bg-warm2/60">
                  <div
                    className="h-7 rounded-md transition-all"
                    style={{
                      width: `${Math.max(2, widthPct)}%`,
                      background: d.hex,
                      opacity: d.count === 0 ? 0.18 : 0.9,
                    }}
                  />
                  <div className="absolute inset-0 flex items-center justify-between px-2.5">
                    <span className="text-[11.5px] font-bold text-white" style={{ mixBlendMode: "difference" }}>
                      {d.count}
                    </span>
                    <span className="font-mono text-[10px] text-mute">{sharePct}%</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ₹ bar chart */}
      <div className="rounded-2xl border border-rule bg-paper p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="mono-cap text-[10px] font-semibold tracking-[.14em] text-brand-violet">Value</div>
            <div className="mt-0.5 text-[14px] font-bold">₹ open by {groupByLabel.toLowerCase()}</div>
          </div>
          <div className="font-mono text-[10.5px] text-mute">{fmtINR(totalSum)} total</div>
        </div>

        <div className="flex h-[260px] items-end gap-3 border-b border-rule pb-2">
          {data.map((d) => {
            const h = d.sum === 0 ? 4 : Math.max(8, (d.sum / maxSum) * 220);
            return (
              <div key={d.key} className="flex flex-1 flex-col items-center gap-2">
                <div className="font-mono text-[10px] text-mute">{fmtINR(d.sum)}</div>
                <div
                  className="w-full rounded-t-md transition-all"
                  style={{
                    height: `${h}px`,
                    background: `linear-gradient(180deg, ${d.hex}, ${d.hex}cc)`,
                    opacity: d.sum === 0 ? 0.25 : 1,
                  }}
                  title={`${d.label}: ${fmtINR(d.sum)}`}
                />
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex gap-3">
          {data.map((d) => (
            <div key={d.key} className="flex flex-1 flex-col items-center text-center">
              <div className="text-[11px] font-semibold text-ink2 truncate w-full" title={d.label}>{d.label}</div>
              <div className="mono-cap text-[9px] tracking-[.06em] text-mute">{d.count} lead{d.count === 1 ? "" : "s"}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
