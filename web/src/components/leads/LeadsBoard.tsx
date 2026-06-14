"use client";

// /leads grid view. Reuses PipelineListView (same component as
// /pipeline → List view): column picker, inline edit, bulk update,
// bulk delete, saved views (shared scope `pipeline_list` so a view
// shows up on both surfaces).

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PipelineListView, PIPELINE_LIST_COLUMNS, PIPELINE_LIST_DEFAULT_COLUMNS } from "@/components/pipeline/PipelineListView";
import { DEFAULT_VIEW_ID, ViewTabs } from "@/components/pipeline/ViewTabs";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField, FilterState } from "@/components/filter/types";
import type { CatalogResponse, CurrentUser, Lead, SavedView } from "@/lib/types";
import { LEAD_RATINGS } from "@/lib/types";
import { ratingStyles } from "@/lib/ui";

const RATING_OPTIONS = LEAD_RATINGS.map((r) => ({ value: r, label: ratingStyles[r].label }));

function unique<T>(xs: T[]): T[] {
  return Array.from(new Set(xs.filter((x): x is T & {} => x != null && (x as unknown) !== "")));
}

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingKey]);

  // ── filter (rich grid) ────────────────────────────────────────────────
  const fields = useMemo(() => buildFields(localLeads), [localLeads]);
  const [filtered, filterState, setFilterState] = useFilter(localLeads, fields);

  // ── saved views (shared scope: pipeline_list) ─────────────────────────
  const [views, setViews] = useState<SavedView[]>(initialViews);
  const [activeViewId, setActiveViewId] = useState<string>(DEFAULT_VIEW_ID);
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
          router.refresh();
        }}
      />
    </>
  );
}
