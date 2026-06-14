"use client";

// /leads view container. Adds a view-mode toggle that switches between the
// existing card-style LeadsTable (default) and the rich editable grid we
// already use on /pipeline → List view.
//
// All the heavy lifting (column picker, inline edit, bulk update, bulk
// delete, saved views) lives in PipelineListView — we just reuse it here.
// Saved views are stored under the `pipeline_list` scope and shared with
// the pipeline page so a view created on one surface shows up on both.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { LeadsTable } from "./LeadsTable";
import { PipelineListView, PIPELINE_LIST_COLUMNS, PIPELINE_LIST_DEFAULT_COLUMNS } from "@/components/pipeline/PipelineListView";
import { DEFAULT_VIEW_ID, ViewTabs } from "@/components/pipeline/ViewTabs";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField, FilterState } from "@/components/filter/types";
import type { CatalogResponse, CurrentUser, Lead, SavedView } from "@/lib/types";
import { LEAD_RATINGS } from "@/lib/types";
import { ratingStyles } from "@/lib/ui";

type ViewMode = "default" | "list";

const VIEW_KEY = "decrm_leads_view_mode";

const RATING_OPTIONS = LEAD_RATINGS.map((r) => ({ value: r, label: ratingStyles[r].label }));

function unique<T>(xs: T[]): T[] {
  return Array.from(new Set(xs.filter((x): x is T & {} => x != null && (x as unknown) !== "")));
}

// Field schema for the rich-grid filter / saved views. Mirrors LeadsTable's
// schema so saved-view rules built here behave identically.
function buildFields(leads: Lead[]): FilterField[] {
  const programs = unique(leads.map((l) => l.program));
  const cities   = unique(leads.map((l) => l.city));
  return [
    { key: "name",        label: "Name",        type: "text",   get: (l: Lead) => l.name },
    { key: "number",      label: "Lead #",      type: "text",   get: (l: Lead) => l.number },
    { key: "city",        label: "City",        type: "enum",   options: cities.map((c) => ({ value: c, label: c })),  get: (l: Lead) => l.city },
    { key: "program",     label: "Program",     type: "enum",   options: programs.map((p) => ({ value: p, label: p })), get: (l: Lead) => l.program },
    { key: "rating",      label: "Rating",      type: "enum",   options: RATING_OPTIONS,  get: (l: Lead) => l.rating },
    { key: "score",       label: "Score",       type: "number", get: (l: Lead) => l.score },
    { key: "nbaLabel",    label: "Next action", type: "text",   get: (l: Lead) => l.nbaLabel },
    { key: "nextFollowupAt", label: "Next follow-up", type: "date", get: (l: Lead) => l.nextFollowupAt },
    { key: "demoAttendedAt", label: "Demo attended",  type: "date", get: (l: Lead) => l.demoAttendedAt },
  ];
}

export function LeadsBoard({
  initialLeads,
  catalog,
  initialViews,
  currentUser,
  canWrite,
  canDelete,
}: {
  initialLeads: Lead[];
  catalog: CatalogResponse;
  initialViews: SavedView[];
  currentUser: CurrentUser | null;
  canWrite: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();

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
    // Watch only the digest, not array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingKey]);

  // ── view mode persistence ─────────────────────────────────────────────
  const [view, setView] = useState<ViewMode>("default");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const v = window.localStorage.getItem(VIEW_KEY);
    if (v === "default" || v === "list") setView(v);
  }, []);
  function changeView(next: ViewMode) {
    setView(next);
    if (typeof window !== "undefined") window.localStorage.setItem(VIEW_KEY, next);
  }

  // ── filter (rich grid) ────────────────────────────────────────────────
  const fields = useMemo(() => buildFields(localLeads), [localLeads]);
  const [filtered, filterState, setFilterState] = useFilter(localLeads, fields);

  // ── saved views (shared scope: pipeline_list) ─────────────────────────
  const [views, setViews] = useState<SavedView[]>(initialViews);
  const [activeViewId, setActiveViewId] = useState<string>(DEFAULT_VIEW_ID);
  // Live columns mirror what the rich list shows so saved-view "use current
  // state" can capture them.
  const [liveColumns, setLiveColumns] = useState<string[] | null>(null);

  const activeView = activeViewId === DEFAULT_VIEW_ID
    ? null
    : views.find((v) => v.id === activeViewId) ?? null;
  const viewColumnsToPush = activeView?.columns ?? null;

  function selectView(id: string) {
    setActiveViewId(id);
    if (id === DEFAULT_VIEW_ID) {
      setFilterState({ combinator: "and", rules: [] });
      return;
    }
    const v = views.find((x) => x.id === id);
    if (!v) return;
    const next: FilterState =
      (v.filter && typeof v.filter === "object" && Array.isArray((v.filter as Record<string, unknown>).rules))
        ? (v.filter as unknown as FilterState)
        : { combinator: "and", rules: [] };
    setFilterState(next);
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <ViewSwitcher value={view} onChange={changeView} />
        {view === "list" && (
          <div className="hidden text-[12.5px] text-mute md:block">
            Same grid as the Pipeline list — column picker, inline edit, bulk update, saved views.
          </div>
        )}
      </div>

      {view === "list" && (
        <>
          <div className="mb-3">
            <ViewTabs
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
            />
          </div>
          <div className="mb-4 rounded-[14px] border border-rule bg-paper p-3">
            <FilterBar
              fields={fields}
              state={filterState}
              onChange={(next) => {
                setFilterState(next);
                // Manually editing filters detaches from the active view —
                // matches the pipeline UX where the user "drifts" off a view.
                if (activeViewId !== DEFAULT_VIEW_ID) setActiveViewId(DEFAULT_VIEW_ID);
              }}
            />
          </div>
        </>
      )}

      {view === "default" ? (
        <LeadsTable leads={localLeads} />
      ) : (
        <PipelineListView
          leads={filtered}
          catalog={catalog}
          canWrite={canWrite}
          canDelete={canDelete}
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
            // Pull fresh server state in for safety; the optimistic update
            // is already on screen.
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function ViewSwitcher({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  const items: { key: ViewMode; label: string; icon: IconName }[] = [
    { key: "default", label: "Cards",     icon: "users" },
    { key: "list",    label: "Grid view", icon: "bars"  },
  ];
  return (
    <div className="inline-flex items-center gap-1 rounded-[10px] border border-rule bg-warm2 p-1">
      {items.map((it) => {
        const on = value === it.key;
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onChange(it.key)}
            className={cn(
              "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-[12px] font-semibold transition",
              on ? "bg-paper text-ink shadow-[0_1px_3px_rgba(14,10,20,.08)]" : "text-mute hover:text-ink2",
            )}
          >
            <Icon name={it.icon} size={13} strokeWidth={1.8} />
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
