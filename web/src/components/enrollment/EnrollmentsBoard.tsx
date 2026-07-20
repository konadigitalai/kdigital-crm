"use client";

// Enrollments board — feature parity with LeadsBoard, built on the same generic
// infrastructure (ViewTabs, FilterBar, useFilter, applyFilter). Composes:
//   • KPI stat cards (Contracted / Collected / Overdue / Due in 7 days)
//   • fixed preset tabs (All / Overdue / Due soon / Not batched / Completed) —
//     built-in client-side quick filters, separate from user saved views
//   • custom saved views via <ViewTabs scope="enrollments_list">
//   • List / Kanban / Chart / Calendar view switcher
//   • group-by pill, quick-filter pills, full "Add filter" rule builder
//   • URL sync of mode + active saved view + preset tab
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
  getEnrollments, getViewPreferences, updateViewPreferences,
  type UserViewPreference,
} from "@/lib/api";
import type { FilterField, FilterState } from "@/components/filter/types";
import type { CurrentUser, Enrollment, EnrollmentSummary, SavedView } from "@/lib/types";
import {
  ENROLLMENT_LIST_COLUMNS, ENROLLMENT_LIST_DEFAULT_COLUMNS, EnrollmentsListView,
} from "./EnrollmentsListView";
import {
  ENROLL_GROUP_BY_OPTIONS, EnrollmentsKanban, enrollGroupKey, type EnrollGroupBy,
} from "./EnrollmentsKanban";
import { ENROLL_CHART_RANGES, EnrollmentsChartView, type EnrollChartRange } from "./EnrollmentsChartView";
import { EnrollmentsCalendarView } from "./EnrollmentsCalendarView";

type ViewMode = "list" | "kanban" | "chart" | "calendar";
const VIEW_MODES: readonly ViewMode[] = ["list", "kanban", "chart", "calendar"];
function parseViewMode(raw: string | null): ViewMode {
  return VIEW_MODES.includes(raw as ViewMode) ? (raw as ViewMode) : "list";
}

/** DOM id of the Topbar slot the board portals its search input into. */
export const ENROLLMENTS_SEARCH_SLOT_ID = "enrollments-topbar-search";

const POLL_MS = 45_000;

const PAYMENT_HEALTH_OPTIONS = [
  { value: "paid_in_full", label: "Paid in full" },
  { value: "on_track",     label: "On track" },
  { value: "due_soon",     label: "Due soon" },
  { value: "overdue",      label: "Overdue" },
  { value: "critical",     label: "Critical" },
];
const PAYMENT_STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "paid",    label: "Paid" },
  { value: "refund",  label: "Refund" },
  { value: "on_hold", label: "On hold" },
];
const STATUS_OPTIONS = [
  { value: "pending",   label: "Pending" },
  { value: "active",    label: "Active" },
  { value: "on_hold",   label: "On hold" },
  { value: "completed", label: "Completed" },
  { value: "dropped",   label: "Dropped" },
  { value: "deferred",  label: "Deferred" },
];

function unique(xs: (string | null | undefined)[]): string[] {
  return Array.from(new Set(xs.filter((x): x is string => typeof x === "string" && x !== "")));
}

function buildFields(rows: Enrollment[]): FilterField[] {
  const programs = unique(rows.map((r) => r.programName));
  const stacks   = unique(rows.map((r) => r.stackName));
  const advisors = unique(rows.map((r) => r.advisorName));
  const cities   = unique(rows.map((r) => r.city));
  const batches  = unique(rows.map((r) => r.batchCode));
  return [
    { key: "name",          label: "Learner",          type: "text",   get: (e: Enrollment) => e.name },
    { key: "number",        label: "ENR #",            type: "text",   get: (e: Enrollment) => e.number },
    { key: "email",         label: "Email",            type: "text",   get: (e: Enrollment) => e.email },
    { key: "phone",         label: "Phone",            type: "text",   get: (e: Enrollment) => e.phone },
    { key: "city",          label: "City",             type: "enum",   options: cities.map((c) => ({ value: c, label: c })),     get: (e: Enrollment) => e.city },
    { key: "program",       label: "Program",          type: "enum",   options: programs.map((p) => ({ value: p, label: p })),   get: (e: Enrollment) => e.programName },
    { key: "stack",         label: "Stack",            type: "enum",   options: stacks.map((s) => ({ value: s, label: s })),     get: (e: Enrollment) => e.stackName },
    { key: "advisor",       label: "Advisor",          type: "enum",   options: advisors.map((a) => ({ value: a, label: a })),   get: (e: Enrollment) => e.advisorName },
    { key: "status",        label: "Status",           type: "enum",   options: STATUS_OPTIONS,          get: (e: Enrollment) => e.status },
    { key: "paymentHealth", label: "Payment health",   type: "enum",   options: PAYMENT_HEALTH_OPTIONS,  get: (e: Enrollment) => e.paymentHealth },
    { key: "paymentStatus", label: "Payment status",   type: "enum",   options: PAYMENT_STATUS_OPTIONS,  get: (e: Enrollment) => e.paymentStatus },
    { key: "batchCode",     label: "Batch",            type: "enum",   options: batches.map((b) => ({ value: b, label: b })),    get: (e: Enrollment) => e.batchCode },
    { key: "feeQuoted",     label: "Total fee (₹)",    type: "number", get: (e: Enrollment) => e.feeQuoted ? Number(e.feeQuoted) : null },
    { key: "feePaid",       label: "Paid (₹)",         type: "number", get: (e: Enrollment) => e.feePaid ? Number(e.feePaid) : null },
    { key: "feeDue",        label: "Due (₹)",          type: "number", get: (e: Enrollment) => e.feeDue ? Number(e.feeDue) : null },
    { key: "dueDate",       label: "Next due",         type: "date",   get: (e: Enrollment) => e.dueDate },
    { key: "createdAt",     label: "Created",          type: "date",   get: (e: Enrollment) => e.createdAt },
    { key: "registeredDate",label: "Registered",       type: "date",   get: (e: Enrollment) => e.registeredDate },
  ];
}

export function EnrollmentsBoard({
  initialEnrollments,
  summary,
  initialViews,
  currentUser,
  canWrite,
  headerSlot,
}: {
  initialEnrollments: Enrollment[];
  summary: EnrollmentSummary | null;
  initialViews: SavedView[];
  currentUser: CurrentUser | null;
  canWrite: boolean;
  headerSlot?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // ── local copy + light background poller ────────────────────────────────
  const [rows, setRows] = useState<Enrollment[]>(initialEnrollments);
  const incomingKey = useMemo(
    () => initialEnrollments.map((e) => [e.id, e.status, e.feePaid ?? "", e.feeQuoted ?? "", e.dueDate ?? "", e.batchCode ?? ""].join("|")).join("·"),
    [initialEnrollments],
  );
  useEffect(() => {
    setRows(initialEnrollments);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingKey]);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      if (document.hidden) return;
      try {
        const fresh = await getEnrollments();
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

  // ── view mode + grouping axis + preset ──────────────────────────────────
  // Group-by is optional for the list (flat is the sane default) but Kanban
  // always needs an axis, so it falls back to status.
  const [view, setView] = useState<ViewMode>(() => parseViewMode(searchParams.get("v")));
  const [groupBy, setGroupBy] = useState<EnrollGroupBy | "none">("none");
  const axis: EnrollGroupBy = groupBy === "none" ? "status" : groupBy;
  const [chartRange, setChartRange] = useState<EnrollChartRange>("90d");
  const [calAdvisor, setCalAdvisor] = useState<string>("all");

  // Rows a view shows = the rule-builder filter. (Preset quick-tabs removed —
  // saved views cover those cuts.)
  const visible = filtered;

  // ── saved views (scope enrollments_list) ────────────────────────────────
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
    getViewPreferences("enrollments_list")
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
    updateViewPreferences("enrollments_list", payload).catch(() => { /* silent */ });
  }

  // ── topbar search portal ────────────────────────────────────────────────
  const [searchSlot, setSearchSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSearchSlot(document.getElementById(ENROLLMENTS_SEARCH_SLOT_ID)); }, []);

  // Editing a filter by hand detaches from the active saved view.
  function changeFilter(next: FilterState) {
    setFilterState(next);
    if (activeViewId !== DEFAULT_VIEW_ID) setActiveViewId(DEFAULT_VIEW_ID);
  }

  const toolbar = (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="flex-shrink-0">
        <EnrollViewSwitcher value={view} onChange={setView} />
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
              <QuickFilterPill label="Payment" options={PAYMENT_HEALTH_OPTIONS} state={filterState} fieldKey="paymentHealth" onChange={changeFilter} />
              <QuickFilterPill label="Advisor" options={unique(rows.map((r) => r.advisorName)).map((a) => ({ value: a, label: a }))} state={filterState} fieldKey="advisor" onChange={changeFilter} anyLabel="All" />
            </>
          )}
          {view === "chart" && (
            <SelectPill label="Range" options={ENROLL_CHART_RANGES} value={chartRange} onChange={(v) => setChartRange(v as EnrollChartRange)} />
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
      {searchSlot && createPortal(<EnrollmentsSearchBox rows={rows} />, searchSlot)}

      {/* Saved views (top level) + New enrollment on the right. */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <ViewTabs
            views={views}
            activeId={activeViewId}
            onSelect={selectView}
            fields={fields}
            allColumns={ENROLLMENT_LIST_COLUMNS}
            defaultColumns={ENROLLMENT_LIST_DEFAULT_COLUMNS}
            currentFilter={filterState}
            currentColumns={(liveColumns ?? viewColumnsToPush ?? [...ENROLLMENT_LIST_DEFAULT_COLUMNS]) as string[]}
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
        <EnrollmentsListView
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
          {view === "kanban" && <EnrollmentsKanban rows={visible} groupBy={axis} />}
          {view === "chart" && <EnrollmentsChartView rows={visible} range={chartRange} />}
          {view === "calendar" && <EnrollmentsCalendarView rows={visible} advisorFilter={calAdvisor} />}
        </>
      )}
    </>
  );
}

// ─── KPI stat cards ─────────────────────────────────────────────────────────

function fmtINRCompact(n: number): string {
  if (!n) return "₹0";
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(2).replace(/\.?0+$/, "")}Cr`;
  if (n >= 1_00_000)    return `₹${(n / 1_00_000).toFixed(2).replace(/\.?0+$/, "")}L`;
  if (n >= 1_000)       return `₹${Math.round(n / 1_000)}k`;
  return `₹${Math.round(n)}`;
}
const fmtINRFull = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

function KpiRow({ summary }: { summary: EnrollmentSummary }) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiCard
        cap="Contracted"
        value={fmtINRCompact(summary.contractedTotal)}
        title={fmtINRFull(summary.contractedTotal)}
        sub="Total fees quoted"
        icon="money"
      />
      <KpiCard
        cap="Collected"
        value={fmtINRCompact(summary.collectedTotal)}
        title={fmtINRFull(summary.collectedTotal)}
        sub={`${summary.collectedPct}% of contracted`}
        icon="check"
        accent="text-state-ok"
      />
      <KpiCard
        cap="Overdue"
        value={fmtINRCompact(summary.overdueTotal)}
        title={fmtINRFull(summary.overdueTotal)}
        sub={`${summary.overdueCount} enrollment${summary.overdueCount === 1 ? "" : "s"}`}
        icon="info"
        accent="text-state-warn"
      />
      <KpiCard
        cap="Due in 7 days"
        value={fmtINRCompact(summary.dueSoonTotal)}
        title={fmtINRFull(summary.dueSoonTotal)}
        sub={`${summary.dueSoonCount} enrollment${summary.dueSoonCount === 1 ? "" : "s"}`}
        icon="clock"
        accent="text-state-amber"
      />
    </div>
  );
}

function KpiCard({
  cap, value, title, sub, icon, accent,
}: {
  cap: string; value: string; title: string; sub: string; icon: IconName; accent?: string;
}) {
  return (
    <div className="rounded-[14px] border border-rule bg-paper p-[16px]">
      <div className="mb-2 flex items-center justify-between">
        <span className="mono-cap text-[9.5px] font-semibold tracking-[.12em] text-mute">{cap}</span>
        <Icon name={icon} size={14} strokeWidth={2} className={cn("text-hint", accent)} />
      </div>
      <div className={cn("text-[24px] font-bold leading-none tracking-[-.01em]", accent ?? "text-ink")} title={title}>
        {value}
      </div>
      <div className="mt-1.5 text-[11.5px] text-mute">{sub}</div>
    </div>
  );
}

// ─── view switcher ────────────────────────────────────────────────────────

function EnrollViewSwitcher({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
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

function GroupByPill({ value, onChange }: { value: EnrollGroupBy | "none"; onChange: (v: EnrollGroupBy | "none") => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);
  const active = value !== "none";
  const options: Array<{ value: EnrollGroupBy | "none"; label: string }> = [
    { value: "none", label: "None" },
    ...ENROLL_GROUP_BY_OPTIONS,
  ];
  const label = active ? (ENROLL_GROUP_BY_OPTIONS.find((o) => o.value === value)?.label ?? value) : "None";
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
// can never disagree. Mirrors LeadsBoard's QuickFilterPill.

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

// ─── EnrollmentsSearchBox ───────────────────────────────────────────────────
// Type-ahead over the loaded enrollments; jumps to /enrollments/:id.

export function EnrollmentsSearchBox({ rows }: { rows: Enrollment[] }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as Enrollment[];
    const scored: Array<{ e: Enrollment; score: number }> = [];
    for (const e of rows) {
      const hay = [e.name, e.number, e.phone, e.email, e.city, e.programName, e.stackName, e.advisorName, e.batchCode, ...e.courseModules].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) continue;
      const nameLc = (e.name ?? "").toLowerCase();
      const score = nameLc.startsWith(q) ? 3 : nameLc.includes(q) ? 2 : 1;
      scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 8).map((s) => s.e);
  }, [query, rows]);

  useEffect(() => { setActiveIdx(0); }, [query]);
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  function goTo(e: Enrollment) {
    router.push(`/enrollments/${encodeURIComponent(e.number ?? e.id)}`);
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
          placeholder="Search enrollments by name, ENR#, program, batch, advisor…"
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
            <div className="px-4 py-4 text-center text-[12.5px] text-mute">No enrollments match “{query.trim()}”.</div>
          ) : (
            matches.map((e, i) => (
              <button
                type="button"
                key={e.id}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => goTo(e)}
                className={cn("flex w-full items-center gap-3 px-3 py-2 text-left transition", i === activeIdx ? "bg-warm/60" : "hover:bg-warm/40")}
              >
                <div className={cn("flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold text-white", avatarGradClass[gradFor(e.name)])}>
                  {initialsOf(e.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold text-ink">{e.name}</span>
                    {e.number && <span className="mono-cap text-[9.5px] tracking-[.06em] text-hint">{e.number}</span>}
                  </div>
                  <div className="mt-0.5 truncate text-[11.5px] text-mute">
                    {[e.programName, e.batchCode, e.advisorName].filter(Boolean).join(" · ") || "—"}
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
