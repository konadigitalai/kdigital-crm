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
import type { FilterField, FilterState } from "@/components/filter/types";
import type { CurrentUser, SavedView, SavedViewVisibility } from "@/lib/types";

export const DEFAULT_VIEW_ID = "__all__";

interface Props {
  views: SavedView[];
  activeId: string;
  onSelect: (id: string) => void;

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
}

export function ViewTabs({
  views, activeId, onSelect,
  fields, allColumns, defaultColumns,
  currentFilter, currentColumns,
  onChange,
  currentUser, canShare,
}: Props) {
  const [editing, setEditing] = useState<{ mode: "create" } | { mode: "edit"; view: SavedView } | null>(null);
  const myId = currentUser?.id ?? "";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Tab
        active={activeId === DEFAULT_VIEW_ID}
        onClick={() => onSelect(DEFAULT_VIEW_ID)}
        label="All leads"
      />
      {views.map((v) => {
        const isActive = activeId === v.id;
        const canEdit = v.ownerId === myId || (v.visibility === "shared" && canShare);
        return (
          <Tab
            key={v.id}
            active={isActive}
            onClick={() => onSelect(v.id)}
            onSecondaryClick={() => isActive && canEdit ? setEditing({ mode: "edit", view: v }) : null}
            label={v.name}
            shared={v.visibility === "shared"}
            editable={canEdit}
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

      {editing?.mode === "create" && (
        <ViewDialog
          mode="create"
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
  active, onClick, onSecondaryClick, label, shared, editable,
}: {
  active: boolean;
  onClick: () => void;
  onSecondaryClick?: () => void | null;
  label: string;
  shared?: boolean;
  editable?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        // Stop the click from bubbling further up the tree — otherwise the
        // native mouseup arriving *after* setEditing() has mounted the
        // dialog can hit the freshly-rendered backdrop and dismiss it
        // (observed in a repro where clicking the active tab briefly showed
        // "Edit view" then closed).
        e.stopPropagation();
        if (active && onSecondaryClick) onSecondaryClick();
        else onClick();
      }}
      title={active && editable ? "Click again to edit" : label}
      className={cn(
        "group relative inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition",
        active
          ? "border-brand-violet bg-brand-violet/10 text-brand-violet"
          : "border-rule bg-paper text-ink2 hover:border-rule2 hover:text-ink",
      )}
    >
      <span>{label}</span>
      {shared && (
        <span className="mono-cap rounded-full border border-current/30 px-1.5 py-0.5 text-[8.5px] font-bold tracking-[.06em] opacity-70">
          shared
        </span>
      )}
      {active && editable && (
        <Icon name="settings" size={11} strokeWidth={2} className="opacity-60 group-hover:opacity-100" />
      )}
    </button>
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
  mode, view,
  fields, allColumns, defaultColumns,
  initialFilter, initialColumns,
  liveFilter, liveColumns,
  canShare,
  onClose, onSaved, onDeleted,
}: {
  mode: "create" | "edit";
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
        const v = await createSavedView("pipeline_list", payload);
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
    if (!confirm(`Delete the view "${view.name}"? This cannot be undone.`)) return;
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

  // Backdrop dismissal — arm on the FIRST *real* mousedown that lands on
  // the backdrop (not the one from the click that opened the dialog), then
  // close on the matching mouseup. Ignore the very first mousedown/up
  // pair after mount because that's the tail of the opening click.
  //
  // Without the initial-arm delay, clicking a tab to open the dialog would
  // see its own mouseup on the freshly-mounted backdrop and dismiss.
  const backdropPressed = useRef(false);
  const armedAt = useRef<number>(0);
  useEffect(() => {
    // Give the opening click's mouseup ~200ms to drain before we start
    // accepting backdrop dismisses.
    armedAt.current = Date.now() + 200;
  }, []);
  const onBackdropMouseDown = (e: React.MouseEvent) => {
    if (Date.now() < armedAt.current) return;
    backdropPressed.current = e.target === e.currentTarget;
  };
  const onBackdropMouseUp = (e: React.MouseEvent) => {
    if (Date.now() < armedAt.current) return;
    const shouldClose = backdropPressed.current && e.target === e.currentTarget;
    backdropPressed.current = false;
    if (shouldClose) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-6 backdrop-blur-sm"
      onMouseDown={onBackdropMouseDown}
      onMouseUp={onBackdropMouseUp}
    >
      {/* Column-flex dialog: header stays put, body scrolls, footer sticks.
          Stop mousedown/mouseup propagation so internal clicks never reach
          the backdrop's dismiss handlers. */}
      <div
        className="flex w-full max-w-[820px] max-h-[calc(100vh-3rem)] flex-col rounded-2xl border border-rule bg-paper shadow-card"
        onMouseDown={(e) => {
          e.stopPropagation();
          backdropPressed.current = false;
        }}
        onMouseUp={(e) => {
          e.stopPropagation();
          backdropPressed.current = false;
        }}
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
                  onClick={onDelete}
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
