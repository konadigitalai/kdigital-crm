"use client";

// Cases board — the operational board over the case queue, built on the same
// generic infrastructure as BatchesBoard (ViewTabs, FilterBar, useFilter,
// applyFilter). Composes:
//   • KPI stat cards (Open / Unassigned / SLA breaching / Refunds / Auto / Reopened)
//   • custom saved views via <ViewTabs scope="cases_list"> (no preset tabs)
//   • List / Dashboard view switcher
//   • quick-filter pills, full "Add filter" rule builder
//   • URL sync of mode + active saved view
//   • a "live" status dot driven by the background poller
//   • an "AUTO-DETECT ON" pill (display-only)
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
  getCases, getViewPreferences, updateViewPreferences,
  type UserViewPreference,
} from "@/lib/api";
import type { FilterField, FilterState } from "@/components/filter/types";
import type { Case, CaseDashboard, CurrentUser, SavedView } from "@/lib/types";
import { STATUS_LABEL } from "./StatusPill";
import { CaseDashboardCards } from "./CaseDashboardCards";
import {
  CASE_LIST_COLUMNS, CASE_LIST_DEFAULT_COLUMNS, CasesListView,
} from "./CasesListView";

type ViewMode = "list" | "dashboard";
const VIEW_MODES: readonly ViewMode[] = ["list", "dashboard"];
function parseViewMode(raw: string | null): ViewMode {
  return VIEW_MODES.includes(raw as ViewMode) ? (raw as ViewMode) : "list";
}

/** DOM id of the Topbar slot the board portals its search input into. */
export const CASES_SEARCH_SLOT_ID = "cases-search-slot";

const POLL_MS = 45_000;

const CLOSED_STATUSES = ["resolved", "closed", "cancelled"];

const TYPE_GROUP_OPTIONS = [
  { value: "Money",    label: "Money" },
  { value: "Content",  label: "Content" },
  { value: "Delivery", label: "Delivery" },
  { value: "Access",   label: "Access" },
  { value: "Data",     label: "Data" },
  { value: "Other",    label: "Other" },
];
const SEVERITY_OPTIONS = [
  { value: "Critical", label: "Critical" },
  { value: "High",     label: "High" },
  { value: "Medium",   label: "Medium" },
  { value: "Low",      label: "Low" },
];
const STATUS_OPTIONS = (["open", "in_progress", "pending", "resolved", "closed", "cancelled"] as const)
  .map((s) => ({ value: s, label: STATUS_LABEL[s] }));
const SLA_OPTIONS = [
  { value: "met",      label: "Met" },
  { value: "paused",   label: "Paused" },
  { value: "none",     label: "None" },
  { value: "breached", label: "Breached" },
  { value: "active",   label: "Active" },
];
const SOURCE_OPTIONS = [
  { value: "manual", label: "Manual" },
  { value: "auto",   label: "Auto" },
];
const OPEN_STATE_OPTIONS = [
  { value: "Open",   label: "Open" },
  { value: "Closed", label: "Closed" },
];
const YES_NO_OPTIONS = [
  { value: "Yes", label: "Yes" },
  { value: "No",  label: "No" },
];

const UNASSIGNED = "Unassigned";

function unique(xs: (string | null | undefined)[]): string[] {
  return Array.from(new Set(xs.filter((x): x is string => typeof x === "string" && x !== "")));
}

function isClosed(status: string): boolean {
  return CLOSED_STATUSES.includes(status);
}

function buildFields(rows: Case[], currentUser: CurrentUser | null): FilterField[] {
  const owners = unique(rows.map((r) => r.assigneeName));
  return [
    { key: "case",          label: "Case",         type: "text",   get: (c: Case) => `${c.number} ${c.subject}` },
    { key: "party",         label: "Party",        type: "text",   get: (c: Case) => c.requesterName },
    { key: "typeGroup",     label: "Type",         type: "enum",   options: TYPE_GROUP_OPTIONS, get: (c: Case) => c.typeGroup },
    { key: "severity",      label: "Severity",     type: "enum",   options: SEVERITY_OPTIONS,   get: (c: Case) => c.severity },
    { key: "status",        label: "Status",       type: "enum",   options: STATUS_OPTIONS,     get: (c: Case) => c.status },
    { key: "owner",         label: "Owner",        type: "enum",   options: [...owners.map((o) => ({ value: o, label: o })), { value: UNASSIGNED, label: UNASSIGNED }], get: (c: Case) => c.assigneeName ?? UNASSIGNED },
    { key: "slaState",      label: "SLA",          type: "enum",   options: SLA_OPTIONS,        get: (c: Case) => c.slaState },
    { key: "source",        label: "Source",       type: "enum",   options: SOURCE_OPTIONS,     get: (c: Case) => c.source },
    { key: "openState",     label: "Open / Closed", type: "enum",  options: OPEN_STATE_OPTIONS, get: (c: Case) => isClosed(c.status) ? "Closed" : "Open" },
    { key: "refundPending", label: "Refund pending", type: "enum", options: YES_NO_OPTIONS,     get: (c: Case) => (c.category === "refund" && !isClosed(c.status)) ? "Yes" : "No" },
    { key: "preventable",   label: "Preventable",  type: "enum",   options: YES_NO_OPTIONS,     get: (c: Case) => c.preventable ? "Yes" : "No" },
    { key: "reopened",      label: "Reopened",     type: "enum",   options: YES_NO_OPTIONS,     get: (c: Case) => c.reopenCount > 0 ? "Yes" : "No" },
    { key: "mine",          label: "Mine",         type: "enum",   options: YES_NO_OPTIONS,     get: (c: Case) => (currentUser && c.assigneeId === currentUser.id) ? "Yes" : "No" },
  ];
}

export function CasesBoard({
  initialCases,
  dashboard,
  initialViews,
  currentUser,
  canWrite,
  headerSlot,
}: {
  initialCases: Case[];
  dashboard: CaseDashboard | null;
  initialViews: SavedView[];
  currentUser: CurrentUser | null;
  canWrite: boolean;
  headerSlot?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // ── local copy + light background poller ────────────────────────────────
  const [rows, setRows] = useState<Case[]>(initialCases);
  const [live, setLive] = useState(true);
  const incomingKey = useMemo(
    () => initialCases.map((c) => [c.id, c.status, c.assigneeId ?? "", c.slaState, c.displayStatus, c.reopenCount].join("|")).join("·"),
    [initialCases],
  );
  useEffect(() => {
    setRows(initialCases);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingKey]);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      if (document.hidden) return;
      try {
        const fresh = await getCases();
        if (!cancelled) { setRows(fresh); setLive(true); }
      } catch { if (!cancelled) setLive(false); }
    }
    const timer = setInterval(tick, POLL_MS);
    function onVisible() { if (!document.hidden) tick(); }
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  // ── filter (rule builder) ───────────────────────────────────────────────
  const fields = useMemo(() => buildFields(rows, currentUser), [rows, currentUser]);
  const [filtered, filterState, setFilterState] = useFilter(rows, fields);

  // ── view mode ─────────────────────────────────────────────────────────────
  const [view, setView] = useState<ViewMode>(() => parseViewMode(searchParams.get("v")));

  // Rows a view shows = the rule-builder filter. (Saved views cover preset cuts.)
  const visible = filtered;

  // ── saved views (scope cases_list) ───────────────────────────────────────
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
    getViewPreferences("cases_list")
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
    updateViewPreferences("cases_list", payload).catch(() => { /* silent */ });
  }

  // ── topbar search portal ────────────────────────────────────────────────
  const [searchSlot, setSearchSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSearchSlot(document.getElementById(CASES_SEARCH_SLOT_ID)); }, []);

  // Editing a filter by hand detaches from the active saved view.
  function changeFilter(next: FilterState) {
    setFilterState(next);
    if (activeViewId !== DEFAULT_VIEW_ID) setActiveViewId(DEFAULT_VIEW_ID);
  }

  const toolbar = (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="flex-shrink-0">
        <CaseViewSwitcher value={view} onChange={setView} />
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
          {view === "list" && (
            <>
              <QuickFilterPill label="Type" options={TYPE_GROUP_OPTIONS} state={filterState} fieldKey="typeGroup" onChange={changeFilter} anyLabel="All" />
              <QuickFilterPill label="Severity" options={SEVERITY_OPTIONS} state={filterState} fieldKey="severity" onChange={changeFilter} anyLabel="All" />
              <QuickFilterPill label="Status" options={STATUS_OPTIONS} state={filterState} fieldKey="status" onChange={changeFilter} anyLabel="All" />
              <QuickFilterPill label="Owner" options={[...unique(rows.map((r) => r.assigneeName)).map((o) => ({ value: o, label: o })), { value: UNASSIGNED, label: UNASSIGNED }]} state={filterState} fieldKey="owner" onChange={changeFilter} anyLabel="All" />
              <FilterBar fields={fields} state={filterState} onChange={changeFilter} />
            </>
          )}
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2.5">
        <AutoDetectPill />
        <LiveStatus live={live} />
      </div>
    </div>
  );

  return (
    <>
      {searchSlot && createPortal(<CasesSearchBox rows={rows} />, searchSlot)}

      {/* Saved views (top level) + header slot on the right. */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <ViewTabs
            scope="cases_list"
            allLabel="All cases"
            views={views}
            activeId={activeViewId}
            onSelect={selectView}
            fields={fields}
            allColumns={CASE_LIST_COLUMNS}
            defaultColumns={CASE_LIST_DEFAULT_COLUMNS}
            currentFilter={filterState}
            currentColumns={(liveColumns ?? viewColumnsToPush ?? [...CASE_LIST_DEFAULT_COLUMNS]) as string[]}
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
      <KpiRow dashboard={dashboard} rows={rows} />

      {view === "list" ? (
        <CasesListView
          rows={visible}
          groupBy={null}
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
          {dashboard && <CaseDashboardCards data={dashboard} />}
        </>
      )}
    </>
  );
}

// ─── Live status ─────────────────────────────────────────────────────────────

function LiveStatus({ live }: { live: boolean }) {
  return (
    <div className="mono-cap flex items-center gap-1.5 text-[9.5px] font-semibold tracking-[.1em] text-mute">
      <span
        className={cn(
          "h-[7px] w-[7px] flex-shrink-0 rounded-full",
          live ? "live-dot bg-state-ok shadow-[0_0_10px_#2E9E6A]" : "bg-hint",
        )}
      />
      {live ? "Live" : "Reconnecting"}
    </div>
  );
}

// ─── Auto-detect pill (display-only) ────────────────────────────────────────

function AutoDetectPill() {
  return (
    <div className="mono-cap inline-flex items-center gap-1.5 rounded-full border border-state-ok/30 bg-[rgba(46,158,106,.08)] px-2.5 py-1 text-[9px] font-semibold tracking-[.1em] text-state-ok">
      <span className="live-dot h-[6px] w-[6px] flex-shrink-0 rounded-full bg-state-ok shadow-[0_0_10px_#2E9E6A]" />
      AUTO-DETECT ON
    </div>
  );
}

// ─── KPI stat cards ─────────────────────────────────────────────────────────

function KpiRow({ dashboard, rows }: { dashboard: CaseDashboard | null; rows: Case[] }) {
  const c = dashboard?.counts;
  const open = c ? c.open + c.inProgress + c.pending : rows.filter((r) => !isClosed(r.status)).length;
  const unassigned = c ? c.unassigned : rows.filter((r) => !r.assigneeId).length;
  const slaBreaching = c ? c.slaBreaching : rows.filter((r) => r.slaState === "breached").length;
  const refundsPending = c ? c.refundsPending : rows.filter((r) => r.category === "refund" && !isClosed(r.status)).length;
  const autoDetected = rows.filter((r) => r.source === "auto").length;
  const reopened = rows.filter((r) => r.reopenCount > 0).length;

  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
      <KpiCard cap="Open"           value={String(open)}           sub="Active queue"     icon="inbox" accent="text-brand-blue" />
      <KpiCard cap="Unassigned"     value={String(unassigned)}     sub="No owner"         icon="users" accent="text-state-amber" />
      <KpiCard cap="SLA breaching"  value={String(slaBreaching)}   sub="Past due"         icon="clock" accent="text-state-warn" />
      <KpiCard cap="Refunds"        value={String(refundsPending)} sub="Pending refund"   icon="money" accent="text-brand-magenta" />
      <KpiCard cap="Auto-detected"  value={String(autoDetected)}   sub="Raised by system" icon="robot" accent="text-state-ok" />
      <KpiCard cap="Reopened"       value={String(reopened)}       sub="Bounced back"     icon="info"  accent="text-brand-violet" />
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

function CaseViewSwitcher({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  const items: Array<{ key: ViewMode; label: string; icon: IconName }> = [
    { key: "list",      label: "List",      icon: "bars" },
    { key: "dashboard", label: "Dashboard", icon: "chart" },
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

// ─── CasesSearchBox ─────────────────────────────────────────────────────────
// Type-ahead over the loaded cases; jumps to /cases/:number.

export function CasesSearchBox({ rows }: { rows: Case[] }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as Case[];
    const scored: Array<{ c: Case; score: number }> = [];
    for (const c of rows) {
      const hay = [c.number, c.subject, c.requesterName].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) continue;
      const numLc = (c.number ?? "").toLowerCase();
      const subjLc = (c.subject ?? "").toLowerCase();
      const score = numLc.startsWith(q) || subjLc.startsWith(q) ? 3 : subjLc.includes(q) ? 2 : 1;
      scored.push({ c, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 8).map((s) => s.c);
  }, [query, rows]);

  useEffect(() => { setActiveIdx(0); }, [query]);
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  function goTo(c: Case) {
    router.push(`/cases/${c.number}`);
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
          placeholder="Search cases by number, subject, party…"
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
            <div className="px-4 py-4 text-center text-[12.5px] text-mute">No cases match “{query.trim()}”.</div>
          ) : (
            matches.map((c, i) => (
              <button
                type="button"
                key={c.id}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => goTo(c)}
                className={cn("flex w-full items-center gap-3 px-3 py-2 text-left transition", i === activeIdx ? "bg-warm/60" : "hover:bg-warm/40")}
              >
                <span className="mono-cap inline-flex flex-shrink-0 items-center rounded-full bg-warm2 px-2 py-0.5 text-[9px] font-semibold text-mute">
                  {c.number}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold text-ink">{c.subject}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[11.5px] text-mute">
                    {[c.requesterName, c.displayStatus, c.severity].filter(Boolean).join(" · ") || "—"}
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
