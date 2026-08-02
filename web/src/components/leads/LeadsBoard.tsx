"use client";

// /leads grid view. Reuses PipelineListView (same component as
// /pipeline → List view): column picker, inline edit, bulk update,
// bulk delete, saved views (shared scope `pipeline_list` so a view
// shows up on both surfaces).

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PipelineListView, PIPELINE_LIST_COLUMNS, PIPELINE_LIST_DEFAULT_COLUMNS } from "@/components/pipeline/PipelineListView";
import {
  GROUP_BY_OPTIONS, groupKey, KanbanView, makeColumns,
  type GroupBy,
} from "@/components/pipeline/PipelineBoard";
import { LeadsCalendarView, type CalendarScale } from "@/components/leads/LeadsCalendarView";
import {
  LEADS_CHART_MEASURES, LeadsChartView,
  type LeadsChartMeasure, type LeadsChartRange,
} from "@/components/leads/LeadsChartView";
import { DEFAULT_VIEW_ID, ViewTabs } from "@/components/pipeline/ViewTabs";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import { Icon, type IconName } from "@/components/ui/Icon";
import { AnchoredPopover } from "@/components/ui/AnchoredPopover";
import { cn } from "@/lib/cn";
import { getLeads, getViewPreferences, updateLead, updateViewPreferences, type UserViewPreference } from "@/lib/api";
import { applyFilter } from "@/components/filter/operators";
import type { FilterField, FilterState } from "@/components/filter/types";
import type { CatalogResponse, CurrentUser, Lead, LeadTaskKind, LeadTaskStatus, SavedView } from "@/lib/types";
import { LEAD_RATINGS, LEAD_TASK_KINDS } from "@/lib/types";
import { avatarGradClass, ratingStyles, taskKindStyles } from "@/lib/ui";

// /leads carries a fourth view that /pipeline doesn't: a calendar of scheduled
// lead tasks. Rather than widen PipelineBoard's ViewMode (and give /pipeline a
// Calendar tab that has nothing to render), the leads surface owns its own
// mode union and its own switcher.
type LeadsViewMode = "list" | "kanban" | "chart" | "calendar";

const LEADS_VIEW_MODES: readonly LeadsViewMode[] = ["list", "kanban", "chart", "calendar"];

function parseViewMode(raw: string | null): LeadsViewMode {
  return LEADS_VIEW_MODES.includes(raw as LeadsViewMode) ? (raw as LeadsViewMode) : "list";
}

// Chart-view controls. These are deliberately NOT part of FilterState: they
// slice the chart's own presentation (what to measure, over what window) and
// mean nothing to the grid, so folding them into the shared filter would make
// switching views silently mutate the user's row set.
//
// The measure list comes from LeadsChartView rather than being restated here,
// so a measure can't appear in the pill without the maths to back it.
const RANGE_OPTIONS: Array<{ value: LeadsChartRange; label: string }> = [
  { value: "30d",     label: "Last 30 days" },
  { value: "90d",     label: "Last 90 days" },
  { value: "quarter", label: "This quarter" },
  { value: "all",     label: "All time" },
];

const TASK_KIND_OPTIONS = LEAD_TASK_KINDS.map((k) => ({
  value: k as LeadTaskKind,
  label: taskKindStyles[k].label,
}));

const TASK_STATUS_OPTIONS: Array<{ value: LeadTaskStatus; label: string }> = [
  { value: "open",      label: "Open" },
  { value: "done",      label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

/** DOM id of the Topbar slot that LeadsBoard portals its search input into.
 *  The page renders the (empty) node so it controls where it sits; the board
 *  fills it, because only the board has the live, post-poller lead list. */
export const LEADS_SEARCH_SLOT_ID = "leads-topbar-search";

// How often the background poller checks for new leads. Kept at 30s to
// balance responsiveness (users see a new lead within ~30s of the intake
// webhook firing) against API load (2 requests/min per open tab). Pauses
// entirely when the tab is hidden.
const POLL_MS = 30_000;

const RATING_OPTIONS = LEAD_RATINGS.map((r) => ({ value: r, label: ratingStyles[r].label }));

function unique<T>(xs: T[]): T[] {
  return Array.from(new Set(xs.filter((x): x is T & {} => x != null && (x as unknown) !== "")));
}

const DELIVERY_MODE_OPTIONS = [
  { value: "online",    label: "Online"    },
  { value: "classroom", label: "Classroom" },
  { value: "hybrid",    label: "Hybrid"    },
];

// Mirrors LEAD_STATUS_OPTIONS in PipelineListView. Duplicated because the
// filter builder here only cares about {value,label} pairs and shouldn't
// depend on grid-column plumbing.
const LEAD_STATUS_OPTIONS = [
  { value: "new",                       label: "New" },
  { value: "contacted",                 label: "Contacted" },
  { value: "interested",                label: "Interested" },
  { value: "demo_attended",             label: "Demo Attended" },
  { value: "visiting",                  label: "Visiting" },
  { value: "payment_link_sent",         label: "Payment Link Sent" },
  { value: "enrolled",                  label: "Enrolled" },
  { value: "lost_lead",                 label: "Lost Lead" },
  { value: "visited",                   label: "Visited" },
  { value: "interested_in_demo",        label: "Interested in Demo" },
  { value: "advance_talk_with_trainer", label: "Advance Talk With Trainer" },
  { value: "unqualified",               label: "Unqualified" },
];

const STAGE_OPTIONS = [
  { value: "new",  label: "New inbound" },
  { value: "qual", label: "Qualified"   },
  { value: "demo", label: "Demo / Trial" },
  { value: "neg",  label: "Negotiation" },
  { value: "won",  label: "Enrolled"    },
];

function buildFields(leads: Lead[]): FilterField[] {
  const families    = unique(leads.map((l) => l.family).filter((x): x is string => typeof x === "string" && x !== ""));
  const programs  = unique(leads.map((l) => l.program).filter((x): x is string => typeof x === "string" && x !== ""));
  const cities    = unique(leads.map((l) => l.city).filter((x): x is string => typeof x === "string" && x !== ""));
  const advisors  = unique(leads.map((l) => l.advisorName).filter((x): x is string => typeof x === "string" && x !== ""));
  const sources   = unique(leads.map((l) => l.sourceLabel ?? l.source ?? null).filter((x): x is string => typeof x === "string" && x !== ""));
  return [
    // Contact + identity
    { key: "name",             label: "Name",             type: "text",   get: (l: Lead) => l.name },
    { key: "number",           label: "Lead #",           type: "text",   get: (l: Lead) => l.number },
    { key: "email",            label: "Email",            type: "text",   get: (l: Lead) => l.email },
    { key: "phone",            label: "Phone",            type: "text",   get: (l: Lead) => l.phone },
    { key: "city",             label: "City",             type: "enum",   options: cities.map((c) => ({ value: c, label: c })), get: (l: Lead) => l.city },
    // Assignment / classification
    // Family is read-only and derived from the program, but it's still a
    // perfectly good thing to filter and group by — "show me everything in the
    // Full AI Family" is a coarser cut than picking its programs one by one.
    { key: "family",            label: "Family",            type: "enum",   options: families.map((s) => ({ value: s, label: s })),    get: (l: Lead) => l.family },
    { key: "program",          label: "Program",          type: "enum",   options: programs.map((p) => ({ value: p, label: p })), get: (l: Lead) => l.program },
    { key: "advisor",          label: "Advisor",          type: "enum",   options: advisors.map((a) => ({ value: a, label: a })), get: (l: Lead) => l.advisorName },
    { key: "source",           label: "Source",           type: "enum",   options: sources.map((s) => ({ value: s, label: s })),  get: (l: Lead) => l.sourceLabel ?? l.source },
    { key: "rating",           label: "Rating",           type: "enum",   options: RATING_OPTIONS,  get: (l: Lead) => l.rating },
    { key: "leadStatus",       label: "Lead status",      type: "enum",   options: LEAD_STATUS_OPTIONS, get: (l: Lead) => l.leadStatus },
    { key: "stage",            label: "Stage",            type: "enum",   options: STAGE_OPTIONS,   get: (l: Lead) => l.stage },
    { key: "deliveryMode",     label: "Mode",             type: "enum",   options: DELIVERY_MODE_OPTIONS, get: (l: Lead) => l.deliveryMode },
    // Score + NBA
    { key: "score",            label: "Score",            type: "number", get: (l: Lead) => l.score },
    { key: "nbaLabel",         label: "Next action",      type: "text",   get: (l: Lead) => l.nbaLabel },
    // Money
    { key: "value",            label: "Price quoted (₹)", type: "number", get: (l: Lead) => l.value ? Number(l.value) : null },
    { key: "feePaid",          label: "Fee paid (₹)",     type: "number", get: (l: Lead) => l.feePaid ? Number(l.feePaid) : null },
    { key: "feeDue",           label: "Fee due (₹)",      type: "number", get: (l: Lead) => l.feeDue ? Number(l.feeDue) : null },
    // Dates
    { key: "nextFollowupAt",   label: "Next follow-up",   type: "date",   get: (l: Lead) => l.nextFollowupAt },
    { key: "demoAttendedAt",   label: "Demo attended",    type: "date",   get: (l: Lead) => l.demoAttendedAt },
    { key: "visitedDate",      label: "Visited",          type: "date",   get: (l: Lead) => l.visitedDate },
    { key: "visitingDate",     label: "Visiting",         type: "date",   get: (l: Lead) => l.visitingDate },
    { key: "dueDate",          label: "Due date",         type: "date",   get: (l: Lead) => l.dueDate },
    { key: "registeredDate",   label: "Registered",       type: "date",   get: (l: Lead) => l.registeredDate },
    { key: "createdAt",        label: "Created",          type: "date",   get: (l: Lead) => l.createdAt },
    // Free-text notes
    { key: "description",      label: "Description",      type: "text",   get: (l: Lead) => l.description },
  ];
}

export function LeadsBoard({
  initialLeads,
  catalog,
  initialViews,
  currentUser,
  canWrite,
  canDelete,
  headerSlot,
}: {
  initialLeads: Lead[];
  catalog: CatalogResponse;
  initialViews: SavedView[];
  currentUser: CurrentUser | null;
  canWrite: boolean;
  canDelete: boolean;
  /** Rendered on the right side of the view-tabs row (e.g. the "New lead"
   *  button). Slot instead of a boolean so the page owner still decides
   *  what goes there and with what permissions. */
  headerSlot?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Local copy for optimistic edit/delete. Re-sync from props when the
  // server returns fresh data (router.refresh after a mutation), but only
  // when the prop actually changes — fingerprint covers every field that
  // can be touched from the rich grid.
  const [localLeads, setLocalLeads] = useState<Lead[]>(initialLeads);
  const incomingKey = useMemo(
    () =>
      initialLeads
        .map((l) =>
          [
            l.id, l.rating, l.score, l.name,
            l.email ?? "", l.phone ?? "",
            l.program ?? "", l.programId ?? "",
            l.value ?? "", l.heat,
            l.stage, l.advisorId ?? "",
            l.nextFollowupAt ?? "", l.demoAttendedAt ?? "",
            l.dueDate ?? "", l.registeredDate ?? "",
            l.feePaid ?? "", l.feeDue ?? "",
          ].join("|"),
        )
        .join("·"),
    [initialLeads],
  );
  useEffect(() => {
    setLocalLeads(initialLeads);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingKey]);

  // ── background poller: detect new leads without a page refresh ────────
  //
  // Every POLL_MS we re-fetch /leads and diff its id-set against what's
  // currently in `localLeads`. Any new ids stage themselves in `pending`
  // and surface a floating pill ("↑ N new leads — click to load"). The
  // pending set is held separately so the current grid doesn't jump around
  // while the user is mid-edit; clicking the pill merges pending in and
  // clears it.
  //
  // We ONLY show the pill for additions. Edits to existing rows are
  // picked up quietly (the poll response replaces those rows in place).
  // Deletions from other clients are also applied silently.
  //
  // Pauses when the tab is hidden to avoid burning API calls on
  // background tabs, and resumes on visibility change.
  const [pending, setPending] = useState<Lead[]>([]);
  const localLeadsRef = useRef(localLeads);
  localLeadsRef.current = localLeads;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function tick() {
      if (document.hidden) return;
      try {
        const fresh = await getLeads();
        if (cancelled) return;
        const currentIds = new Set(localLeadsRef.current.map((l) => l.id));
        const pendingIds = new Set(pendingRef.current.map((l) => l.id));
        // Additions we haven't seen in either bucket → new leads.
        const additions = fresh.filter((l) => !currentIds.has(l.id) && !pendingIds.has(l.id));
        // Silently merge non-addition changes (edits/deletes made elsewhere).
        // We don't rewrite rows the user is currently editing — that pass
        // lives in PipelineListView via onLocalEdit optimistic apply — so
        // this only reconciles rows we already have with fresher server
        // state, and drops rows the server no longer returns.
        const freshById = new Map(fresh.map((l) => [l.id, l] as const));
        setLocalLeads((prev) => {
          // Filter out rows the server no longer returns (deleted elsewhere).
          const surviving = prev.filter((l) => freshById.has(l.id));
          // Replace each surviving row with its fresh copy if the server
          // has newer values; keep our optimistic edits if not.
          return surviving.map((l) => freshById.get(l.id) ?? l);
        });
        if (additions.length > 0) {
          setPending((prev) => {
            // De-dupe by id in case the same addition arrives twice.
            const seen = new Set(prev.map((l) => l.id));
            const merged = [...prev];
            for (const a of additions) if (!seen.has(a.id)) merged.push(a);
            return merged;
          });
        }
      } catch {
        // Silent — a failed poll shouldn't nag the user. Next tick will retry.
      }
    }

    timer = setInterval(tick, POLL_MS);
    // Fire once on visibility-become-visible so the user gets fresh data
    // immediately after switching back to this tab.
    function onVisible() { if (!document.hidden) tick(); }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Apply the staged additions: merge them into localLeads at the top and
  // clear the pending set. Called when the user clicks the pill.
  function loadPendingLeads() {
    setLocalLeads((prev) => {
      const existingIds = new Set(prev.map((l) => l.id));
      const additions = pending.filter((l) => !existingIds.has(l.id));
      return [...additions, ...prev];
    });
    setPending([]);
  }

  // ── filter (rich grid) ────────────────────────────────────────────────
  const fields = useMemo(() => buildFields(localLeads), [localLeads]);
  const [filtered, filterState, setFilterState] = useFilter(localLeads, fields);

  // ── view mode + grouping axis ─────────────────────────────────────────
  // Same three modes and axes as /pipeline, so a user who learns one surface
  // knows the other. The difference: here group-by also applies to the list,
  // where it sections rows instead of making columns — and there it can be
  // "none", because a flat sortable table is the sane default for a list.
  // Kanban and chart have no such option: they need an axis to exist at all,
  // so they fall back to rating.
  // Hydrated from the URL, not defaulted — otherwise a refresh (or a link
  // pasted to a teammate) always lands on the list, whatever you were looking
  // at. Mirrored back on change by the effect below.
  const [view, setView] = useState<LeadsViewMode>(() => parseViewMode(searchParams.get("v")));
  const [groupBy, setGroupBy] = useState<GroupBy | "none">("none");
  const axis: GroupBy = groupBy === "none" ? "rating" : groupBy;

  // ── chart + calendar controls ─────────────────────────────────────────
  // Local to their view, for the reason given on the Measure/ChartRange types:
  // they're presentation knobs, not row filters.
  const [measure, setMeasure] = useState<LeadsChartMeasure>("count");
  const [chartRange, setChartRange] = useState<LeadsChartRange>("30d");
  const [chartAdvisor, setChartAdvisor] = useState<string>("all");
  const [calKind, setCalKind] = useState<LeadTaskKind | "all">("all");
  const [calAssignee, setCalAssignee] = useState<string>("all");
  const [calStatus, setCalStatus] = useState<LeadTaskStatus | "all">("open");
  const [calScale, setCalScale] = useState<CalendarScale>(
    () => (searchParams.get("cal") === "week" ? "week" : "month"),
  );

  // Two different advisor vocabularies, because the two views key on different
  // things: the chart buckets leads by the advisor's *name* (that's all a Lead
  // carries), while the calendar filters tasks by assignee *id* (what the API
  // takes). Both come off the catalog so they stay in sync with Manage Advisors.
  const advisorNameOptions = useMemo(
    () => catalog.advisors.map((a) => ({ value: a.name, label: a.name })),
    [catalog.advisors],
  );
  const advisorIdOptions = useMemo(
    () => catalog.advisors.map((a) => ({ value: a.id, label: a.name })),
    [catalog.advisors],
  );
  const programOptions = useMemo(
    () => catalog.programs.map((p) => ({ value: p.name, label: p.name })),
    [catalog.programs],
  );


  // Kanban / chart both want columns + a key→leads index off the same axis.
  // We pass [] for rating columns because /leads never fetches the server's
  // PipelineColumn[]; makeColumns synthesises them from the leads instead.
  const columns = useMemo(
    () => makeColumns(axis, [], filtered, localLeads),
    [axis, filtered, localLeads],
  );
  const leadsByColumn = useMemo(() => {
    const m = new Map<string, Lead[]>();
    for (const l of filtered) {
      const k = groupKey(l, axis);
      const arr = m.get(k);
      if (arr) arr.push(l);
      else m.set(k, [l]);
    }
    return m;
  }, [filtered, axis]);

  // Grouping descriptor handed to PipelineListView — null when the user hasn't
  // picked an axis, which keeps the list flat. Section order follows the
  // synthesised columns so the list reads in the same bucket order as the
  // Kanban; switching modes shouldn't reshuffle them.
  const listGroupBy = useMemo(
    () =>
      groupBy === "none"
        ? null
        : {
            get: (l: Lead) => groupKey(l, axis),
            label: (k: string) => columns.find((c) => c.key === k)?.label ?? k,
            order: columns.map((c) => c.key),
          },
    [groupBy, axis, columns],
  );

  // ── saved views (shared scope: pipeline_list) ─────────────────────────
  //
  // The active view is mirrored into `?view=<id>` so a hard-refresh (or a
  // link the user pastes to a teammate) reopens the same tab. `__all__`
  // is the default and stays out of the URL to keep it clean.
  const [views, setViews] = useState<SavedView[]>(initialViews);
  const [activeViewId, setActiveViewId] = useState<string>(() => {
    const fromUrl = searchParams.get("view");
    if (!fromUrl) return DEFAULT_VIEW_ID;
    if (fromUrl === DEFAULT_VIEW_ID) return DEFAULT_VIEW_ID;
    return initialViews.some((v) => v.id === fromUrl) ? fromUrl : DEFAULT_VIEW_ID;
  });
  const [liveColumns, setLiveColumns] = useState<string[] | null>(null);

  // Mirror the surface's state into the URL so a refresh — or a link pasted to
  // a teammate — reopens exactly what you were looking at:
  //
  //   ?view=<id>  the active saved-view tab   (absent ⇒ "All leads")
  //   ?v=<mode>   list | kanban | chart | calendar   (absent ⇒ list)
  //   ?cal=week   calendar scale               (absent ⇒ month)
  //
  // All three are written by this one effect. Splitting them into an effect
  // each would have them racing: they'd each build their next URL from the same
  // stale `searchParams` snapshot and the last `router.replace` to land would
  // silently drop the others' params.
  //
  // Defaults are omitted rather than written out, to keep a plain /leads link
  // clean.
  useEffect(() => {
    const desiredView  = activeViewId === DEFAULT_VIEW_ID ? null : activeViewId;
    const desiredMode  = view === "list" ? null : view;
    const desiredScale = view === "calendar" && calScale === "week" ? "week" : null;

    if (
      searchParams.get("view") === desiredView
      && searchParams.get("v") === desiredMode
      && searchParams.get("cal") === desiredScale
    ) return;

    const next = new URLSearchParams(searchParams.toString());
    for (const [key, val] of [
      ["view", desiredView],
      ["v", desiredMode],
      ["cal", desiredScale],
    ] as const) {
      if (val) next.set(key, val);
      else next.delete(key);
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [activeViewId, view, calScale, pathname, router, searchParams]);

  const activeView = activeViewId === DEFAULT_VIEW_ID
    ? null
    : views.find((v) => v.id === activeViewId) ?? null;
  const viewColumnsToPush = activeView?.columns ?? null;

  // Which leads the board is currently showing. The calendar renders tasks, not
  // leads, so it can't reuse `filtered` directly — it needs the id set to test
  // each task's parent lead against. Null when nothing is filtering, so the
  // common case doesn't pay for a Set lookup per task.
  //
  // Keyed off `filterState`, not `activeViewId`: hand-editing a filter detaches
  // you from the saved-view tab but must still scope the calendar, and clearing
  // the filter must un-scope it.
  const leadScope = useMemo(
    () => (filterState.rules.length > 0 ? new Set(filtered.map((l) => l.id)) : null),
    [filterState.rules.length, filtered],
  );
  const leadScopeLabel = leadScope ? (activeView?.name ?? "Filtered leads") : null;

  function selectView(id: string) {
    setActiveViewId(id);
    if (id === DEFAULT_VIEW_ID) {
      setFilterState({ combinator: "and", rules: [] });
      return;
    }
    const v = views.find((x) => x.id === id);
    if (!v) return;
    // Saved views serialise the FilterState blob to JSONB on the server.
    // Coerce it back into a well-formed FilterState here: drop malformed
    // rules, coerce enum "is_any_of" values to arrays, and skip rules
    // whose fieldKey no longer maps to a filterable column (schema drift).
    const knownKeys = new Set(fields.map((f) => f.key));
    const raw = (v.filter && typeof v.filter === "object")
      ? (v.filter as Record<string, unknown>) : {};
    const rulesRaw = Array.isArray(raw.rules) ? raw.rules : [];
    const rules = rulesRaw
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .filter((r) => typeof r.fieldKey === "string" && knownKeys.has(r.fieldKey as string))
      .map((r) => {
        // Coerce array-shaped values for many-arity ops; leave others alone.
        const op = String(r.operator ?? "");
        let value = r.value;
        if ((op === "is_any_of" || op === "is_none_of") && !Array.isArray(value)) {
          value = value == null ? [] : [String(value)];
        }
        // Always mint a fresh id when loading — a saved view's serialised
        // rules may contain "r1"/"r2"-style ids from an old FilterBar
        // counter, which collide with brand-new rules the user adds after.
        return {
          id: `v${Math.random().toString(36).slice(2, 10)}`,
          fieldKey: r.fieldKey as string,
          operator: op,
          value,
        };
      });
    const next: FilterState = {
      combinator: raw.combinator === "or" ? "or" : "and",
      rules: rules as unknown as FilterState["rules"],
    };
    setFilterState(next);
  }

  // On mount, if we hydrated `activeViewId` from `?view=…`, actually apply
  // that view's filter to the grid. Without this the URL says "Today Leads"
  // but the table would show all leads until the user clicks the tab.
  const hydratedOnceRef = useRef(false);
  useEffect(() => {
    if (hydratedOnceRef.current) return;
    hydratedOnceRef.current = true;
    if (activeViewId !== DEFAULT_VIEW_ID) selectView(activeViewId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── per-tab lead counts ───────────────────────────────────────────────
  // Compute the count of leads that would match each saved view's filter,
  // against the full local list (not the currently-filtered view). Runs
  // in a memo — with ~340 leads and a handful of views this is well
  // under a millisecond per render.
  const tabCounts = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = { [DEFAULT_VIEW_ID]: localLeads.length };
    for (const v of views) {
      const raw = (v.filter && typeof v.filter === "object")
        ? (v.filter as Record<string, unknown>) : {};
      const rulesRaw = Array.isArray(raw.rules) ? raw.rules : [];
      const rules = rulesRaw
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        .filter((r) => typeof r.fieldKey === "string")
        .map((r) => ({
          id: `c${Math.random().toString(36).slice(2, 8)}`,
          fieldKey: r.fieldKey as string,
          operator: String(r.operator ?? ""),
          value: r.value,
        }));
      const state: FilterState = {
        combinator: raw.combinator === "or" ? "or" : "and",
        rules: rules as unknown as FilterState["rules"],
      };
      out[v.id] = applyFilter(state, localLeads, fields).length;
    }
    return out;
  }, [views, localLeads, fields]);

  // ── per-user view preferences ─────────────────────────────────────────
  // Which shared views this user has hidden + custom tab order.
  const [hiddenViewIds, setHiddenViewIds] = useState<string[]>([]);
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    getViewPreferences("pipeline_list")
      .then((prefs: UserViewPreference[]) => {
        if (cancelled) return;
        const hidden = prefs.filter((p) => p.hidden)
          .map((p) => p.viewId ?? DEFAULT_VIEW_ID);
        // Sort a copy so unspecified tabs fall back to natural order.
        const ordered = [...prefs]
          .filter((p) => !p.hidden)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((p) => p.viewId ?? DEFAULT_VIEW_ID);
        setHiddenViewIds(hidden);
        setTabOrder(ordered);
      })
      .catch(() => { /* silent — defaults are fine */ });
    return () => { cancelled = true; };
  }, []);

  function onPrefsChange(next: { hiddenViewIds: string[]; tabOrder: string[] }) {
    setHiddenViewIds(next.hiddenViewIds);
    setTabOrder(next.tabOrder);
    // Persist. Merge hidden + order into a single preference-per-view
    // payload. Views not in either list get an "unhide, order=1e6" write
    // to reset any prior override.
    const seen = new Set<string>();
    const payload: Array<{ viewId: string | null; hidden?: boolean; sortOrder?: number }> = [];
    next.tabOrder.forEach((id, i) => {
      seen.add(id);
      payload.push({
        viewId: id === DEFAULT_VIEW_ID ? null : id,
        hidden: next.hiddenViewIds.includes(id),
        sortOrder: i,
      });
    });
    for (const id of next.hiddenViewIds) {
      if (seen.has(id)) continue;
      payload.push({
        viewId: id === DEFAULT_VIEW_ID ? null : id,
        hidden: true,
      });
    }
    updateViewPreferences("pipeline_list", payload).catch(() => { /* silent */ });
  }

  // ── topbar search portal ──────────────────────────────────────────────
  // The slot lives in the Topbar (rendered by the page), so we can only grab
  // it once the DOM exists. Held in state rather than a ref so that finding
  // it triggers the re-render that actually paints the portal.
  const [searchSlot, setSearchSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSearchSlot(document.getElementById(LEADS_SEARCH_SLOT_ID));
  }, []);

  // ── kanban drag-drop ──────────────────────────────────────────────────
  // Dragging a card across columns writes lead.rating, so it's only allowed
  // on the rating axis — every other axis is a read-only bucketing. Applied
  // optimistically and rolled back if the PATCH fails.
  const [dragError, setDragError] = useState<string | null>(null);

  async function onRatingDrop(leadId: string, fromKey: string, toKey: string) {
    if (axis !== "rating" || fromKey === toKey) return;
    if (!canWrite) {
      setDragError("You don't have permission to move leads. Ask an admin for the leads.write permission.");
      setTimeout(() => setDragError(null), 4000);
      return;
    }
    const before = localLeads;
    const target = before.find((l) => l.id === leadId);
    if (!target) return;
    const toRating = toKey as Lead["rating"];
    setLocalLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, rating: toRating } : l)));
    try {
      await updateLead(target.number, { rating: toRating });
      router.refresh();
    } catch (err) {
      setLocalLeads(before);
      setDragError(`Couldn't update rating: ${(err as Error).message}`);
      setTimeout(() => setDragError(null), 4000);
    }
  }

  // Editing a filter by hand detaches from the active saved view — matches
  // the pipeline UX, where the user "drifts" off a view once they touch it.
  function changeFilter(next: FilterState) {
    setFilterState(next);
    if (activeViewId !== DEFAULT_VIEW_ID) setActiveViewId(DEFAULT_VIEW_ID);
  }

  // ── toolbar ───────────────────────────────────────────────────────────
  //
  // The controls to the right of the view switcher are per-view, because the
  // four views answer different questions. Grouping and row filters are
  // meaningless to a chart of the whole book; a measure and a date range are
  // meaningless to a grid that shows every column anyway.
  //
  //   list      group-by · rating · status · +filter   (Export / Columns come
  //                                                     from PipelineListView's
  //                                                     own toolbar row)
  //   kanban    group-by · advisor · program · +filter
  //   chart     measure  · advisor · range
  //   calendar  events   · advisor · status
  // Three zones, and the split matters:
  //
  //   [ view switcher ][ ← filters scroll → ][ Export/Columns or Month ]
  //     pinned            the only scroller     pinned (rendered by the caller)
  //
  // The switcher is how you leave the view you're in — it must never scroll out
  // of reach behind a long filter row. Only the pills scroll; `flex-nowrap` +
  // `w-max` on the inner track makes them overflow sideways instead of wrapping
  // onto a second line and shoving the grid down.
  const toolbar = (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="flex-shrink-0">
        <LeadsViewSwitcher value={view} onChange={setView} />
      </div>

      <div
        className="min-w-0 flex-1 overflow-x-auto scroll-x-clean"
        // The scrollbar is hidden (it would otherwise reserve height inside the
        // scroller and knock these pills out of line with the pinned buttons —
        // see .scroll-x-clean). A trackpad still scrolls this natively, but a
        // plain mouse wheel only emits deltaY, so map that onto scrollLeft.
        // Safe to hijack: <body> is overflow:hidden, so a vertical wheel here
        // has nothing else to scroll.
        onWheel={(e) => {
          const el = e.currentTarget;
          if (el.scrollWidth <= el.clientWidth) return;
          if (e.deltaY !== 0 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            el.scrollLeft += e.deltaY;
          }
        }}
      >
        <div className="flex w-max flex-nowrap items-center gap-2.5 [&>*]:flex-shrink-0">
      {(view === "list" || view === "kanban") && (
        <LeadsGroupByPill value={groupBy} onChange={setGroupBy} />
      )}

      {view === "list" && (
        <>
          <QuickFilterPill
            label="Rating"
            options={RATING_OPTIONS}
            state={filterState}
            fieldKey="rating"
            onChange={changeFilter}
          />
          <QuickFilterPill
            label="Status"
            options={LEAD_STATUS_OPTIONS}
            state={filterState}
            fieldKey="leadStatus"
            onChange={changeFilter}
          />
        </>
      )}

      {view === "kanban" && (
        <>
          <QuickFilterPill
            label="Advisor"
            options={advisorNameOptions}
            state={filterState}
            fieldKey="advisor"
            onChange={changeFilter}
            anyLabel="All"
          />
          <QuickFilterPill
            label="Program"
            options={programOptions}
            state={filterState}
            fieldKey="program"
            onChange={changeFilter}
            anyLabel="All"
          />
        </>
      )}

      {view === "chart" && (
        <>
          <SelectPill label="Measure" options={LEADS_CHART_MEASURES} value={measure} onChange={setMeasure} />
          <SelectPill
            label="Advisor"
            options={advisorNameOptions}
            value={chartAdvisor}
            onChange={setChartAdvisor}
            allValue="all"
            allLabel="All"
          />
          <SelectPill label="Range" options={RANGE_OPTIONS} value={chartRange} onChange={setChartRange} />
        </>
      )}

      {view === "calendar" && (
        <>
          <SelectPill
            label="Events"
            options={TASK_KIND_OPTIONS}
            value={calKind}
            onChange={setCalKind}
            allValue="all"
            allLabel="All types"
          />
          <SelectPill
            label="Advisor"
            options={advisorIdOptions}
            value={calAssignee}
            onChange={setCalAssignee}
            allValue="all"
            allLabel="All"
          />
          <SelectPill
            label="Status"
            options={TASK_STATUS_OPTIONS}
            value={calStatus}
            onChange={setCalStatus}
            allValue="all"
            allLabel="Any"
          />
        </>
      )}

      {/* The rule builder only makes sense where there are rows to filter. */}
      {(view === "list" || view === "kanban") && (
        <FilterBar fields={fields} state={filterState} onChange={changeFilter} />
      )}
        </div>
      </div>
    </div>
  );

  // Pinned to the right of the toolbar row, outside the scroller — it must stay
  // reachable however far the filters have scrolled. Same role Export / Columns
  // play in list mode (they're rendered by PipelineListView's own toolbar row).
  const toolbarRight = view === "calendar"
    ? <ScalePill value={calScale} onChange={setCalScale} />
    : null;

  return (
    <>
      {/* Searches localLeads, so optimistic edits and polled-in leads are all
          findable — that's the whole reason this is a portal and not just
          markup in the page. */}
      {searchSlot && createPortal(<LeadsSearchBox leads={localLeads} />, searchSlot)}

      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <ViewTabs
            scope="pipeline_list"
            views={views}
            activeId={activeViewId}
            onSelect={selectView}
            fields={fields}
            allColumns={PIPELINE_LIST_COLUMNS}
            defaultColumns={PIPELINE_LIST_DEFAULT_COLUMNS}
            currentFilter={filterState}
            currentColumns={(liveColumns ?? viewColumnsToPush ?? [...PIPELINE_LIST_DEFAULT_COLUMNS]) as string[]}
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


      {/* "N new leads — click to load" pill. Fixed to the viewport top,
          centred horizontally, so it floats over ANY content on the page
          (including the page header) — the operator asked for a "goes on
          top" toast-style pill, not one that follows the list. Only renders
          when there's something to load. */}
      {pending.length > 0 && (
        <div className="fixed inset-x-0 top-4 z-50 flex justify-center pointer-events-none">
          <button
            type="button"
            onClick={loadPendingLeads}
            className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-brand-violet/40 bg-brand-violet px-4 py-1.5 text-[12.5px] font-semibold text-white shadow-card hover:bg-brand-violet/90"
          >
            <span aria-hidden>↑</span>
            {pending.length} new lead{pending.length === 1 ? "" : "s"} — click to load
          </button>
        </div>
      )}

      {dragError && (
        <div className="mb-3 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
          {dragError}
        </div>
      )}

      {/* Toolbar. In list mode it's injected into PipelineListView's own
          Export/Columns row so everything lands on one line; the other two
          modes have no such row, so it's rendered standalone. */}
      {view === "list" ? (
        <PipelineListView
          leads={filtered}
          catalog={catalog}
          canWrite={canWrite}
          canDelete={canDelete}
          viewColumns={viewColumnsToPush}
          onColumnsChange={setLiveColumns}
          groupBy={listGroupBy}
          toolbarSlot={toolbar}
          hasActiveFilter={filterState.rules.length > 0}
          onClearFilter={() => changeFilter({ combinator: "and", rules: [] })}
          onLocalEdit={(leadId, patch) => {
            setLocalLeads((prev) =>
              prev.map((l) => (l.id === leadId ? { ...l, ...patch } : l)),
            );
          }}
          onLocalDelete={(leadIds) => {
            const dropSet = new Set(leadIds);
            setLocalLeads((prev) => prev.filter((l) => !dropSet.has(l.id)));
            router.refresh();
          }}
        />
      ) : (
        <>
          {/* Mirrors PipelineListView's toolbar row: the slot owns its own
              scrolling, so no scroller here. */}
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">{toolbar}</div>
            {toolbarRight && <div className="flex-shrink-0">{toolbarRight}</div>}
          </div>
          {view === "kanban" && (
            <KanbanView
              columns={columns}
              leadsByColumn={leadsByColumn}
              filterActive={filterState.rules.length > 0}
              groupBy={axis}
              onDrop={onRatingDrop}
              canCreateLeads={canWrite}
            />
          )}
          {view === "chart" && (
            <LeadsChartView
              leads={filtered}
              measure={measure}
              advisorFilter={chartAdvisor}
              range={chartRange}
            />
          )}
          {/* The calendar reads lead_task rows, not leads — so the board's row
              filter doesn't apply to it and it fetches its own data. Its three
              pills are its filter. */}
          {view === "calendar" && (
            <LeadsCalendarView
              kindFilter={calKind}
              assigneeFilter={calAssignee}
              statusFilter={calStatus}
              scale={calScale}
              leadScope={leadScope}
              leadScopeLabel={leadScopeLabel}
            />
          )}
        </>
      )}
    </>
  );
}

// ─── LeadsSearchBox ──────────────────────────────────────────────────────
//
// Type-ahead search over the currently-loaded leads set. Client-side —
// searches across every text-ish field the operator might remember a lead
// by (name, LEAD-number, phone, email, city, program, advisor, description,
// lead status label). Case-insensitive substring; simple ranking.
//
// UX: floating dropdown of the top ~8 matches. Click a row → jumps to
// /records/LEAD-xxxx. Dropdown closes on outside click or Escape. The
// underlying grid is untouched — this is a shortcut to the record page,
// not a grid filter (the FilterBar handles that use case).
export function LeadsSearchBox({ leads }: { leads: Lead[] }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Compute matches. Empty query → no dropdown. We stringify each lead's
  // searchable fields once, lowercased, so per-keystroke work is a single
  // .includes() per lead. On ~320 leads this is a fraction of a millisecond.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as Lead[];
    const scored: Array<{ l: Lead; score: number }> = [];
    for (const l of leads) {
      const hay = [
        l.name, l.number, l.phone, l.phoneCountryCode, l.email,
        l.city, l.program, l.advisorName, l.description,
        l.sourceLabel, l.source, l.leadStatus,
        // Human rating label — so typing "hot" or "new" hits.
        ratingStyles[l.rating]?.label,
      ].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) continue;
      // Rough ranking: prefix on name > name contains > everything else.
      let score = 0;
      const nameLc = (l.name ?? "").toLowerCase();
      if (nameLc.startsWith(q)) score = 3;
      else if (nameLc.includes(q)) score = 2;
      else score = 1;
      scored.push({ l, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 8).map((s) => s.l);
  }, [query, leads]);

  useEffect(() => { setActiveIdx(0); }, [query]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const router = useRouter();
  function goTo(l: Lead) {
    // Search jumps to a specific lead — the "prev/next" context on the
    // record page only makes sense when the user drilled in from an
    // ordered list. Clear any stale snapshot so the arrows disappear.
    if (typeof window !== "undefined") {
      try { window.sessionStorage.removeItem("decrm_lead_nav_v1"); } catch { /* ignore */ }
    }
    router.push(`/records/${encodeURIComponent(l.number)}`);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); return; }
    if (!open || matches.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, matches.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const l = matches[activeIdx]; if (l) goTo(l); }
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
          placeholder="Search leads by name, phone, email, program, advisor…"
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink placeholder:text-hint outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => { setQuery(""); inputRef.current?.focus(); }}
            aria-label="Clear search"
            className="text-mute hover:text-ink"
          >
            <Icon name="plus" size={12} strokeWidth={2.4} className="rotate-45" />
          </button>
        )}
      </div>

      {open && query.trim() && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[400px] overflow-y-auto rounded-[12px] border border-rule bg-paper py-1 shadow-card">
          {matches.length === 0 ? (
            <div className="px-4 py-4 text-center text-[12.5px] text-mute">
              No leads match “{query.trim()}”.
            </div>
          ) : (
            matches.map((l, i) => {
              const sc = ratingStyles[l.rating];
              return (
                <button
                  type="button"
                  key={l.id}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => goTo(l)}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-2 text-left transition",
                    i === activeIdx ? "bg-warm/60" : "hover:bg-warm/40",
                  )}
                >
                  <div className={cn("flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold text-white", avatarGradClass[l.avatar])}>
                    {l.initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-semibold text-ink">{l.name}</span>
                      <span className="mono-cap text-[9.5px] tracking-[.06em] text-hint">{l.number}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[11.5px] text-mute">
                      {[l.phone, l.email, l.program, l.advisorName].filter(Boolean).join(" · ") || "—"}
                    </div>
                  </div>
                  {sc && (
                    <span className={cn("inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold", sc.bg, sc.text)}>
                      <span className={cn("h-1.5 w-1.5 rounded-full", sc.dot)} />
                      {sc.label}
                    </span>
                  )}
                </button>
              );
            })
          )}
          <div className="mono-cap border-t border-rule px-3 py-1.5 text-[9.5px] tracking-[.1em] text-hint">
            {matches.length === 0 ? "0 matches" : `${matches.length} of ${leads.length} · ↑↓ navigate · enter opens`}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── LeadsViewSwitcher ────────────────────────────────────────────────
//
// PipelineBoard's <ViewSwitcher> has three modes; leads has four. Kept
// separate rather than adding a "calendar" case there, because /pipeline has
// no lead_task surface and a dead fourth tab is worse than a little markup.
function LeadsViewSwitcher({
  value, onChange,
}: {
  value: LeadsViewMode;
  onChange: (v: LeadsViewMode) => void;
}) {
  const items: Array<{ key: LeadsViewMode; label: string; icon: IconName }> = [
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

// ─── ScalePill ────────────────────────────────────────────────────────
//
// Month / Week. Visually distinct from the filter pills beside it — icon-led,
// brand-coloured, no "LABEL:" prefix — because it isn't a filter: it reshapes
// the grid rather than narrowing what lands in it.
function ScalePill({
  value, onChange,
}: {
  value: CalendarScale;
  onChange: (v: CalendarScale) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const options: Array<{ value: CalendarScale; label: string }> = [
    { value: "month", label: "Month" },
    { value: "week",  label: "Week" },
  ];
  const label = options.find((o) => o.value === value)?.label ?? "Month";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-paper px-3.5 py-1.5 text-[12.5px] font-semibold text-brand-violet transition hover:border-rule2"
      >
        <Icon name="calendar" size={13} strokeWidth={2} />
        {label}
      </button>
      {open && (
        <AnchoredPopover anchor={ref.current} align="right" className="min-w-[130px]">
          {options.map((o) => (
            <button
              type="button"
              key={o.value}
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={cn(
                "block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-warm",
                value === o.value && "bg-warm font-semibold",
              )}
            >
              {o.label}
            </button>
          ))}
        </AnchoredPopover>
      )}
    </div>
  );
}

// ─── SelectPill ───────────────────────────────────────────────────────
//
// The QuickFilterPill's twin for plain local state. QuickFilterPill reads and
// writes FilterState — right for Rating/Status/Advisor/Program, which really
// are row filters. The chart's Measure/Range and the calendar's Events/Status
// are not: they belong to one view's presentation, so they get their own
// pill that just owns a value. Same shape so the toolbar reads as one row.
function SelectPill<T extends string>({
  label, options, value, onChange, allValue, allLabel = "Any",
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | string;
  onChange: (v: never) => void;
  /** When set, prepends an "any" choice carrying this value (e.g. "all"). */
  allValue?: string;
  allLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const isAll = allValue !== undefined && value === allValue;
  const current = isAll
    ? allLabel
    : (options.find((o) => o.value === value)?.label ?? String(value));

  // "Active" styling is reserved for a pill that's actually narrowing something.
  // A Measure/Range pill has no neutral state, so it never lights up — otherwise
  // the whole toolbar would read as permanently filtered.
  const active = allValue !== undefined && !isAll;

  const choices: Array<{ value: string; label: string }> = [
    ...(allValue !== undefined ? [{ value: allValue, label: allLabel }] : []),
    ...options.map((o) => ({ value: o.value as string, label: o.label })),
  ];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition",
          active
            ? "border-brand-violet bg-brand-violet/10 text-brand-violet"
            : "border-rule bg-paper text-ink2 hover:border-rule2 hover:text-ink",
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
              <button
                type="button"
                onClick={() => { onChange(o.value as never); setOpen(false); }}
                className={cn(
                  "block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-warm",
                  value === o.value && "bg-warm font-semibold",
                )}
              >
                {o.label}
              </button>
            </div>
          ))}
        </AnchoredPopover>
      )}
    </div>
  );
}

// ─── LeadsGroupByPill ─────────────────────────────────────────────────
//
// The grouping axis. Deliberately not PipelineBoard's <GroupBySelector>:
// that one is a bare <select> with no "off" state, because Kanban and Chart
// always need an axis. A list doesn't — flat is the sane default — so this
// one carries a "None" option and matches the visual weight of the filter
// pills sitting beside it.
function LeadsGroupByPill({
  value, onChange,
}: {
  value: GroupBy | "none";
  onChange: (v: GroupBy | "none") => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const active = value !== "none";
  const label = active
    ? (GROUP_BY_OPTIONS.find((o) => o.value === value)?.label ?? value)
    : "None";

  const options: Array<{ value: GroupBy | "none"; label: string }> = [
    { value: "none", label: "None" },
    ...GROUP_BY_OPTIONS,
  ];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition",
          active
            ? "border-brand-violet bg-brand-violet/10 text-brand-violet"
            : "border-rule bg-paper text-ink2 hover:border-rule2 hover:text-ink",
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
              className={cn(
                "block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-warm",
                value === o.value && "bg-warm font-semibold",
              )}
            >
              {o.label}
            </button>
          ))}
        </AnchoredPopover>
      )}
    </div>
  );
}

// ─── QuickFilterPill ──────────────────────────────────────────────────
//
// Dropdown pill for a single enum field (Rating, Status). Writes into the
// same FilterState the FilterBar edits — so the "Add filter" builder and
// the pills stay in sync and never disagree.
//
// Behaviour: pick "Any" → removes any existing rule for this field.
// Pick a specific value → replaces any existing rule with an "is" rule.
// Multi-select support is deliberately absent; if a user needs "hot OR
// warm" they use the full FilterBar with is_any_of.
function QuickFilterPill({
  label, options, state, fieldKey, onChange, anyLabel = "Any",
}: {
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  state: FilterState;
  fieldKey: string;
  onChange: (next: FilterState) => void;
  /** Wording for the no-rule choice. "Any" reads right for Rating/Status,
   *  "All" for Advisor/Program — same behaviour either way. */
  anyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  // The current value shown on the pill. Reads back from FilterState so
  // it always reflects reality — flipping a rule off in the FilterBar
  // reverts the pill to "Any" automatically.
  const currentRule = state.rules.find((r) => r.fieldKey === fieldKey);
  const currentVal = currentRule && currentRule.operator === "is" && typeof currentRule.value === "string"
    ? currentRule.value : "";
  const currentLabel = currentVal
    ? (options.find((o) => o.value === currentVal)?.label ?? currentVal)
    : anyLabel;

  function pick(value: string) {
    const others = state.rules.filter((r) => r.fieldKey !== fieldKey);
    if (!value) {
      onChange({ ...state, rules: others });
    } else {
      onChange({
        ...state,
        rules: [
          ...others,
          {
            id: `q${Math.random().toString(36).slice(2, 8)}`,
            fieldKey,
            operator: "is",
            value,
          },
        ],
      });
    }
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition",
          currentVal
            ? "border-brand-violet bg-brand-violet/10 text-brand-violet"
            : "border-rule bg-paper text-ink2 hover:border-rule2 hover:text-ink",
        )}
      >
        <span className="mono-cap text-[9.5px] tracking-[.08em] text-mute">{label}:</span>
        <span>{currentLabel}</span>
        <span className="text-[9px] text-mute">▾</span>
      </button>
      {open && (
        <AnchoredPopover anchor={ref.current} className="max-h-[320px] min-w-[180px] overflow-y-auto">
          <button
            type="button"
            onClick={() => pick("")}
            className={cn(
              "block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-warm",
              !currentVal && "bg-warm font-semibold",
            )}
          >
            {anyLabel}
          </button>
          <div className="my-1 border-t border-rule" />
          {options.map((o) => (
            <button
              type="button"
              key={o.value}
              onClick={() => pick(o.value)}
              className={cn(
                "block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-warm",
                currentVal === o.value && "bg-warm font-semibold",
              )}
            >
              {o.label}
            </button>
          ))}
        </AnchoredPopover>
      )}
    </div>
  );
}
