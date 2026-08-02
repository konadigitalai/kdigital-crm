"use client";

// Batches board — the operational board over existing batch data, built on the
// same generic infrastructure as LearnersBoard (ViewTabs, FilterBar, useFilter,
// applyFilter). Composes:
//   • KPI stat cards (Total / Running / Unstaffed / Under-enrolled / Fill / Cov)
//   • custom saved views via <ViewTabs scope="batches_list"> (no preset tabs)
//   • List / Kanban / Chart / Calendar view switcher
//   • group-by pill, quick-filter pills, full "Add filter" rule builder
//   • URL sync of mode + active saved view
//   • a "Rollups live" status dot driven by the background poller
//   • a topbar search box (portaled into the page's Topbar slot)

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DEFAULT_VIEW_ID, ViewTabs } from "@/components/pipeline/ViewTabs";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import { applyFilter } from "@/components/filter/operators";
import { AnchoredPopover } from "@/components/ui/AnchoredPopover";
import { Icon, type IconName } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  getBatchesBoard, getViewPreferences, updateViewPreferences,
  type UserViewPreference,
} from "@/lib/api";
import type { FilterField, FilterState } from "@/components/filter/types";
import type { CurrentUser, BatchBoardRow, BatchBoardSummary, SavedView } from "@/lib/types";
import {
  BATCH_LIST_COLUMNS, BATCH_LIST_DEFAULT_COLUMNS, BatchesListView,
} from "./BatchesListView";
import {
  BATCH_GROUP_BY_OPTIONS, BatchesKanban, type BatchGroupBy,
} from "./BatchesKanban";
import { BATCH_CHART_RANGES, BatchesChartView, type BatchChartRange } from "./BatchesChartView";
import { BatchesCalendarView } from "./BatchesCalendarView";
import { BATCH_STATUS_CLS as STATUS_CLS } from "@/lib/batchStatus";

type ViewMode = "list" | "kanban" | "chart" | "calendar";
const VIEW_MODES: readonly ViewMode[] = ["list", "kanban", "chart", "calendar"];
function parseViewMode(raw: string | null): ViewMode {
  return VIEW_MODES.includes(raw as ViewMode) ? (raw as ViewMode) : "list";
}

/** DOM id of the Topbar slot the board portals its search input into. */
export const BATCHES_SEARCH_SLOT_ID = "batches-search-slot";

const POLL_MS = 45_000;

const STATUS_OPTIONS = [
  { value: "upcoming",  label: "Upcoming",  cls: STATUS_CLS.upcoming },
  { value: "running",   label: "Running",   cls: STATUS_CLS.running },
  { value: "completed", label: "Completed", cls: STATUS_CLS.completed },
  { value: "cancelled", label: "Cancelled", cls: STATUS_CLS.cancelled },
];
const SLOT_OPTIONS = [
  { value: "morning",   label: "Morning" },
  { value: "afternoon", label: "Afternoon" },
  { value: "evening",   label: "Evening" },
];
const YES_NO_OPTIONS = [
  { value: "Yes", label: "Yes" },
  { value: "No",  label: "No" },
];

function slotTitle(slot: string | null): string {
  if (!slot) return "—";
  return slot[0]!.toUpperCase() + slot.slice(1);
}

function unique(xs: (string | null | undefined)[]): string[] {
  return Array.from(new Set(xs.filter((x): x is string => typeof x === "string" && x !== "")));
}

const NOT_ASSIGNED = "Not assigned";

function buildFields(rows: BatchBoardRow[]): FilterField[] {
  const families   = unique(rows.map((r) => r.family));
  const trainers = unique(rows.map((r) => r.trainerName));
  return [
    { key: "code",           label: "Code",          type: "text",   get: (b: BatchBoardRow) => b.code },
    { key: "name",           label: "Batch",         type: "text",   get: (b: BatchBoardRow) => b.name },
    { key: "family",          label: "Family",         type: "enum",   options: families.map((s) => ({ value: s, label: s })),   get: (b: BatchBoardRow) => b.family },
    { key: "status",         label: "Status",        type: "enum",   options: STATUS_OPTIONS,   get: (b: BatchBoardRow) => b.status },
    { key: "trainer",        label: "Trainer",       type: "enum",   options: [...trainers.map((t) => ({ value: t, label: t })), { value: NOT_ASSIGNED, label: NOT_ASSIGNED }], get: (b: BatchBoardRow) => b.trainerName ?? NOT_ASSIGNED },
    { key: "slot",           label: "Slot",          type: "enum",   options: SLOT_OPTIONS,     get: (b: BatchBoardRow) => b.slot },
    { key: "startDate",      label: "Start date",    type: "date",   get: (b: BatchBoardRow) => b.startDate },
    { key: "activeCount",    label: "Active",        type: "number", get: (b: BatchBoardRow) => b.activeCount },
    { key: "seats",          label: "Seats",         type: "number", get: (b: BatchBoardRow) => b.seats },
    { key: "coveragePct",    label: "Coverage %",    type: "number", get: (b: BatchBoardRow) => b.coveragePct },
    { key: "attendancePct",  label: "Attendance %",  type: "number", get: (b: BatchBoardRow) => b.attendancePct },
    { key: "staffed",        label: "Staffed",       type: "enum",   options: YES_NO_OPTIONS,   get: (b: BatchBoardRow) => b.staffed ? "Yes" : "No" },
    { key: "underEnrolled",  label: "Under-enrolled",type: "enum",   options: YES_NO_OPTIONS,   get: (b: BatchBoardRow) => b.underEnrolled ? "Yes" : "No" },
    { key: "behindSchedule", label: "Behind schedule", type: "enum", options: YES_NO_OPTIONS,   get: (b: BatchBoardRow) => b.behindSchedule ? "Yes" : "No" },
    { key: "slaBreached",    label: "SLA breached",  type: "enum",   options: YES_NO_OPTIONS,   get: (b: BatchBoardRow) => b.slaBreachCount > 0 ? "Yes" : "No" },
  ];
}

export function BatchesBoard({
  initialBatches,
  summary,
  initialViews,
  currentUser,
  canWrite,
  headerSlot,
}: {
  initialBatches: BatchBoardRow[];
  summary: BatchBoardSummary | null;
  initialViews: SavedView[];
  currentUser: CurrentUser | null;
  canWrite: boolean;
  headerSlot?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // ── local copy + light background poller ────────────────────────────────
  const [rows, setRows] = useState<BatchBoardRow[]>(initialBatches);
  const [live, setLive] = useState(true);
  const incomingKey = useMemo(
    () => initialBatches.map((b) => [b.id, b.status, b.activeCount, b.enrolmentCount, b.trainerId ?? "", b.staffed, b.underEnrolled].join("|")).join("·"),
    [initialBatches],
  );
  useEffect(() => {
    setRows(initialBatches);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingKey]);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      if (document.hidden) return;
      try {
        const fresh = await getBatchesBoard();
        if (!cancelled) { setRows(fresh); setLive(true); }
      } catch { if (!cancelled) setLive(false); }
    }
    const timer = setInterval(tick, POLL_MS);
    function onVisible() { if (!document.hidden) tick(); }
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  // ── filter (rule builder) ───────────────────────────────────────────────
  const fields = useMemo(() => buildFields(rows), [rows]);
  const [filtered, filterState, setFilterState] = useFilter(rows, fields);

  // ── view mode + grouping axis ────────────────────────────────────────────
  // Group-by is optional for the list (flat is the sane default) but Kanban
  // always needs an axis, so it falls back to status.
  const [view, setView] = useState<ViewMode>(() => parseViewMode(searchParams.get("v")));
  const [groupBy, setGroupBy] = useState<BatchGroupBy | "none">("none");
  const axis: BatchGroupBy = groupBy === "none" ? "status" : groupBy;
  const [chartRange, setChartRange] = useState<BatchChartRange>("90d");

  // Rows a view shows = the rule-builder filter. (Saved views cover preset cuts.)
  const visible = filtered;

  // ── saved views (scope batches_list) ─────────────────────────────────────
  const [views, setViews] = useState<SavedView[]>(initialViews);
  const [activeViewId, setActiveViewId] = useState<string>(() => {
    const fromUrl = searchParams.get("view");
    if (!fromUrl || fromUrl === DEFAULT_VIEW_ID) return DEFAULT_VIEW_ID;
    return initialViews.some((v) => v.id === fromUrl) ? fromUrl : DEFAULT_VIEW_ID;
  });
  const [liveColumns, setLiveColumns] = useState<string[] | null>(null);
  const activeView = activeViewId === DEFAULT_VIEW_ID ? null : views.find((v) => v.id === activeViewId) ?? null;
  const viewColumnsToPush = activeView?.columns ?? null;

  // URL sync: ?v=<mode> ?view=<id>. Defaults omitted.
  useEffect(() => {
    const desiredMode  = view === "list" ? null : view;
    const desiredView  = activeViewId === DEFAULT_VIEW_ID ? null : activeViewId;
    if (
      searchParams.get("v") === desiredMode
      && searchParams.get("view") === desiredView
    ) return;
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, val] of [["v", desiredMode], ["view", desiredView]] as const) {
      if (val) next.set(key, val); else next.delete(key);
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [view, activeViewId, pathname, router, searchParams]);

  function selectView(id: string) {
    setActiveViewId(id);
    if (id === DEFAULT_VIEW_ID) { setFilterState({ combinator: "and", rules: [] }); return; }
    const v = views.find((x) => x.id === id);
    if (!v) return;
    const knownKeys = new Set(fields.map((f) => f.key));
    const raw = (v.filter && typeof v.filter === "object") ? (v.filter as Record<string, unknown>) : {};
    const rulesRaw = Array.isArray(raw.rules) ? raw.rules : [];
    const parsedRules = rulesRaw
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .filter((r) => typeof r.fieldKey === "string" && knownKeys.has(r.fieldKey as string))
      .map((r) => {
        const op = String(r.operator ?? "");
        let value = r.value;
        if ((op === "is_any_of" || op === "is_none_of") && !Array.isArray(value)) {
          value = value == null ? [] : [String(value)];
        }
        return { id: `v${Math.random().toString(36).slice(2, 10)}`, fieldKey: r.fieldKey as string, operator: op, value };
      });
    setFilterState({
      combinator: raw.combinator === "or" ? "or" : "and",
      rules: parsedRules as unknown as FilterState["rules"],
    });
  }

  const hydratedOnceRef = useRef(false);
  useEffect(() => {
    if (hydratedOnceRef.current) return;
    hydratedOnceRef.current = true;
    if (activeViewId !== DEFAULT_VIEW_ID) selectView(activeViewId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tabCounts = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = { [DEFAULT_VIEW_ID]: rows.length };
    for (const v of views) {
      const raw = (v.filter && typeof v.filter === "object") ? (v.filter as Record<string, unknown>) : {};
      const rulesRaw = Array.isArray(raw.rules) ? raw.rules : [];
      const parsed = rulesRaw
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        .filter((r) => typeof r.fieldKey === "string")
        .map((r) => ({ id: `c${Math.random().toString(36).slice(2, 8)}`, fieldKey: r.fieldKey as string, operator: String(r.operator ?? ""), value: r.value }));
      out[v.id] = applyFilter(
        { combinator: raw.combinator === "or" ? "or" : "and", rules: parsed as unknown as FilterState["rules"] },
        rows, fields,
      ).length;
    }
    return out;
  }, [views, rows, fields]);

  // ── per-user view preferences ───────────────────────────────────────────
  const [hiddenViewIds, setHiddenViewIds] = useState<string[]>([]);
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    getViewPreferences("batches_list")
      .then((prefs: UserViewPreference[]) => {
        if (cancelled) return;
        setHiddenViewIds(prefs.filter((p) => p.hidden).map((p) => p.viewId ?? DEFAULT_VIEW_ID));
        setTabOrder([...prefs].filter((p) => !p.hidden).sort((a, b) => a.sortOrder - b.sortOrder).map((p) => p.viewId ?? DEFAULT_VIEW_ID));
      })
      .catch(() => { /* silent — defaults are fine */ });
    return () => { cancelled = true; };
  }, []);

  function onPrefsChange(next: { hiddenViewIds: string[]; tabOrder: string[] }) {
    setHiddenViewIds(next.hiddenViewIds);
    setTabOrder(next.tabOrder);
    const seen = new Set<string>();
    const payload: Array<{ viewId: string | null; hidden?: boolean; sortOrder?: number }> = [];
    next.tabOrder.forEach((id, i) => {
      seen.add(id);
      payload.push({ viewId: id === DEFAULT_VIEW_ID ? null : id, hidden: next.hiddenViewIds.includes(id), sortOrder: i });
    });
    for (const id of next.hiddenViewIds) {
      if (seen.has(id)) continue;
      payload.push({ viewId: id === DEFAULT_VIEW_ID ? null : id, hidden: true });
    }
    updateViewPreferences("batches_list", payload).catch(() => { /* silent */ });
  }

  // ── topbar search portal ────────────────────────────────────────────────
  const [searchSlot, setSearchSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSearchSlot(document.getElementById(BATCHES_SEARCH_SLOT_ID)); }, []);

  // Editing a filter by hand detaches from the active saved view.
  function changeFilter(next: FilterState) {
    setFilterState(next);
    if (activeViewId !== DEFAULT_VIEW_ID) setActiveViewId(DEFAULT_VIEW_ID);
  }

  const toolbar = (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="flex-shrink-0">
        <BatchViewSwitcher value={view} onChange={setView} />
      </div>
      <div
        className="min-w-0 flex-1 overflow-x-auto scroll-x-clean"
        onWheel={(e) => {
          const el = e.currentTarget;
          if (el.scrollWidth <= el.clientWidth) return;
          if (e.deltaY !== 0 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
        }}
      >
        <div className="flex w-max flex-nowrap items-center gap-2.5 [&>*]:flex-shrink-0">
          {(view === "list" || view === "kanban") && (
            <GroupByPill value={groupBy} onChange={setGroupBy} />
          )}
          {(view === "list" || view === "kanban") && (
            <>
              <QuickFilterPill label="Family" options={unique(rows.map((r) => r.family)).map((s) => ({ value: s, label: s }))} state={filterState} fieldKey="family" onChange={changeFilter} anyLabel="All" />
              <QuickFilterPill label="Slot" options={SLOT_OPTIONS} state={filterState} fieldKey="slot" onChange={changeFilter} anyLabel="All" />
              <QuickFilterPill label="Trainer" options={[...unique(rows.map((r) => r.trainerName)).map((t) => ({ value: t, label: t })), { value: NOT_ASSIGNED, label: NOT_ASSIGNED }]} state={filterState} fieldKey="trainer" onChange={changeFilter} anyLabel="All" />
            </>
          )}
          {view === "chart" && (
            <SelectPill label="Range" options={BATCH_CHART_RANGES} value={chartRange} onChange={(v) => setChartRange(v as BatchChartRange)} />
          )}
          {(view === "list" || view === "kanban") && (
            <FilterBar fields={fields} state={filterState} onChange={changeFilter} />
          )}
        </div>
      </div>
      <div className="flex-shrink-0">
        <RollupsStatus live={live} />
      </div>
    </div>
  );

  return (
    <>
      {searchSlot && createPortal(<BatchesSearchBox rows={rows} />, searchSlot)}

      {/* Saved views (top level) + header slot on the right. */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <ViewTabs
            scope="batches_list"
            allLabel="All batches"
            views={views}
            activeId={activeViewId}
            onSelect={selectView}
            fields={fields}
            allColumns={BATCH_LIST_COLUMNS}
            defaultColumns={BATCH_LIST_DEFAULT_COLUMNS}
            currentFilter={filterState}
            currentColumns={(liveColumns ?? viewColumnsToPush ?? [...BATCH_LIST_DEFAULT_COLUMNS]) as string[]}
            onChange={setViews}
            currentUser={currentUser}
            canShare={canWrite}
            counts={tabCounts}
            hiddenViewIds={hiddenViewIds}
            tabOrder={tabOrder}
            onPreferencesChange={onPrefsChange}
          />
        </div>
        {headerSlot && <div className="flex-shrink-0">{headerSlot}</div>}
      </div>

      {/* KPI stat cards */}
      {summary && <KpiRow summary={summary} />}

      {view === "list" ? (
        <BatchesListView
          rows={visible}
          groupBy={groupBy === "none" ? null : groupBy}
          viewColumns={viewColumnsToPush}
          onColumnsChange={setLiveColumns}
          toolbarSlot={toolbar}
          hasActiveFilter={filterState.rules.length > 0}
          onClearFilter={() => changeFilter({ combinator: "and", rules: [] })}
        />
      ) : (
        <>
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">{toolbar}</div>
          </div>
          {view === "kanban" && <BatchesKanban rows={visible} groupBy={axis} />}
          {view === "chart" && <BatchesChartView rows={visible} range={chartRange} />}
          {view === "calendar" && <BatchesCalendarView rows={visible} />}
        </>
      )}
    </>
  );
}

// ─── Rollups live status ─────────────────────────────────────────────────────

function RollupsStatus({ live }: { live: boolean }) {
  return (
    <div className="mono-cap flex items-center gap-1.5 text-[9.5px] font-semibold tracking-[.1em] text-mute">
      <span
        className={cn(
          "h-[7px] w-[7px] flex-shrink-0 rounded-full",
          live ? "live-dot bg-state-ok shadow-[0_0_10px_#2E9E6A]" : "bg-hint",
        )}
      />
      {live ? "Rollups live" : "Reconnecting"}
    </div>
  );
}

// ─── KPI stat cards ─────────────────────────────────────────────────────────

function KpiRow({ summary }: { summary: BatchBoardSummary }) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
      <KpiCard
        cap="Total batches"
        value={String(summary.totalBatches)}
        sub="All batches"
        icon="batches"
      />
      <KpiCard
        cap="Running"
        value={String(summary.running)}
        sub={`${summary.upcoming} upcoming`}
        icon="check"
        accent="text-state-ok"
      />
      <KpiCard
        cap="Unstaffed"
        value={String(summary.unstaffed)}
        sub="No trainer"
        icon="info"
        accent="text-state-amber"
      />
      <KpiCard
        cap="Under-enrolled"
        value={String(summary.underEnrolled)}
        sub="Below target"
        icon="users"
        accent="text-brand-magenta"
      />
      <KpiCard
        cap="Fill"
        value={summary.fillPct != null ? `${summary.fillPct}%` : "—"}
        sub={`${summary.totalActive}/${summary.totalSeats} seats`}
        icon="chart"
        accent="text-brand-blue"
      />
      <KpiCard
        cap="Avg coverage"
        value={summary.avgCoveragePct != null ? `${summary.avgCoveragePct}%` : "—"}
        sub="Session coverage"
        icon="star"
        accent="text-brand-violet"
      />
    </div>
  );
}

function KpiCard({
  cap, value, sub, icon, accent,
}: {
  cap: string; value: string; sub: string; icon: IconName; accent?: string;
}) {
  return (
    <div className="rounded-[14px] border border-rule bg-paper p-[16px]">
      <div className="mb-2 flex items-center justify-between">
        <span className="mono-cap text-[9.5px] font-semibold tracking-[.12em] text-mute">{cap}</span>
        <Icon name={icon} size={14} strokeWidth={2} className={cn("text-hint", accent)} />
      </div>
      <div className={cn("text-[24px] font-bold leading-none tracking-[-.01em]", accent ?? "text-ink")}>
        {value}
      </div>
      <div className="mt-1.5 text-[11.5px] text-mute">{sub}</div>
    </div>
  );
}

// ─── view switcher ────────────────────────────────────────────────────────

function BatchViewSwitcher({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  const items: Array<{ key: ViewMode; label: string; icon: IconName }> = [
    { key: "list",     label: "List",     icon: "bars" },
    { key: "kanban",   label: "Kanban",   icon: "agents-grid" },
    { key: "chart",    label: "Chart",    icon: "chart" },
    { key: "calendar", label: "Calendar", icon: "calendar" },
  ];
  return (
    <div className="inline-flex rounded-full border border-rule bg-paper p-1 text-[12.5px]">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
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

// ─── GroupByPill ──────────────────────────────────────────────────────────

function GroupByPill({ value, onChange }: { value: BatchGroupBy | "none"; onChange: (v: BatchGroupBy | "none") => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);
  const active = value !== "none";
  const options: Array<{ value: BatchGroupBy | "none"; label: string }> = [
    { value: "none", label: "None" },
    ...BATCH_GROUP_BY_OPTIONS,
  ];
  const label = active ? (BATCH_GROUP_BY_OPTIONS.find((o) => o.value === value)?.label ?? value) : "None";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition",
          active ? "border-brand-violet bg-brand-violet/10 text-brand-violet" : "border-rule bg-paper text-ink2 hover:border-rule2 hover:text-ink",
        )}
      >
        <span className="mono-cap text-[9.5px] tracking-[.08em] text-mute">Group by</span>
        <span>{label}</span>
        <span className="text-[9px] text-mute">▾</span>
      </button>
      {open && (
        <AnchoredPopover anchor={ref.current} className="min-w-[160px]">
          {options.map((o) => (
            <button
              type="button"
              key={o.value}
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={cn("block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-warm", value === o.value && "bg-warm font-semibold")}
            >
              {o.label}
            </button>
          ))}
        </AnchoredPopover>
      )}
    </div>
  );
}

// ─── QuickFilterPill ──────────────────────────────────────────────────────
// Writes into the same FilterState the FilterBar edits, so pills + rule builder
// can never disagree.

function QuickFilterPill({
  label, options, state, fieldKey, onChange, anyLabel = "Any",
}: {
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  state: FilterState;
  fieldKey: string;
  onChange: (next: FilterState) => void;
  anyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);
  const currentRule = state.rules.find((r) => r.fieldKey === fieldKey);
  const currentVal = currentRule && currentRule.operator === "is" && typeof currentRule.value === "string" ? currentRule.value : "";
  const currentLabel = currentVal ? (options.find((o) => o.value === currentVal)?.label ?? currentVal) : anyLabel;
  function pick(value: string) {
    const others = state.rules.filter((r) => r.fieldKey !== fieldKey);
    if (!value) onChange({ ...state, rules: others });
    else onChange({ ...state, rules: [...others, { id: `q${Math.random().toString(36).slice(2, 8)}`, fieldKey, operator: "is", value }] });
    setOpen(false);
  }
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition",
          currentVal ? "border-brand-violet bg-brand-violet/10 text-brand-violet" : "border-rule bg-paper text-ink2 hover:border-rule2 hover:text-ink",
        )}
      >
        <span className="mono-cap text-[9.5px] tracking-[.08em] text-mute">{label}:</span>
        <span>{currentLabel}</span>
        <span className="text-[9px] text-mute">▾</span>
      </button>
      {open && (
        <AnchoredPopover anchor={ref.current} className="max-h-[320px] min-w-[180px] overflow-y-auto">
          <button type="button" onClick={() => pick("")} className={cn("block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-warm", !currentVal && "bg-warm font-semibold")}>
            {anyLabel}
          </button>
          <div className="my-1 border-t border-rule" />
          {options.map((o) => (
            <button type="button" key={o.value} onClick={() => pick(o.value)} className={cn("block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-warm", currentVal === o.value && "bg-warm font-semibold")}>
              {o.label}
            </button>
          ))}
        </AnchoredPopover>
      )}
    </div>
  );
}

// ─── SelectPill (plain local state) ─────────────────────────────────────────

function SelectPill({
  label, options, value, onChange, allValue, allLabel = "Any",
}: {
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (v: string) => void;
  allValue?: string;
  allLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);
  const isAll = allValue !== undefined && value === allValue;
  const current = isAll ? allLabel : (options.find((o) => o.value === value)?.label ?? String(value));
  const active = allValue !== undefined && !isAll;
  const choices = [
    ...(allValue !== undefined ? [{ value: allValue, label: allLabel }] : []),
    ...options.map((o) => ({ value: o.value, label: o.label })),
  ];
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition",
          active ? "border-brand-violet bg-brand-violet/10 text-brand-violet" : "border-rule bg-paper text-ink2 hover:border-rule2 hover:text-ink",
        )}
      >
        <span className="mono-cap text-[9.5px] tracking-[.08em] text-mute">{label}:</span>
        <span>{current}</span>
        <span className="text-[9px] text-mute">▾</span>
      </button>
      {open && (
        <AnchoredPopover anchor={ref.current} className="max-h-[320px] min-w-[180px] overflow-y-auto">
          {choices.map((o, i) => (
            <div key={o.value}>
              {allValue !== undefined && i === 1 && <div className="my-1 border-t border-rule" />}
              <button type="button" onClick={() => { onChange(o.value); setOpen(false); }} className={cn("block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-warm", value === o.value && "bg-warm font-semibold")}>
                {o.label}
              </button>
            </div>
          ))}
        </AnchoredPopover>
      )}
    </div>
  );
}

// ─── BatchesSearchBox ─────────────────────────────────────────────────────────
// Type-ahead over the loaded batches; jumps to /batches/:id.

export function BatchesSearchBox({ rows }: { rows: BatchBoardRow[] }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as BatchBoardRow[];
    const scored: Array<{ b: BatchBoardRow; score: number }> = [];
    for (const b of rows) {
      const hay = [b.code, b.name, b.family, b.trainerName].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) continue;
      const nameLc = (b.name ?? "").toLowerCase();
      const codeLc = (b.code ?? "").toLowerCase();
      const score = codeLc.startsWith(q) || nameLc.startsWith(q) ? 3 : nameLc.includes(q) ? 2 : 1;
      scored.push({ b, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 8).map((s) => s.b);
  }, [query, rows]);

  useEffect(() => { setActiveIdx(0); }, [query]);
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  function goTo(b: BatchBoardRow) {
    router.push(`/batches/${b.id}`);
    setOpen(false);
    setQuery("");
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); return; }
    if (!open || matches.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, matches.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const m = matches[activeIdx]; if (m) goTo(m); }
  }

  return (
    <div ref={boxRef} className="relative">
      <div className="flex items-center gap-2 rounded-full border border-rule bg-paper px-4 py-2 focus-within:border-brand-violet focus-within:ring-2 focus-within:ring-brand-violet/20">
        <Icon name="search" size={15} strokeWidth={2} className="text-mute" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => query.trim() && setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search batches by code, name, family, trainer…"
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink placeholder:text-hint outline-none"
        />
        {query && (
          <button type="button" onClick={() => { setQuery(""); inputRef.current?.focus(); }} aria-label="Clear search" className="text-mute hover:text-ink">
            <Icon name="plus" size={12} strokeWidth={2.4} className="rotate-45" />
          </button>
        )}
      </div>
      {open && query.trim() && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[400px] overflow-y-auto rounded-[12px] border border-rule bg-paper py-1 shadow-card">
          {matches.length === 0 ? (
            <div className="px-4 py-4 text-center text-[12.5px] text-mute">No batches match “{query.trim()}”.</div>
          ) : (
            matches.map((b, i) => (
              <button
                type="button"
                key={b.id}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => goTo(b)}
                className={cn("flex w-full items-center gap-3 px-3 py-2 text-left transition", i === activeIdx ? "bg-warm/60" : "hover:bg-warm/40")}
              >
                <span className={cn("mono-cap inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-[9px] font-semibold capitalize", STATUS_CLS[b.status] ?? "bg-warm2 text-mute")}>
                  {b.status}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold text-ink">{b.name}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[11.5px] text-mute">
                    {[b.code, b.family, b.trainerName, slotTitle(b.slot) !== "—" ? slotTitle(b.slot) : null].filter(Boolean).join(" · ") || "—"}
                  </div>
                </div>
              </button>
            ))
          )}
          <div className="mono-cap border-t border-rule px-3 py-1.5 text-[9.5px] tracking-[.1em] text-hint">
            {matches.length === 0 ? "0 matches" : `${matches.length} of ${rows.length} · ↑↓ navigate · enter opens`}
          </div>
        </div>
      )}
    </div>
  );
}
