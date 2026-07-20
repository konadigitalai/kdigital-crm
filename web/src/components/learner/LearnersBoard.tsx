"use client";

// Learners board — feature parity with EnrollmentsBoard, built on the same
// generic infrastructure (ViewTabs, FilterBar, useFilter, applyFilter). Composes:
//   • KPI stat cards (Total / In batch / Not batched / Placed)
//   • custom saved views via <ViewTabs scope="learners_list"> (no preset tabs)
//   • List / Kanban / Chart / Calendar view switcher
//   • group-by pill, quick-filter pills, full "Add filter" rule builder
//   • URL sync of mode + active saved view
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
import { avatarGradClass, gradFor, initialsOf } from "@/lib/ui";
import {
  getLearners, getViewPreferences, updateViewPreferences,
  type UserViewPreference,
} from "@/lib/api";
import type { FilterField, FilterState } from "@/components/filter/types";
import type { CurrentUser, LearnerSummary, LearnerBoardSummary, SavedView } from "@/lib/types";
import {
  LEARNER_LIST_COLUMNS, LEARNER_LIST_DEFAULT_COLUMNS, LearnersListView,
} from "./LearnersListView";
import {
  LEARNER_GROUP_BY_OPTIONS, LearnersKanban, learnerGroupKey, type LearnerGroupBy,
} from "./LearnersKanban";
import { LEARNER_CHART_RANGES, LearnersChartView, type LearnerChartRange } from "./LearnersChartView";
import { LearnersCalendarView } from "./LearnersCalendarView";

type ViewMode = "list" | "kanban" | "chart" | "calendar";
const VIEW_MODES: readonly ViewMode[] = ["list", "kanban", "chart", "calendar"];
function parseViewMode(raw: string | null): ViewMode {
  return VIEW_MODES.includes(raw as ViewMode) ? (raw as ViewMode) : "list";
}

/** DOM id of the Topbar slot the board portals its search input into. */
export const LEARNERS_SEARCH_SLOT_ID = "learners-topbar-search";

const POLL_MS = 45_000;

const STATUS_OPTIONS = [
  { value: "In batch", label: "In batch" },
  { value: "Assigned", label: "Assigned" },
  { value: "Enrolled", label: "Enrolled" },
];
const PLACEMENT_OPTIONS = [
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "placed",      label: "Placed" },
  { value: "deferred",    label: "Deferred" },
];
const SKILL_OPTIONS = [
  { value: "beginner",     label: "Beginner" },
  { value: "intermediate", label: "Intermediate" },
  { value: "advanced",     label: "Advanced" },
];

function unique(xs: (string | null | undefined)[]): string[] {
  return Array.from(new Set(xs.filter((x): x is string => typeof x === "string" && x !== "")));
}

function buildFields(rows: LearnerSummary[]): FilterField[] {
  const programs = unique(rows.map((r) => r.programName));
  const stacks   = unique(rows.map((r) => r.stackName));
  const advisors = unique(rows.map((r) => r.advisorName));
  const cities   = unique(rows.map((r) => r.city));
  const batches  = unique(rows.map((r) => r.batchCode));
  return [
    { key: "name",            label: "Learner",         type: "text",   get: (l: LearnerSummary) => l.name },
    { key: "email",           label: "Email",           type: "text",   get: (l: LearnerSummary) => l.email },
    { key: "phone",           label: "Phone",           type: "text",   get: (l: LearnerSummary) => l.phone },
    { key: "city",            label: "City",            type: "enum",   options: cities.map((c) => ({ value: c, label: c })),     get: (l: LearnerSummary) => l.city },
    { key: "program",         label: "Program",         type: "enum",   options: programs.map((p) => ({ value: p, label: p })),   get: (l: LearnerSummary) => l.programName },
    { key: "stack",           label: "Stack",           type: "enum",   options: stacks.map((s) => ({ value: s, label: s })),     get: (l: LearnerSummary) => l.stackName },
    { key: "status",          label: "Status",          type: "enum",   options: STATUS_OPTIONS,          get: (l: LearnerSummary) => l.status },
    { key: "advisor",         label: "Advisor",         type: "enum",   options: advisors.map((a) => ({ value: a, label: a })),   get: (l: LearnerSummary) => l.advisorName },
    { key: "placementStatus", label: "Placement",       type: "enum",   options: PLACEMENT_OPTIONS,       get: (l: LearnerSummary) => l.placementStatus },
    { key: "skillLevel",      label: "Skill level",     type: "enum",   options: SKILL_OPTIONS,           get: (l: LearnerSummary) => l.skillLevel },
    { key: "batchCode",       label: "Batch",           type: "enum",   options: batches.map((b) => ({ value: b, label: b })),    get: (l: LearnerSummary) => l.batchCode },
    { key: "activeCourses",   label: "Active courses",  type: "number", get: (l: LearnerSummary) => l.activeCourses },
    { key: "activeBatches",   label: "Active batches",  type: "number", get: (l: LearnerSummary) => l.activeBatches },
    { key: "learnerSince",    label: "Learner since",   type: "date",   get: (l: LearnerSummary) => l.learnerSince },
  ];
}

export function LearnersBoard({
  initialLearners,
  summary,
  initialViews,
  currentUser,
  canWrite,
  headerSlot,
}: {
  initialLearners: LearnerSummary[];
  summary: LearnerBoardSummary | null;
  initialViews: SavedView[];
  currentUser: CurrentUser | null;
  canWrite: boolean;
  headerSlot?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // ── local copy + light background poller ────────────────────────────────
  const [rows, setRows] = useState<LearnerSummary[]>(initialLearners);
  const incomingKey = useMemo(
    () => initialLearners.map((l) => [l.partyId, l.status, l.activeBatches, l.activeCourses, l.batchCode ?? "", l.placementStatus ?? ""].join("|")).join("·"),
    [initialLearners],
  );
  useEffect(() => {
    setRows(initialLearners);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingKey]);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      if (document.hidden) return;
      try {
        const fresh = await getLearners();
        if (!cancelled) setRows(fresh);
      } catch { /* silent — next tick retries */ }
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
  const [groupBy, setGroupBy] = useState<LearnerGroupBy | "none">("none");
  const axis: LearnerGroupBy = groupBy === "none" ? "status" : groupBy;
  const [chartRange, setChartRange] = useState<LearnerChartRange>("90d");
  const [calAdvisor, setCalAdvisor] = useState<string>("all");

  // Rows a view shows = the rule-builder filter. (Saved views cover preset cuts.)
  const visible = filtered;

  // ── saved views (scope learners_list) ────────────────────────────────────
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
    getViewPreferences("learners_list")
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
    updateViewPreferences("learners_list", payload).catch(() => { /* silent */ });
  }

  // ── topbar search portal ────────────────────────────────────────────────
  const [searchSlot, setSearchSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSearchSlot(document.getElementById(LEARNERS_SEARCH_SLOT_ID)); }, []);

  // Editing a filter by hand detaches from the active saved view.
  function changeFilter(next: FilterState) {
    setFilterState(next);
    if (activeViewId !== DEFAULT_VIEW_ID) setActiveViewId(DEFAULT_VIEW_ID);
  }

  const toolbar = (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="flex-shrink-0">
        <LearnerViewSwitcher value={view} onChange={setView} />
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
              <QuickFilterPill label="Status" options={STATUS_OPTIONS} state={filterState} fieldKey="status" onChange={changeFilter} anyLabel="All" />
              <QuickFilterPill label="Advisor" options={unique(rows.map((r) => r.advisorName)).map((a) => ({ value: a, label: a }))} state={filterState} fieldKey="advisor" onChange={changeFilter} anyLabel="All" />
            </>
          )}
          {view === "chart" && (
            <SelectPill label="Range" options={LEARNER_CHART_RANGES} value={chartRange} onChange={(v) => setChartRange(v as LearnerChartRange)} />
          )}
          {view === "calendar" && (
            <SelectPill
              label="Advisor"
              options={unique(rows.map((r) => r.advisorName)).map((a) => ({ value: a, label: a }))}
              value={calAdvisor}
              onChange={(v) => setCalAdvisor(v)}
              allValue="all"
              allLabel="All"
            />
          )}
          {(view === "list" || view === "kanban") && (
            <FilterBar fields={fields} state={filterState} onChange={changeFilter} />
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {searchSlot && createPortal(<LearnersSearchBox rows={rows} />, searchSlot)}

      {/* Saved views (top level) + header slot on the right. */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <ViewTabs
            views={views}
            activeId={activeViewId}
            onSelect={selectView}
            fields={fields}
            allColumns={LEARNER_LIST_COLUMNS}
            defaultColumns={LEARNER_LIST_DEFAULT_COLUMNS}
            currentFilter={filterState}
            currentColumns={(liveColumns ?? viewColumnsToPush ?? [...LEARNER_LIST_DEFAULT_COLUMNS]) as string[]}
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
        <LearnersListView
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
          {view === "kanban" && <LearnersKanban rows={visible} groupBy={axis} />}
          {view === "chart" && <LearnersChartView rows={visible} range={chartRange} />}
          {view === "calendar" && <LearnersCalendarView rows={visible} advisorFilter={calAdvisor} />}
        </>
      )}
    </>
  );
}

// ─── KPI stat cards ─────────────────────────────────────────────────────────

function KpiRow({ summary }: { summary: LearnerBoardSummary }) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiCard
        cap="Total learners"
        value={String(summary.totalLearners)}
        sub="Everyone enrolled"
        icon="users"
      />
      <KpiCard
        cap="In batch"
        value={String(summary.activeInBatch)}
        sub={`${summary.totalLearners > 0 ? Math.round((summary.activeInBatch / summary.totalLearners) * 100) : 0}% of learners`}
        icon="graduation-cap"
        accent="text-state-ok"
      />
      <KpiCard
        cap="Not batched"
        value={String(summary.notBatched)}
        sub="Awaiting a batch"
        icon="info"
        accent="text-state-amber"
      />
      <KpiCard
        cap="Placed"
        value={String(summary.placed)}
        sub={summary.completed > 0 ? `${summary.completed} completed` : "Placement tracked"}
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

function LearnerViewSwitcher({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
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

function GroupByPill({ value, onChange }: { value: LearnerGroupBy | "none"; onChange: (v: LearnerGroupBy | "none") => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);
  const active = value !== "none";
  const options: Array<{ value: LearnerGroupBy | "none"; label: string }> = [
    { value: "none", label: "None" },
    ...LEARNER_GROUP_BY_OPTIONS,
  ];
  const label = active ? (LEARNER_GROUP_BY_OPTIONS.find((o) => o.value === value)?.label ?? value) : "None";
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

// ─── LearnersSearchBox ──────────────────────────────────────────────────────
// Type-ahead over the loaded learners; jumps to /learners/:partyId.

export function LearnersSearchBox({ rows }: { rows: LearnerSummary[] }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as LearnerSummary[];
    const scored: Array<{ l: LearnerSummary; score: number }> = [];
    for (const l of rows) {
      const hay = [l.name, l.phone, l.email, l.city, l.programName, l.stackName, l.advisorName, l.batchCode, ...l.courseModules].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) continue;
      const nameLc = (l.name ?? "").toLowerCase();
      const score = nameLc.startsWith(q) ? 3 : nameLc.includes(q) ? 2 : 1;
      scored.push({ l, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 8).map((s) => s.l);
  }, [query, rows]);

  useEffect(() => { setActiveIdx(0); }, [query]);
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  function goTo(l: LearnerSummary) {
    router.push(`/learners/${l.partyId}`);
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
          placeholder="Search learners by name, program, batch, advisor…"
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
            <div className="px-4 py-4 text-center text-[12.5px] text-mute">No learners match “{query.trim()}”.</div>
          ) : (
            matches.map((l, i) => (
              <button
                type="button"
                key={l.partyId}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => goTo(l)}
                className={cn("flex w-full items-center gap-3 px-3 py-2 text-left transition", i === activeIdx ? "bg-warm/60" : "hover:bg-warm/40")}
              >
                <div className={cn("flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold text-white", avatarGradClass[gradFor(l.name)])}>
                  {initialsOf(l.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold text-ink">{l.name}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[11.5px] text-mute">
                    {[l.programName, l.batchCode, l.advisorName].filter(Boolean).join(" · ") || "—"}
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
