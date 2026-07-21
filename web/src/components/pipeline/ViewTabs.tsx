"use client";

// Saved-view tabs above the pipeline list.
//
//   [ All leads ]  [ My hot leads ]  [ Demo no-shows ]  [ + New view ]
//
// Click a tab → applies its filter + columns. Click the active tab a second
// time → opens the editor (rename, change filters/columns/visibility, delete).
// The "All leads" tab is the implicit default — no filter, default columns,
// can't be edited or deleted.
//
// The dialog itself contains the full builder: name, visibility, FilterBar,
// column picker. So the user can build a view in one place without first
// configuring the table outside.
//
// Owner notes:
//   - Personal views are owned by the current user; only they can rename/edit/delete.
//   - Shared views are tenant-wide; anyone with pipeline.write can edit/delete.

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { createSavedView, deleteSavedView, updateSavedView } from "@/lib/api";
import { FilterBar } from "@/components/filter/FilterBar";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { FilterField, FilterState } from "@/components/filter/types";
import type { CurrentUser, SavedView, SavedViewScope, SavedViewVisibility } from "@/lib/types";

export const DEFAULT_VIEW_ID = "__all__";

// Own MIME type so the tab strip never reacts to an unrelated drag — the Kanban
// board is dragging leads around the same page under `application/x-decrm-lead`.
const TAB_DRAG_MIME = "application/x-decrm-viewtab";

interface Props {
  views: SavedView[];
  activeId: string;
  onSelect: (id: string) => void;

  /** Which list surface these views belong to. Threaded into createSavedView
   *  so a view created from this board is stored under the right scope (not
   *  hardcoded to pipeline_list). Reads use the same scope in the parent. */
  scope: SavedViewScope;

  /** Label for the implicit default (no-filter) tab. Defaults to "All leads"
   *  for the pipeline origin; boards pass their own ("All batches", …). */
  allLabel?: string;

  // Builder ingredients — passed in by the parent so the dialog can render
  // a FilterBar and a column picker that match the live table exactly.
  fields: FilterField[];
  allColumns: ReadonlyArray<{ key: string; label: string }>;
  defaultColumns: readonly string[];

  // Pre-fill values for "+ New view": the table's current filter + visible
  // columns. The user can keep tweaking inside the dialog before saving.
  currentFilter: FilterState;
  currentColumns: string[];

  // After a write succeeds, the parent re-fetches/refreshes so the new view
  // shows up in the tab strip.
  onChange: (next: SavedView[]) => void;

  currentUser: CurrentUser | null;
  /** True if the user can promote views to shared and edit shared views.
   *  In the pipeline, that's `pipeline.write`. Resolved by the parent. */
  canShare: boolean;

  /** Per-tab lead counts. Parent computes these from the full local list so
   *  the tab strip can show "All leads 339 · Hot & Super Hot 41 · …". Key
   *  is the view id, or DEFAULT_VIEW_ID for the "All leads" pseudo-tab.
   *  Undefined per-view means "don't show a count for this tab". */
  counts?: Record<string, number>;

  /** Ordered list of view ids the current user has HIDDEN. Hidden tabs are
   *  omitted from the strip but still accessible via the "Manage tabs" sheet.
   *  DEFAULT_VIEW_ID may appear in here too — a user can hide "All leads". */
  hiddenViewIds?: string[];

  /** User's preferred tab order. IDs listed here render in that order at the
   *  front of the strip; anything not in the list falls back to natural
   *  order (creation date, "All leads" first). */
  tabOrder?: string[];

  /** Called when the user hides/unhides or reorders. Parent persists via
   *  PATCH /me/view-preferences. Optional — read-only if unset. */
  onPreferencesChange?: (next: { hiddenViewIds: string[]; tabOrder: string[] }) => void;
}

export function ViewTabs({
  views, activeId, onSelect,
  scope, allLabel = "All leads",
  fields, allColumns, defaultColumns,
  currentFilter, currentColumns,
  onChange,
  currentUser, canShare,
  counts, hiddenViewIds, tabOrder, onPreferencesChange,
}: Props) {
  const [editing, setEditing] = useState<{ mode: "create" } | { mode: "edit"; view: SavedView } | null>(null);
  const [managing, setManaging] = useState(false);
  const myId = currentUser?.id ?? "";

  const hiddenSet = useMemo(() => new Set(hiddenViewIds ?? []), [hiddenViewIds]);

  // Compute the visible tab strip: (1) DEFAULT + all views, (2) drop hidden,
  // (3) sort by tabOrder if provided (unlisted ids come after listed ones in
  // natural order).
  const orderedTabs = useMemo(() => {
    const all: Array<{ id: string; kind: "default" | "view"; view?: SavedView }> = [
      { id: DEFAULT_VIEW_ID, kind: "default" },
      ...views.map((v) => ({ id: v.id, kind: "view" as const, view: v })),
    ];
    const visible = all.filter((t) => !hiddenSet.has(t.id));
    if (!tabOrder || tabOrder.length === 0) return visible;
    const rank = new Map(tabOrder.map((id, i) => [id, i]));
    return visible.sort((a, b) => {
      const ra = rank.get(a.id) ?? 1e9;
      const rb = rank.get(b.id) ?? 1e9;
      return ra - rb;
    });
  }, [views, hiddenSet, tabOrder]);

  // ── drag-to-reorder ───────────────────────────────────────────────────
  //
  // Reuses the existing tabOrder preference (PATCH /me/view-preferences) rather
  // than inventing a second ordering channel — so a drag here and a reorder in
  // the "Manage tabs" sheet write the same field and can't disagree.
  //
  // Only the visible tabs are ordered. Hidden ones aren't in `orderedTabs`, and
  // the parent's persist step re-attaches them, so dropping them from the list
  // we emit is correct, not lossy.
  const canReorder = !!onPreferencesChange;
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // A drag that ends on a tab fires `click` on some platforms; without this the
  // drop would also re-select (or worse, open the editor for) the dropped tab.
  const draggedRef = useRef(false);

  // React unmounts the source button as the reorder re-renders, so its own
  // dragend can go missing and leave a tab stuck at half opacity. A window
  // listener doesn't depend on any particular node surviving.
  useEffect(() => {
    function clear() { setDragId(null); setOverId(null); }
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  function commitReorder(fromId: string, toId: string) {
    if (!onPreferencesChange || fromId === toId) return;
    const ids = orderedTabs.map((t) => t.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, fromId);
    onPreferencesChange({ hiddenViewIds: hiddenViewIds ?? [], tabOrder: next });
  }

  function dragPropsFor(id: string) {
    if (!canReorder) return {};
    return {
      draggable: true,
      dragging: dragId === id,
      // Only mark a drop edge for a *different* tab — highlighting the tab
      // you're still holding just looks like a bug.
      dropTarget: !!dragId && dragId !== id && overId === id,
      wasDragged: draggedRef,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(TAB_DRAG_MIME, id);
        draggedRef.current = true;
        setDragId(id);
      },
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (overId !== id) setOverId(id);
      },
      onDragLeave: () => setOverId((cur) => (cur === id ? null : cur)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const from = e.dataTransfer.getData(TAB_DRAG_MIME);
        setDragId(null);
        setOverId(null);
        if (from) commitReorder(from, id);
      },
    };
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {orderedTabs.map((t) => {
        const isActive = activeId === t.id;
        if (t.kind === "default") {
          return (
            <Tab
              key={t.id}
              active={isActive}
              onClick={() => onSelect(DEFAULT_VIEW_ID)}
              label={allLabel}
              count={counts?.[DEFAULT_VIEW_ID]}
              {...dragPropsFor(t.id)}
            />
          );
        }
        const v = t.view!;
        const canEdit = v.ownerId === myId || (v.visibility === "shared" && canShare);
        return (
          <Tab
            key={v.id}
            active={isActive}
            onClick={() => onSelect(v.id)}
            onSecondaryClick={() => isActive && canEdit ? setEditing({ mode: "edit", view: v }) : null}
            label={v.name}
            editable={canEdit}
            count={counts?.[v.id]}
            visibility={v.visibility}
            {...dragPropsFor(v.id)}
          />
        );
      })}
      <button
        type="button"
        onClick={() => setEditing({ mode: "create" })}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-rule2 bg-paper px-3 py-1.5 text-[12px] font-semibold text-mute hover:border-brand-violet hover:text-brand-violet"
      >
        <Icon name="plus" size={11} strokeWidth={2.4} />
        New view
      </button>
      {onPreferencesChange && (
        <button
          type="button"
          onClick={() => setManaging(true)}
          className="ml-1 inline-flex items-center justify-center rounded-full border border-transparent p-1.5 text-mute hover:border-rule hover:text-ink"
          title="Manage tabs — hide, reorder"
          aria-label="Manage tabs"
        >
          <Icon name="settings" size={13} strokeWidth={2} />
        </button>
      )}

      {managing && onPreferencesChange && (
        <ManageTabsSheet
          views={views}
          hiddenSet={hiddenSet}
          tabOrder={tabOrder ?? []}
          onClose={() => setManaging(false)}
          onApply={(next) => {
            onPreferencesChange(next);
            setManaging(false);
          }}
        />
      )}

      {editing?.mode === "create" && (
        <ViewDialog
          mode="create"
          scope={scope}
          fields={fields}
          allColumns={allColumns}
          defaultColumns={defaultColumns}
          initialFilter={currentFilter}
          initialColumns={currentColumns.length > 0 ? currentColumns : [...defaultColumns]}
          canShare={canShare}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            onChange([...views, saved]);
            onSelect(saved.id);
            setEditing(null);
          }}
        />
      )}
      {editing?.mode === "edit" && (
        <ViewDialog
          mode="edit"
          scope={scope}
          view={editing.view}
          fields={fields}
          allColumns={allColumns}
          defaultColumns={defaultColumns}
          // Edit-mode pre-fills from the saved view itself, NOT the live table.
          // (User can choose to capture current state via a "Use current state"
          // button inside the dialog — see below.)
          initialFilter={savedFilterToFilterState(editing.view.filter)}
          initialColumns={editing.view.columns?.length ? editing.view.columns : [...defaultColumns]}
          // Plus, expose the live state so they can replace the saved values
          // with what's on screen if that's easier.
          liveFilter={currentFilter}
          liveColumns={currentColumns}
          canShare={canShare}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            onChange(views.map((v) => (v.id === saved.id ? saved : v)));
            setEditing(null);
          }}
          onDeleted={() => {
            onChange(views.filter((v) => v.id !== editing.view.id));
            if (activeId === editing.view.id) onSelect(DEFAULT_VIEW_ID);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function Tab({
  active, onClick, onSecondaryClick, label, editable, count, visibility,
  draggable, dragging, dropTarget, wasDragged,
  onDragStart, onDragOver, onDragLeave, onDrop,
}: {
  active: boolean;
  onClick: () => void;
  onSecondaryClick?: () => void | null;
  label: string;
  editable?: boolean;
  count?: number;
  /** Personal → single-person glyph; shared → two-person glyph; undefined
   *  (e.g. "All leads" default tab) → no glyph. */
  visibility?: SavedViewVisibility;
  draggable?: boolean;
  dragging?: boolean;
  dropTarget?: boolean;
  /** Set on dragstart so the click that some platforms fire after a drop can be
   *  swallowed instead of re-selecting the tab. */
  wasDragged?: React.MutableRefObject<boolean>;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent) => void;
}) {
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={(e) => {
        // Stop the click from bubbling further up the tree — otherwise the
        // native mouseup arriving *after* setEditing() has mounted the
        // dialog can hit the freshly-rendered backdrop and dismiss it
        // (observed in a repro where clicking the active tab briefly showed
        // "Edit view" then closed).
        e.stopPropagation();
        // Swallow the click that trails a drag, so dropping a tab reorders it
        // without also selecting it (or opening its editor, if it was active).
        if (wasDragged?.current) {
          wasDragged.current = false;
          return;
        }
        if (active && onSecondaryClick) onSecondaryClick();
        else onClick();
      }}
      title={
        active && editable ? "Click again to edit · drag to reorder"
        : visibility === "shared" ? `${label} · shared with the team`
        : visibility === "personal" ? `${label} · your personal view`
        : label
      }
      className={cn(
        // Compact style — no border, subtle active underline instead of a pill outline.
        // Inspired by Freshsales / Salesforce tab strips: dense, less visual noise.
        "group relative inline-flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-[12.5px] font-semibold transition",
        active
          ? "border-brand-violet text-brand-violet"
          : "border-transparent text-ink2 hover:text-ink",
        draggable && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-40",
        // A left rule marks where the dragged tab will land — clearer than
        // tinting the whole target, which reads as "you're selecting this".
        dropTarget && "before:absolute before:inset-y-1 before:-left-[3px] before:w-[2px] before:rounded-full before:bg-brand-violet",
      )}
    >
      {visibility === "personal" && <PersonGlyph className={active ? "text-brand-violet" : "text-mute"} />}
      {visibility === "shared"   && <TeamGlyph   className={active ? "text-brand-violet" : "text-mute"} />}
      <span>{label}</span>
      {typeof count === "number" && (
        <span className={cn(
          "mono-cap text-[10px] font-semibold tracking-[.04em]",
          active ? "text-brand-violet/80" : "text-mute",
        )}>
          {count}
        </span>
      )}
    </button>
  );
}

// Single-person glyph — used on tabs that are personal to this user.
// Inlined (rather than added to the shared Icon component) because it's
// only used here and keeps this file self-contained.
function PersonGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16" className={cn("h-3.5 w-3.5", className)}
      fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="8" cy="5" r="2.5" />
      <path d="M3 14c0-2.5 2.2-4 5-4s5 1.5 5 4" />
    </svg>
  );
}

// Two-person glyph — used on tabs that are shared with the tenant.
function TeamGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16" className={cn("h-3.5 w-3.5", className)}
      fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="11.5" cy="5.5" r="1.7" />
      <path d="M1.5 14c0-2.2 2-3.6 4.5-3.6S10.5 11.8 10.5 14" />
      <path d="M10.5 10.5c2 0 4 1.2 4 3.5" />
    </svg>
  );
}

// ─── Manage tabs sheet ─────────────────────────────────────────────────
//
// Simple list of every saved view (+ the "All leads" pseudo). Users can:
//   - toggle each row's visibility
//   - drag rows to reorder
// Apply → parent's onPreferencesChange → PATCH /me/view-preferences.

function ManageTabsSheet({
  views, hiddenSet, tabOrder, onClose, onApply,
}: {
  views: SavedView[];
  hiddenSet: Set<string>;
  tabOrder: string[];
  onClose: () => void;
  onApply: (next: { hiddenViewIds: string[]; tabOrder: string[] }) => void;
}) {
  // Build the working list. Ordered like the tab strip so the sheet
  // matches what the user sees.
  const initial = useMemo(() => {
    const all: Array<{ id: string; label: string; shared: boolean }> = [
      { id: DEFAULT_VIEW_ID, label: "All leads", shared: false },
      ...views.map((v) => ({ id: v.id, label: v.name, shared: v.visibility === "shared" })),
    ];
    if (!tabOrder || tabOrder.length === 0) return all;
    const rank = new Map(tabOrder.map((id, i) => [id, i]));
    return all.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  }, [views, tabOrder]);

  const [rows, setRows] = useState(initial);
  const [hidden, setHidden] = useState<Set<string>>(hiddenSet);

  function move(idx: number, dir: -1 | 1) {
    const swap = idx + dir;
    if (swap < 0 || swap >= rows.length) return;
    const next = [...rows];
    [next[idx], next[swap]] = [next[swap]!, next[idx]!];
    setRows(next);
  }
  function toggle(id: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function apply() {
    onApply({
      hiddenViewIds: Array.from(hidden),
      tabOrder: rows.map((r) => r.id),
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="my-12 w-full max-w-[520px] rounded-2xl border border-rule bg-paper p-6 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[22px] font-normal leading-tight tracking-[-.01em]">Manage tabs</h2>
            <p className="mt-1 text-[12.5px] text-mute">
              Hide or reorder any tab. Your changes only affect your own view — other users keep their own layout.
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>

        <div className="mt-4 space-y-1">
          {rows.map((r, i) => {
            const isHidden = hidden.has(r.id);
            return (
              <div key={r.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-warm/40">
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  className="rounded text-mute hover:text-ink disabled:opacity-30"
                  aria-label={`Move ${r.label} up`}
                  title="Move up"
                >
                  ▲
                </button>
                <button
                  type="button"
                  disabled={i === rows.length - 1}
                  onClick={() => move(i, 1)}
                  className="rounded text-mute hover:text-ink disabled:opacity-30"
                  aria-label={`Move ${r.label} down`}
                  title="Move down"
                >
                  ▼
                </button>
                <span className={cn("flex-1 truncate text-[13px]", isHidden ? "text-hint line-through" : "text-ink")}>
                  {r.label}
                  {r.shared && <span className="mono-cap ml-1.5 text-[9px] tracking-[.06em] text-mute">SHARED</span>}
                </span>
                <label className="inline-flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={!isHidden}
                    onChange={() => toggle(r.id)}
                    className="h-3.5 w-3.5 accent-brand-violet"
                  />
                  <span className="text-[11px] text-mute">Visible</span>
                </label>
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2 border-t border-rule pt-4">
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="button" onClick={apply} className="btn-grad">Apply</button>
        </div>
      </div>
    </div>
  );
}

// Coerce the SavedView["filter"] JSONB blob (server side it's loose) into a
// well-formed FilterState the FilterBar can render. Anything that doesn't
// fit the expected shape becomes an empty filter.
function savedFilterToFilterState(filter: SavedView["filter"]): FilterState {
  if (filter && typeof filter === "object" && Array.isArray((filter as Record<string, unknown>).rules)) {
    const f = filter as unknown as FilterState;
    return { combinator: f.combinator === "or" ? "or" : "and", rules: f.rules };
  }
  return { combinator: "and", rules: [] };
}

// ─── dialog ───────────────────────────────────────────────────────────────

function ViewDialog({
  mode, scope, view,
  fields, allColumns, defaultColumns,
  initialFilter, initialColumns,
  liveFilter, liveColumns,
  canShare,
  onClose, onSaved, onDeleted,
}: {
  mode: "create" | "edit";
  scope: SavedViewScope;
  view?: SavedView;
  fields: FilterField[];
  allColumns: ReadonlyArray<{ key: string; label: string }>;
  defaultColumns: readonly string[];
  initialFilter: FilterState;
  initialColumns: string[];
  /** Edit mode only — the table's current state, offered as a one-click reset. */
  liveFilter?: FilterState;
  liveColumns?: string[];
  canShare: boolean;
  onClose: () => void;
  onSaved: (v: SavedView) => void;
  onDeleted?: () => void;
}) {
  const [name, setName] = useState(view?.name ?? "");
  const [visibility, setVisibility] = useState<SavedViewVisibility>(view?.visibility ?? "personal");
  const [filter, setFilter] = useState<FilterState>(initialFilter);
  const [visible, setVisible] = useState<string[]>(initialColumns);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const totalRows = useMemo(() => 0, []); // we don't have leads here; FilterBar's count is decorative

  function moveColumn(key: string, dir: -1 | 1) {
    setVisible((prev) => {
      const idx = prev.indexOf(key);
      if (idx < 0) return prev;
      const swap = idx + dir;
      if (swap < 0 || swap >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swap]] = [next[swap]!, next[idx]!];
      return next;
    });
  }
  function toggleColumn(key: string) {
    setVisible((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);
  }

  function useLiveState() {
    if (liveFilter) setFilter(liveFilter);
    if (liveColumns && liveColumns.length > 0) setVisible(liveColumns);
  }
  function resetColumnsToDefault() {
    setVisible([...defaultColumns]);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        visibility,
        filter: filter as unknown as SavedView["filter"],
        columns: visible.length > 0 ? visible : null,
      };
      if (mode === "create") {
        const v = await createSavedView(scope, payload);
        onSaved(v);
      } else if (view) {
        const v = await updateSavedView(view.id, payload);
        onSaved(v);
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!view || !onDeleted) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSavedView(view.id);
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20";

  // Backdrop dismissal — only close when a full click cycle (mousedown +
  // mouseup) BOTH landed on the backdrop element itself. Clicks that started
  // inside the modal card, popovers, or FilterBar dropdowns cannot dismiss.
  //
  // Key detail: we track the mousedown target at CAPTURE phase on the
  // backdrop. Because capture phase runs before any child bubble handler
  // gets a chance to stopPropagation, we always see the true mousedown
  // origin. Then on mouseup, we only close if BOTH events had the backdrop
  // as their direct target — anything popover-triggered fails that check.
  const downOnBackdrop = useRef(false);
  const mountedAt = useRef<number>(Date.now());
  const onBackdropMouseDownCapture = (e: React.MouseEvent) => {
    downOnBackdrop.current = e.target === e.currentTarget;
  };
  const onBackdropClick = (e: React.MouseEvent) => {
    // Ignore the opening tab's click that arrives immediately after mount.
    if (Date.now() - mountedAt.current < 250) return;
    if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
    downOnBackdrop.current = false;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-6 backdrop-blur-sm"
      onMouseDownCapture={onBackdropMouseDownCapture}
      onClick={onBackdropClick}
    >
      {/* Column-flex dialog: header stays put, body scrolls, footer sticks. */}
      <div
        className="flex w-full max-w-[820px] max-h-[calc(100vh-3rem)] flex-col rounded-2xl border border-rule bg-paper shadow-card"
      >
        {/* Fixed header */}
        <div className="flex-none border-b border-rule px-7 pt-6 pb-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-serif text-[24px] font-normal leading-tight tracking-[-.01em]">
                {mode === "create" ? "Save view" : "Edit view"}
              </h2>
              <p className="mt-1 text-[12.5px] text-mute">
                Pick the filters and columns that make this view, give it a name, and save.
              </p>
            </div>
            <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
              <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
            </button>
          </div>
        </div>

        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-7 py-6">
          {/* Name + visibility */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">
                Name <span className="ml-1 text-brand-magenta">*</span>
              </span>
              <input
                ref={inputRef}
                className={inputCls}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                placeholder="e.g. My hot leads, Demo no-shows"
              />
            </label>
            <fieldset>
              <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">
                Visibility
              </span>
              {mode === "edit" ? (
                // Once a view is created, visibility is locked. Flipping a
                // personal view to shared (or the reverse) can be surprising
                // for the rest of the team, so we make it a create-time
                // decision only. To change scope, delete + recreate.
                <div className="flex items-center gap-2 rounded-md border border-rule bg-warm/30 px-3 py-2.5 text-[13px] text-ink2">
                  {visibility === "shared" ? (
                    <>
                      <TeamGlyph className="text-mute" />
                      <span className="font-semibold">Shared with team</span>
                    </>
                  ) : (
                    <>
                      <PersonGlyph className="text-mute" />
                      <span className="font-semibold">Just me</span>
                    </>
                  )}
                  <span className="mono-cap ml-auto text-[9.5px] tracking-[.08em] text-hint">
                    LOCKED
                  </span>
                </div>
              ) : (
                <div className="flex gap-2">
                  <label
                    className={cn(
                      "flex flex-1 cursor-pointer items-center gap-2 rounded-md border px-3 py-2.5 text-[13px]",
                      visibility === "personal" ? "border-brand-violet bg-brand-violet/[.06]" : "border-rule",
                    )}
                  >
                    <input
                      type="radio"
                      name="visibility"
                      checked={visibility === "personal"}
                      onChange={() => setVisibility("personal")}
                    />
                    Just me
                  </label>
                  <label
                    className={cn(
                      "flex flex-1 items-center gap-2 rounded-md border px-3 py-2.5 text-[13px]",
                      !canShare && "cursor-not-allowed bg-warm/40 opacity-60",
                      canShare && (visibility === "shared" ? "cursor-pointer border-brand-violet bg-brand-violet/[.06]" : "cursor-pointer border-rule"),
                    )}
                    title={canShare ? "" : "Needs the pipeline.write permission"}
                  >
                    <input
                      type="radio"
                      name="visibility"
                      checked={visibility === "shared"}
                      onChange={() => setVisibility("shared")}
                      disabled={!canShare}
                    />
                    Shared with team
                  </label>
                </div>
              )}
            </fieldset>
          </div>

          {/* Filters */}
          <section>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">
                Filters
              </span>
              {liveFilter && (
                <button
                  type="button"
                  onClick={() => useLiveState()}
                  className="text-[11px] font-semibold text-brand-violet hover:underline"
                  title="Replace with what the table is currently showing"
                >
                  Use current table state
                </button>
              )}
            </div>
            <div className="rounded-[10px] border border-rule bg-warm/30 p-2">
              <FilterBar
                fields={fields}
                state={filter}
                onChange={setFilter}
                placeholder="Add a filter rule…"
                totalRows={totalRows}
                filteredRows={totalRows}
              />
            </div>
            <div className="mono-cap mt-1 text-[9.5px] tracking-[.04em] text-hint">
              {filter.rules.length} rule{filter.rules.length === 1 ? "" : "s"}
              {filter.rules.length === 0 && " · no filters means this view shows every lead"}
            </div>
          </section>

          {/* Columns */}
          <section>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">
                Columns · {visible.length} visible
              </span>
              <button
                type="button"
                onClick={resetColumnsToDefault}
                className="text-[11px] font-semibold text-mute hover:text-ink"
              >
                Reset to default
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {/* Visible — drag-free reorder via up/down arrows */}
              <div className="overflow-hidden rounded-[10px] border border-rule">
                <div className="border-b border-rule bg-warm/40 px-3 py-1.5">
                  <div className="mono-cap text-[9.5px] font-semibold tracking-[.12em] text-mute">
                    Visible · {visible.length}
                  </div>
                </div>
                <div className="max-h-[240px] overflow-y-auto p-1.5">
                  {visible.length === 0 ? (
                    <div className="px-3 py-4 text-center text-[11.5px] text-mute">
                      No columns yet — pick from the right.
                    </div>
                  ) : visible.map((key, idx) => {
                    const c = allColumns.find((x) => x.key === key);
                    if (!c) return null;
                    return (
                      <div key={key} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-warm/60">
                        <input
                          type="checkbox"
                          checked
                          onChange={() => toggleColumn(key)}
                          className="h-3.5 w-3.5 accent-brand-violet"
                        />
                        <span className="flex-1 text-[12.5px] text-ink">{c.label}</span>
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => moveColumn(key, -1)}
                          className="rounded text-mute hover:text-ink disabled:opacity-30"
                          aria-label={`Move ${c.label} up`}
                        >
                          <ArrowGlyph dir="up" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === visible.length - 1}
                          onClick={() => moveColumn(key, 1)}
                          className="rounded text-mute hover:text-ink disabled:opacity-30"
                          aria-label={`Move ${c.label} down`}
                        >
                          <ArrowGlyph dir="down" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
              {/* Hidden — toggle to add */}
              <div className="overflow-hidden rounded-[10px] border border-rule">
                <div className="border-b border-rule bg-warm/40 px-3 py-1.5">
                  <div className="mono-cap text-[9.5px] font-semibold tracking-[.12em] text-mute">
                    Hidden · {allColumns.length - visible.length}
                  </div>
                </div>
                <div className="max-h-[240px] overflow-y-auto p-1.5">
                  {allColumns.filter((c) => !visible.includes(c.key)).map((c) => (
                    <label
                      key={c.key}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-warm/60"
                    >
                      <input
                        type="checkbox"
                        checked={false}
                        onChange={() => toggleColumn(c.key)}
                        className="h-3.5 w-3.5 accent-brand-violet"
                      />
                      <span className="flex-1 text-[12.5px] text-ink2">{c.label}</span>
                    </label>
                  ))}
                  {allColumns.length === visible.length && (
                    <div className="px-3 py-4 text-center text-[11.5px] text-mute">
                      All columns visible.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>

          </div>

          {/* Sticky footer — error banner + actions, always visible */}
          <div className="flex-none border-t border-rule px-7 py-4">
            {error && (
              <div className="mb-3 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
                {error}
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              {mode === "edit" && onDeleted ? (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={busy}
                  className="rounded-md border border-state-warn/40 bg-paper px-3 py-1.5 text-[12px] font-semibold text-state-warn hover:bg-state-warn/10 disabled:opacity-50"
                >
                  Delete view
                </button>
              ) : <span />}
              <div className="flex items-center gap-3">
                <button type="button" onClick={onClose} disabled={busy} className="btn">
                  Cancel
                </button>
                <button type="submit" disabled={busy || !name.trim()} className="btn-grad disabled:opacity-60">
                  {busy ? "Saving…" : mode === "create" ? "Save view" : "Update"}
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        title={`Delete the view "${view?.name ?? ""}"?`}
        body="This cannot be undone."
        confirmLabel="Delete view"
        variant="danger"
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={async () => {
          setConfirmingDelete(false);
          await onDelete();
        }}
      />
    </div>
  );
}

function ArrowGlyph({ dir }: { dir: "up" | "down" }) {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {dir === "up" ? <path d="M4 10l4-4 4 4" /> : <path d="M4 6l4 4 4-4" />}
    </svg>
  );
}
