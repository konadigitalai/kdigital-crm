"use client";

// /leads grid view. Reuses PipelineListView (same component as
// /pipeline → List view): column picker, inline edit, bulk update,
// bulk delete, saved views (shared scope `pipeline_list` so a view
// shows up on both surfaces).

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PipelineListView, PIPELINE_LIST_COLUMNS, PIPELINE_LIST_DEFAULT_COLUMNS } from "@/components/pipeline/PipelineListView";
import { DEFAULT_VIEW_ID, ViewTabs } from "@/components/pipeline/ViewTabs";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { getLeads } from "@/lib/api";
import type { FilterField, FilterState } from "@/components/filter/types";
import type { CatalogResponse, CurrentUser, Lead, SavedView } from "@/lib/types";
import { LEAD_RATINGS } from "@/lib/types";
import { avatarGradClass, ratingStyles } from "@/lib/ui";

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

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
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
        {headerSlot && <div className="flex-shrink-0">{headerSlot}</div>}
      </div>

      <div className="mb-3">
        <LeadsSearchBox leads={localLeads} />
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
function LeadsSearchBox({ leads }: { leads: Lead[] }) {
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
      <div className="flex items-center gap-2 rounded-[14px] border border-rule bg-paper px-3 py-2 focus-within:border-brand-violet focus-within:ring-2 focus-within:ring-brand-violet/20">
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
