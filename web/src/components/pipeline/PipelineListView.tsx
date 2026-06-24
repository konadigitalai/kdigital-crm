"use client";

// Editable pipeline list view. Pipedrive-style grid:
//   - User picks which columns to show + their order (saved per-user in localStorage).
//   - Click any cell to edit just that cell. Other cells stay read-only.
//   - Save / Cancel buttons appear inline next to the cell. Enter saves, Esc cancels.
//   - Each save is a focused PATCH /leads/:n with only the changed field.
//   - Tick row checkboxes to select; a sticky action bar enables bulk edits.

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { ScoreRing } from "@/components/ui/ScoreRing";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import { bulkDeleteLeads, bulkUpdateLeads, deleteLead, updateLead, type BulkLeadPatch } from "@/lib/api";
import { avatarGradClass, ratingStyles } from "@/lib/ui";
import type { CatalogResponse, Lead, LeadRating } from "@/lib/types";
import { LEAD_RATINGS } from "@/lib/types";

// ─── column registry ──────────────────────────────────────────────────────

// Every column the grid knows about. Order in this array is the *default*
// display order when no user preference exists.
//
// Exported for the saved-view dialog so it can render a column picker that
// stays in sync with what the table actually supports.
export type ColumnKey =
  | "name" | "rating" | "number" | "email"
  | "phoneCountryCode" | "phone" | "city"
  | "program" | "advisor" | "source" | "value"
  | "score" | "deliveryMode" | "timeZone"
  | "nextFollowupAt" | "demoAttendedAt"
  | "feePaid" | "feeDue" | "dueDate" | "registeredDate"
  | "description" | "createdAt";

type CellType =
  | "text"
  | "textarea"
  | "email"
  | "phone"
  | "money"
  | "date"
  | "select-program"
  | "select-advisor"
  | "select-source"
  | "select-rating"
  | "select-delivery"
  | "select-tz"
  | "readonly-name"
  | "readonly-number"
  | "readonly-score"
  | "readonly-created";

interface ColumnDef {
  key: ColumnKey;
  label: string;
  width: string;
  type: CellType;
}

const COLUMNS: ColumnDef[] = [
  { key: "name",            label: "Name",             width: "260px", type: "readonly-name" },
  { key: "rating",          label: "Rating",           width: "140px", type: "select-rating" },
  { key: "number",          label: "Lead #",           width: "120px", type: "readonly-number" },
  { key: "email",           label: "Email",            width: "230px", type: "email" },
  { key: "phoneCountryCode", label: "Phone CC",        width: "100px", type: "phone" },
  { key: "phone",           label: "Phone",            width: "170px", type: "phone" },
  { key: "city",            label: "City",             width: "140px", type: "text" },
  { key: "program",         label: "Program",          width: "200px", type: "select-program" },
  { key: "advisor",         label: "Advisor",          width: "160px", type: "select-advisor" },
  { key: "source",          label: "Source",           width: "150px", type: "select-source" },
  { key: "value",           label: "Price quoted (₹)", width: "130px", type: "money" },
  { key: "score",           label: "Score",            width: "90px",  type: "readonly-score" },
  { key: "deliveryMode",    label: "Mode",             width: "120px", type: "select-delivery" },
  { key: "timeZone",        label: "Time zone",        width: "150px", type: "select-tz" },
  { key: "nextFollowupAt",  label: "Next follow-up",   width: "150px", type: "date" },
  { key: "demoAttendedAt",  label: "Demo attended",    width: "150px", type: "date" },
  { key: "feePaid",         label: "Fee paid (₹)",     width: "120px", type: "money" },
  { key: "feeDue",          label: "Fee due (₹)",      width: "120px", type: "money" },
  { key: "dueDate",         label: "Due date",         width: "140px", type: "date" },
  { key: "registeredDate",  label: "Registered",       width: "140px", type: "date" },
  { key: "description",     label: "Description",      width: "360px", type: "textarea" },
  { key: "createdAt",       label: "Created at",       width: "160px", type: "readonly-created" },
];
const COLUMN_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));

const DEFAULT_VISIBLE: ColumnKey[] = [
  "name", "rating", "phone", "program", "advisor",
  "value", "nextFollowupAt", "score",
];

// Minimal public registry exposed to the saved-view dialog. We only export
// the (key, label) pairs and the default visible set — the dialog never
// needs to know about cell types or widths.
export const PIPELINE_LIST_COLUMNS: ReadonlyArray<{ key: ColumnKey; label: string }> =
  COLUMNS.map((c) => ({ key: c.key, label: c.label }));
export const PIPELINE_LIST_DEFAULT_COLUMNS: readonly ColumnKey[] = DEFAULT_VISIBLE;

const DELIVERY_OPTIONS = [
  { value: "",        label: "—" },
  { value: "online",  label: "Online" },
  { value: "offline", label: "Offline" },
  { value: "hybrid",  label: "Hybrid" },
];

const TZ_OPTIONS = [
  { value: "",                    label: "—" },
  { value: "Asia/Kolkata",        label: "IST · India" },
  { value: "America/New_York",    label: "ET · US Eastern" },
  { value: "America/Chicago",     label: "CT · US Central" },
  { value: "America/Denver",      label: "MT · US Mountain" },
  { value: "America/Los_Angeles", label: "PT · US Pacific" },
  { value: "Europe/London",       label: "UK · London" },
];

// ─── localStorage helpers ────────────────────────────────────────────────

const STORAGE_KEY = "decrm_pipeline_list_columns_v1";

function loadColumnPrefs(): ColumnKey[] {
  if (typeof window === "undefined") return DEFAULT_VISIBLE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_VISIBLE;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_VISIBLE;
    const valid = parsed.filter(
      (k): k is ColumnKey => typeof k === "string" && COLUMN_BY_KEY.has(k as ColumnKey),
    );
    return valid.length > 0 ? valid : DEFAULT_VISIBLE;
  } catch {
    return DEFAULT_VISIBLE;
  }
}

function saveColumnPrefs(cols: ColumnKey[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cols));
  } catch {
    /* localStorage may be unavailable (private mode) — silently ignore */
  }
}

// ─── value helpers ────────────────────────────────────────────────────────

// Compact INR — kept short for column footers / chart axes ("₹2.4Cr").
function fmtINR(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isNaN(n)) return String(v);
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(1).replace(/\.0$/, "")}Cr`;
  if (n >= 1_00_000)    return `₹${Math.round(n / 1_00_000)}L`;
  if (n >= 1_000)       return `₹${Math.round(n / 1_000)}k`;
  return `₹${Math.round(n)}`;
}

// Full INR with Indian grouping ("₹1,49,000") — used for the per-row Price
// quoted cell where the user wants to see the exact rupee amount, not an
// abbreviation. Falls through to the raw string for legacy non-numeric data
// in case the cleanup migration hasn't run yet.
function fmtINRFull(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isNaN(n)) return String(v);
  return `₹${n.toLocaleString("en-IN")}`;
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s.length === 10 ? `${s}T00:00:00` : s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
}

function fmtDateTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString("en-IN", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function dateInputValue(s: string | null | undefined): string {
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

// Phone display: never include the country code. The CC lives in its own
// field (lead.phoneCountryCode) and is shown only on the dedicated record
// page. Strip a leading "+digits" from any value that smuggled the CC into
// the phone column itself (legacy / seed rows).
function phoneWithoutCc(phone: string | null | undefined): string {
  if (!phone) return "";
  // Drop a leading +<1-4 digits> and any whitespace right after it.
  const stripped = phone.trim().replace(/^\+\d{1,4}\s*/, "");
  return stripped || phone.trim();
}

// ─── per-cell save helpers ────────────────────────────────────────────────

// Convert the in-input value to whatever shape PATCH /leads expects for that
// field. Strings get trimmed; empty becomes null. Numbers stay strings (the
// API parses on its side).
function buildPatchValue(_column: ColumnDef, raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const t = raw.trim();
    return t === "" ? null : t;
  }
  return raw;
}

// Map column key → PATCH body key. Most are 1:1; "advisor" / "program" /
// "source" / "rating" map to slightly different names.
function patchKeyFor(col: ColumnKey): string {
  switch (col) {
    case "advisor":  return "advisorId";   // value typed as advisorId in editor
    case "program":  return "programId";
    default:         return col;
  }
}

// What value goes into the editor when this cell starts editing.
function initialValueFor(l: Lead, col: ColumnDef): string {
  switch (col.key) {
    case "phone":          return phoneWithoutCc(l.phone);
    case "phoneCountryCode": return l.phoneCountryCode ?? "";
    case "rating":         return l.rating;
    case "program":        return l.programId ?? "";
    case "advisor":        return l.advisorId ?? "";
    case "source":         return l.source ?? "";
    case "deliveryMode":   return l.deliveryMode ?? "";
    case "timeZone":       return l.timeZone ?? "";
    case "feePaid":        return l.feePaid ?? "";
    case "feeDue":         return l.feeDue ?? "";
    case "dueDate":        return dateInputValue(l.dueDate);
    case "registeredDate": return dateInputValue(l.registeredDate);
    case "nextFollowupAt": return dateInputValue(l.nextFollowupAt);
    case "demoAttendedAt": return dateInputValue(l.demoAttendedAt);
    case "email":          return l.email ?? "";
    case "city":           return l.city ?? "";
    case "value":          return l.value ?? "";
    case "description":    return l.description ?? "";
    default:               return "";
  }
}

// What value the cell currently has, in editor-equivalent form. Used to
// decide whether the user actually changed anything before saving.
function currentEditableValue(l: Lead, col: ColumnDef): string {
  return initialValueFor(l, col);
}

// Translate an editor's draft value into a Lead-shape patch we can fold into
// the parent's local cache. For ID-bearing fields (programId / advisorId /
// source), we ALSO resolve the human label here so the displayed text in the
// list reflects the change immediately, not after the server round-trip.
function buildLocalPatch(
  _lead: Lead,
  col: ColumnDef,
  draft: string,
  catalog: CatalogResponse,
): Partial<Lead> {
  // Empty string in editor → null for nullable fields; "" for non-nullable
  // (program, value, city — those are typed as plain string in Lead).
  const nullable = draft === "" ? null : draft;
  switch (col.key) {
    case "phone":           return { phone: nullable };
    case "phoneCountryCode": return { phoneCountryCode: nullable };
    case "email":           return { email: nullable };
    case "city":            return { city: draft };
    case "value":           return { value: draft };
    case "description":     return { description: nullable };
    case "deliveryMode":    return { deliveryMode: nullable };
    case "timeZone":        return { timeZone: nullable };
    case "feePaid":         return { feePaid: nullable };
    case "feeDue":          return { feeDue: nullable };
    case "dueDate":         return { dueDate: nullable };
    case "registeredDate":  return { registeredDate: nullable };
    case "nextFollowupAt":  return { nextFollowupAt: nullable };
    case "demoAttendedAt":  return { demoAttendedAt: nullable };
    case "rating":          return { rating: (draft || "warm") as Lead["rating"] };
    case "program": {
      const p = catalog.programs.find((x) => x.id === draft);
      return { programId: nullable, program: p?.name ?? "" };
    }
    case "advisor": {
      const a = catalog.advisors.find((x) => x.id === draft);
      return { advisorId: nullable, advisorName: a?.name ?? null };
    }
    case "source": {
      const s = catalog.sources.find((x) => x.key === draft);
      return { source: nullable, sourceLabel: s?.label ?? null };
    }
    default: return {};
  }
}

// Snapshot the lead's current values for the keys that buildLocalPatch will
// overwrite — used to roll back on PATCH failure.
function buildRollbackPatch(lead: Lead, applied: Partial<Lead>): Partial<Lead> {
  const out: Record<string, unknown> = {};
  const leadAsRecord = lead as unknown as Record<string, unknown>;
  for (const key of Object.keys(applied)) {
    out[key] = leadAsRecord[key] ?? null;
  }
  return out as Partial<Lead>;
}

// ─── component ────────────────────────────────────────────────────────────

interface CellAddress { leadId: string; column: ColumnKey }

export function PipelineListView({
  leads,
  catalog,
  canWrite,
  canDelete = false,
  onLocalEdit,
  onLocalDelete,
  viewColumns,
  onColumnsChange,
}: {
  leads: Lead[];
  catalog: CatalogResponse;
  canWrite: boolean;
  /** When true, show the per-row Delete button + the bulk Delete action. */
  canDelete?: boolean;
  /** Optimistic-update callback. Receives a partial lead patch with all the
   * derived display fields (e.g. `programId` + `program` name resolved) so
   * the parent can fold it into its local cache and re-render immediately. */
  onLocalEdit: (leadId: string, patch: Partial<Lead>) => void;
  /** Optimistic-delete callback — parent drops these ids from localLeads. */
  onLocalDelete?: (leadIds: string[]) => void;
  /** Saved-view override. When non-null the parent's saved view dictates
   *  which columns are visible (and in what order). When null we fall back
   *  to the user's localStorage preference. */
  viewColumns?: string[] | null;
  /** Notify parent on every columns change so saved-view "Save current
   *  state" can capture them. Optional — pages without saved views can
   *  ignore it. */
  onColumnsChange?: (cols: string[]) => void;
}) {
  const router = useRouter();
  const [visible, setVisible] = useState<ColumnKey[]>(DEFAULT_VISIBLE);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editing, setEditing] = useState<CellAddress | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  // Selection — Set of lead.id (work_item id, UUID). Header checkbox toggles
  // every visible row; per-row checkbox toggles one. Selecting > 0 reveals
  // the sticky bulk action bar above the table.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  // Confirm-delete state — describes which delete the modal will run when
  // confirmed. `null` = closed. Single drives row-level delete; bulk drives
  // the toolbar action; both fall through one shared <ConfirmDialog>.
  const [pendingDelete, setPendingDelete] = useState<
    | { kind: "single"; lead: Lead }
    | { kind: "bulk"; ids: string[] }
    | null
  >(null);

  // Column source-of-truth:
  //   - When `viewColumns` is provided (a saved view is active), it wins.
  //   - Otherwise, hydrate from localStorage on mount.
  // Either way we keep a local `visible` mirror so the column picker remains
  // responsive (tweaks update visible immediately and bubble up via
  // onColumnsChange so the parent can save them).
  useEffect(() => {
    if (viewColumns && viewColumns.length > 0) {
      setVisible(viewColumns.filter((k) => COLUMN_BY_KEY.has(k as ColumnKey)) as ColumnKey[]);
    } else {
      setVisible(loadColumnPrefs());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewColumns?.join("|")]);

  // Close picker on outside click.
  useEffect(() => {
    if (!pickerOpen) return;
    function onClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [pickerOpen]);

  const visibleColumns = useMemo(
    () => visible.map((k) => COLUMN_BY_KEY.get(k)!).filter(Boolean),
    [visible],
  );

  // Grid columns: [checkbox 36px] [...visible columns] [open link 80px]
  const gridTemplate = useMemo(
    () => ["36px", ...visibleColumns.map((c) => c.width), "80px"].join(" "),
    [visibleColumns],
  );

  function startEdit(l: Lead, col: ColumnDef) {
    if (!canWrite) return;
    if (!isEditableType(col.type)) return;
    setError(null);
    setEditing({ leadId: l.id, column: col.key });
    setDraft(initialValueFor(l, col));
  }

  function cancel() {
    setEditing(null);
    setDraft("");
    setError(null);
  }

  async function commit(l: Lead, col: ColumnDef) {
    if (!editing) return;
    const before = currentEditableValue(l, col);
    if (draft === before) {
      cancel();
      return;
    }
    const apiKey = patchKeyFor(col.key);
    const value = buildPatchValue(col, draft);
    // Apply the change to local state BEFORE the network call so the user
    // sees the new value the moment they click ✓. router.refresh() reconciles
    // afterwards. If the server rejects, we roll back via `onLocalEdit` again.
    const localPatch = buildLocalPatch(l, col, draft, catalog);
    const rollbackPatch = buildRollbackPatch(l, localPatch);
    onLocalEdit(l.id, localPatch);
    setEditing(null);
    setDraft("");
    setBusy(true);
    setError(null);
    try {
      await updateLead(l.number, { [apiKey]: value } as Record<string, unknown>);
      // Pull canonical server state in the background — keeps derived fields
      // (score recomputation, NBA, etc.) fresh without blocking the UI.
      router.refresh();
    } catch (err) {
      // Roll back the optimistic edit so the UI matches reality.
      onLocalEdit(l.id, rollbackPatch);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Apply a new column ordering. Persists to localStorage when no view is
  // active; always notifies the parent so saved-view snapshots are accurate.
  function applyColumns(next: ColumnKey[]) {
    if (!viewColumns) saveColumnPrefs(next);
    setVisible(next);
    onColumnsChange?.(next);
  }

  function moveColumn(key: ColumnKey, dir: -1 | 1) {
    const idx = visible.indexOf(key);
    if (idx < 0) return;
    const swap = idx + dir;
    if (swap < 0 || swap >= visible.length) return;
    const next = [...visible];
    [next[idx], next[swap]] = [next[swap]!, next[idx]!];
    applyColumns(next);
  }

  function reorderColumn(key: ColumnKey, toIdx: number) {
    const fromIdx = visible.indexOf(key);
    if (fromIdx < 0) return;
    // toIdx is the *gap* index (0..length). If we remove the dragged item
    // first, anything dropping after its old position needs its index
    // shifted down by 1 to keep the "before/after" intent intact.
    const next = [...visible];
    next.splice(fromIdx, 1);
    const insertAt = toIdx > fromIdx ? toIdx - 1 : toIdx;
    next.splice(insertAt, 0, key);
    applyColumns(next);
  }

  function toggleColumn(key: ColumnKey) {
    const next = visible.includes(key)
      ? visible.filter((k) => k !== key)
      : [...visible, key];
    applyColumns(next);
  }

  function resetColumns() {
    applyColumns(DEFAULT_VISIBLE);
  }

  // ─── selection helpers ────────────────────────────────────────────────

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      // If everything currently shown is already selected, clear. Else select all.
      const allShown = leads.every((l) => prev.has(l.id));
      return allShown ? new Set() : new Set(leads.map((l) => l.id));
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  // Number of currently-shown leads that are selected. Used by the action
  // bar copy ("3 of 12 selected") and the header checkbox state.
  const selectedShownCount = useMemo(
    () => leads.reduce((n, l) => n + (selected.has(l.id) ? 1 : 0), 0),
    [leads, selected],
  );
  const allShownSelected = selectedShownCount > 0 && selectedShownCount === leads.length;
  const someShownSelected = selectedShownCount > 0 && !allShownSelected;

  // ─── bulk update ──────────────────────────────────────────────────────
  // Applies a patch to every selected lead. Optimistic-update each row first
  // so the table flips instantly; on error, roll back the affected rows.
  async function applyBulkPatch(patch: BulkLeadPatch) {
    const ids = Array.from(selected);
    if (!ids.length || Object.keys(patch).length === 0) return;

    // Pre-compute the local patch (with resolved labels) and per-id rollback
    // snapshot before mutating anything.
    const localPatchByLead = new Map<string, Partial<Lead>>();
    const rollbackByLead = new Map<string, Partial<Lead>>();
    const idToLead = new Map<string, Lead>(leads.map((l) => [l.id, l]));
    for (const id of ids) {
      const lead = idToLead.get(id);
      if (!lead) continue;
      const local = bulkPatchToLocalPatch(patch, catalog);
      localPatchByLead.set(id, local);
      rollbackByLead.set(id, snapshotForKeys(lead, Object.keys(local) as (keyof Lead)[]));
    }

    // Optimistic apply.
    for (const [id, local] of localPatchByLead) onLocalEdit(id, local);

    setBusy(true);
    setError(null);
    try {
      const result = await bulkUpdateLeads(ids, patch);
      if (result.failed.length > 0) {
        // Roll back only the failed ones; the rest stay applied.
        for (const f of result.failed) {
          const rb = rollbackByLead.get(f.id);
          if (rb) onLocalEdit(f.id, rb);
        }
        setError(
          `${result.updated} updated, ${result.failed.length} failed. ` +
          `First error: ${result.failed[0]!.error}`,
        );
      }
      router.refresh();
    } catch (err) {
      // Whole request failed — roll back everything we optimistically applied.
      for (const [id, rb] of rollbackByLead) onLocalEdit(id, rb);
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setBulkDialogOpen(false);
      // Don't auto-clear selection — the user may want to keep selecting more.
    }
  }

  // ─── delete (single) — open the in-app confirm modal ──────────────────
  function deleteOne(lead: Lead) {
    if (!canDelete) return;
    setPendingDelete({ kind: "single", lead });
  }

  async function runDeleteOne(lead: Lead) {
    // Optimistic — drop the row immediately.
    onLocalDelete?.([lead.id]);
    setBusy(true);
    setError(null);
    try {
      await deleteLead(lead.id);
      router.refresh();
    } catch (err) {
      // Roll back: server didn't accept the delete, but we've removed it
      // locally. Easiest recovery is to re-fetch — router.refresh will pull
      // it back in. Surface the error so the user knows.
      setError(`Couldn't delete ${lead.number}: ${(err as Error).message}`);
      router.refresh();
    } finally {
      setBusy(false);
      setPendingDelete(null);
    }
  }

  // ─── delete (bulk) — open the in-app confirm modal ────────────────────
  function deleteSelected() {
    if (!canDelete) return;
    const ids = Array.from(selected);
    if (!ids.length) return;
    setPendingDelete({ kind: "bulk", ids });
  }

  async function runDeleteBulk(ids: string[]) {
    onLocalDelete?.(ids);
    setBusy(true);
    setError(null);
    try {
      const result = await bulkDeleteLeads(ids);
      if (result.failed.length > 0) {
        setError(
          `${result.deleted} deleted, ${result.failed.length} failed. ` +
          `First error: ${result.failed[0]!.error}`,
        );
        // refresh will repopulate any failures.
      }
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      router.refresh();
    } finally {
      setBusy(false);
      setPendingDelete(null);
    }
  }

  if (leads.length === 0) {
    return (
      <div className="rounded-2xl border border-rule bg-paper p-12 text-center text-[13px] text-mute">
        No leads match the current filter.
      </div>
    );
  }

  const confirmDialog = pendingDelete ? (
    <ConfirmDialog
      open
      title={
        pendingDelete.kind === "single"
          ? `Delete lead ${pendingDelete.lead.number}?`
          : `Delete ${pendingDelete.ids.length} lead${pendingDelete.ids.length === 1 ? "" : "s"}?`
      }
      body={
        pendingDelete.kind === "single" ? (
          <>
            <p className="mb-1.5">
              <span className="font-semibold text-ink">{pendingDelete.lead.name}</span> will be hidden from the pipeline.
            </p>
            <p className="text-mute">
              Activity history is preserved — an admin can restore it later.
            </p>
          </>
        ) : (
          <p className="text-mute">
            These leads will be hidden from the pipeline. Activity history is preserved — an admin can restore them later.
          </p>
        )
      }
      confirmLabel={pendingDelete.kind === "single" ? "Delete lead" : `Delete ${pendingDelete.ids.length}`}
      variant="danger"
      onConfirm={async () => {
        if (pendingDelete.kind === "single") await runDeleteOne(pendingDelete.lead);
        else await runDeleteBulk(pendingDelete.ids);
      }}
      onCancel={() => setPendingDelete(null)}
    />
  ) : null;

  return (
    <div className="space-y-3">
      {confirmDialog}
      <div className="flex items-center justify-between">
        <div className="text-[12.5px] text-mute">
          {leads.length} lead{leads.length === 1 ? "" : "s"} ·{" "}
          {canWrite ? (
            <span className="text-ink2">click any cell to edit</span>
          ) : (
            <span className="text-mute">read-only</span>
          )}
        </div>
        <div className="relative" ref={pickerRef}>
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="inline-flex items-center gap-2 rounded-full border border-rule bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-ink2 hover:border-rule2 hover:text-ink"
          >
            <Icon name="settings" size={13} strokeWidth={2} />
            Columns ({visible.length})
          </button>
          {pickerOpen && (
            <ColumnPicker
              visible={visible}
              onToggle={toggleColumn}
              onMove={moveColumn}
              onReorder={reorderColumn}
              onReset={resetColumns}
            />
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
          {error}
        </div>
      )}

      {/* Sticky bulk action bar — only visible when at least one row is selected.
          Sits between the page title and the table. Doesn't follow page scroll
          (would be too noisy); just stays at the top of the table area. */}
      {selected.size > 0 && (
        <div className="sticky top-0 z-10 -mx-1 flex items-center gap-3 rounded-[12px] border border-brand-violet/40 bg-brand-violet/[.06] px-4 py-2.5 shadow-card">
          <Icon name="check" size={14} strokeWidth={2.4} className="text-brand-violet" />
          <span className="text-[13px] font-semibold text-ink">
            {selected.size} of {leads.length} selected
          </span>
          {canWrite && (
            <button
              type="button"
              onClick={() => setBulkDialogOpen(true)}
              disabled={busy}
              className="btn-grad ml-3 px-3 py-1 text-[12px] disabled:opacity-60"
            >
              Update fields
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={deleteSelected}
              disabled={busy}
              className="rounded-md border border-state-warn/50 bg-state-warn/10 px-3 py-1 text-[12px] font-semibold text-state-warn hover:border-state-warn hover:bg-state-warn/15 disabled:opacity-50"
            >
              Delete
            </button>
          )}
          <button
            type="button"
            onClick={clearSelection}
            disabled={busy}
            className="ml-auto rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-rule2 disabled:opacity-50"
          >
            Clear
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-rule bg-paper">
        <div style={{ minWidth: "fit-content" }}>
          {/* Header */}
          <div
            className="grid items-center border-b border-rule bg-warm/60 px-4"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {/* Header select-all */}
            <div className="py-3 pr-3">
              <Tristate
                checked={allShownSelected}
                indeterminate={someShownSelected}
                onChange={toggleAll}
                ariaLabel={allShownSelected ? "Deselect all rows" : "Select all rows"}
              />
            </div>
            {visibleColumns.map((c) => (
              <div
                key={c.key}
                className="mono-cap py-3 pr-3 text-[9.5px] font-semibold tracking-[.12em] text-mute"
              >
                {c.label}
              </div>
            ))}
            <div className="py-3 text-right" />
          </div>

          {/* Rows */}
          {leads.map((l) => (
            <div
              key={l.id}
              className={cn(
                "grid items-center border-b border-rule px-4 transition last:border-b-0",
                selected.has(l.id) ? "bg-brand-violet/[.04]" : "hover:bg-warm/30",
              )}
              style={{ gridTemplateColumns: gridTemplate }}
            >
              {/* Per-row checkbox */}
              <div className="py-2 pr-3">
                <input
                  type="checkbox"
                  checked={selected.has(l.id)}
                  onChange={() => toggleOne(l.id)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Select lead ${l.number}`}
                  className="h-4 w-4 cursor-pointer accent-brand-violet"
                />
              </div>
              {visibleColumns.map((c) => {
                const isThisCellEditing =
                  editing?.leadId === l.id && editing.column === c.key;
                const cellEditable = canWrite && isEditableType(c.type);
                return (
                  <div
                    key={c.key}
                    onClick={() => {
                      if (isThisCellEditing) return;
                      if (cellEditable) startEdit(l, c);
                    }}
                    className={cn(
                      "relative py-2 pr-3 text-[12.5px] text-ink2",
                      cellEditable && !isThisCellEditing && "cursor-pointer rounded-md hover:bg-warm",
                    )}
                  >
                    {/* Always render the idle value so column widths stay stable. */}
                    <CellIdle column={c} lead={l} />
                    {/* When this cell is being edited, overlay a popover that
                        sits ABOVE the cell with its own width — long values
                        get the room they need without disturbing the row. */}
                    {isThisCellEditing && (
                      <CellEditorPopover
                        column={c}
                        catalog={catalog}
                        value={draft}
                        busy={busy}
                        onChange={setDraft}
                        onCommit={() => commit(l, c)}
                        onCancel={cancel}
                      />
                    )}
                  </div>
                );
              })}
              <div className="flex items-center justify-end gap-3 py-2">
                {canDelete && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); deleteOne(l); }}
                    disabled={busy}
                    title={`Delete ${l.number}`}
                    aria-label={`Delete ${l.number}`}
                    className="mono-cap text-[10px] font-semibold tracking-[.1em] text-mute hover:text-state-warn disabled:opacity-50"
                  >
                    Delete
                  </button>
                )}
                <Link
                  href={`/records/${l.number}`}
                  className="mono-cap inline-flex items-center gap-1 text-[10px] font-semibold tracking-[.1em] text-mute hover:text-brand-violet"
                >
                  Open
                  <Icon name="arrow-right" size={10} strokeWidth={2.4} />
                </Link>
              </div>
            </div>
          ))}
        </div>
      </div>

      {bulkDialogOpen && (
        <BulkUpdateDialog
          count={selected.size}
          catalog={catalog}
          busy={busy}
          onClose={() => setBulkDialogOpen(false)}
          onApply={applyBulkPatch}
        />
      )}
    </div>
  );
}

// Tristate checkbox — checked / unchecked / indeterminate. The native
// <input type="checkbox"> only exposes the indeterminate state via the DOM
// API, so we sync it through a ref on every render.
function Tristate({
  checked, indeterminate, onChange, ariaLabel,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={ariaLabel}
      className="h-4 w-4 cursor-pointer accent-brand-violet"
    />
  );
}

// ─── cell renderers ───────────────────────────────────────────────────────

function isEditableType(t: ColumnDef["type"]): boolean {
  return !t.startsWith("readonly-");
}

function CellIdle({ column, lead }: { column: ColumnDef; lead: Lead }) {
  if (column.type === "readonly-name") {
    return (
      <div className="flex min-w-0 items-center gap-2.5">
        <div className={cn("flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold text-white", avatarGradClass[lead.avatar])}>
          {lead.initials}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold tracking-[-.005em] text-ink">{lead.name}</div>
          <div className="mono-cap mt-0.5 truncate text-[9.5px] tracking-[.04em] text-mute">{lead.city || "—"}</div>
        </div>
      </div>
    );
  }
  if (column.type === "readonly-number") {
    return (
      <Link
        href={`/records/${lead.number}`}
        onClick={(e) => e.stopPropagation()}
        className="font-mono text-[11px] font-semibold tracking-[.04em] text-brand-violet hover:underline"
      >
        {lead.number}
      </Link>
    );
  }
  if (column.type === "readonly-score") {
    return (
      <div className="flex justify-center">
        <ScoreRing score={lead.score} heat={lead.heat} size={28} inner={22} fontSize={9.5} />
      </div>
    );
  }
  if (column.type === "readonly-created") {
    return <div className="truncate font-mono text-[11px] text-mute">{fmtDateTime(lead.createdAt)}</div>;
  }

  // Rating chip is special.
  if (column.type === "select-rating") {
    const sc = ratingStyles[lead.rating];
    return (
      <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold", sc.bg, sc.text)}>
        <span className={cn("h-1.5 w-1.5 rounded-full", sc.dot)} />
        {sc.label}
      </span>
    );
  }

  switch (column.key) {
    case "email":          return <span className="truncate" title={lead.email ?? undefined}>{lead.email || "—"}</span>;
    case "phone":          return <span className="truncate" title={lead.phone ?? undefined}>{phoneWithoutCc(lead.phone) || "—"}</span>;
    case "phoneCountryCode": return <span className="font-mono text-[12px]">{lead.phoneCountryCode || "—"}</span>;
    case "city":           return <span className="truncate">{lead.city || "—"}</span>;
    case "program":        return <span className="truncate" title={lead.program ?? undefined}>{lead.program || "—"}</span>;
    case "advisor":        return <span className="truncate" title={lead.advisorName ?? undefined}>{lead.advisorName || "—"}</span>;
    case "source":         return <span className="truncate">{lead.sourceLabel || lead.source || "—"}</span>;
    case "value":          return <span className="font-mono text-[12px]">{fmtINRFull(lead.value)}</span>;
    case "deliveryMode":   return <span>{lead.deliveryMode || "—"}</span>;
    case "timeZone":       return <span>{TZ_OPTIONS.find((o) => o.value === lead.timeZone)?.label ?? lead.timeZone ?? "—"}</span>;
    case "nextFollowupAt": return <span className="font-mono text-[11px]">{fmtDate(lead.nextFollowupAt)}</span>;
    case "demoAttendedAt": return <span className="font-mono text-[11px]">{fmtDate(lead.demoAttendedAt)}</span>;
    case "feePaid":        return <span className="font-mono text-[11px]">{fmtINR(lead.feePaid)}</span>;
    case "feeDue":         return <span className="font-mono text-[11px]">{fmtINR(lead.feeDue)}</span>;
    case "dueDate":        return <span className="font-mono text-[11px]">{fmtDate(lead.dueDate)}</span>;
    case "registeredDate": return <span className="font-mono text-[11px]">{fmtDate(lead.registeredDate)}</span>;
    case "description":    return <span className="line-clamp-2" title={lead.description ?? undefined}>{lead.description || "—"}</span>;
    default:               return <span>—</span>;
  }
}

// Editor popover. Anchors to the cell (its parent has `relative`) but sits
// in its own layer with a wider min-width, so a 6-digit money value or a
// long email isn't squeezed by the column track. Click-outside / Esc still
// dismiss; Enter still commits (or Cmd+Enter for textareas) — those live in
// the underlying CellEditor's keydown handler.
function CellEditorPopover(props: {
  column: ColumnDef;
  catalog: CatalogResponse;
  value: string;
  busy: boolean;
  onChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside the popover. We use `mousedown` so the close
  // happens before any focus-related events from the new target.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      props.onCancel();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-column popover width. Description gets the most room; everything
  // else gets a comfortable ~280px or wider for select/email/date.
  const minWidth = popoverWidthFor(props.column.type);

  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      className="absolute left-0 top-0 z-30 -m-px rounded-md border border-brand-violet/40 bg-paper p-2 shadow-card"
      style={{ minWidth }}
    >
      <CellEditor {...props} />
    </div>
  );
}

function popoverWidthFor(type: ColumnDef["type"]): string {
  switch (type) {
    case "textarea":         return "420px";
    case "email":            return "320px";
    case "select-program":
    case "select-advisor":
    case "select-source":
    case "select-tz":        return "280px";
    case "date":             return "200px";
    case "money":            return "240px";
    case "phone":            return "260px";
    default:                 return "260px";
  }
}

function CellEditor({
  column, catalog, value, busy, onChange, onCommit, onCancel,
}: {
  column: ColumnDef;
  catalog: CatalogResponse;
  value: string;
  busy: boolean;
  onChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const inputCls =
    "min-w-0 flex-1 rounded-md border border-rule bg-paper px-2 py-1 text-[12.5px] text-ink focus:border-brand-violet focus:outline-none focus:ring-1 focus:ring-brand-violet/20";

  // Single-line: Enter saves. Multi-line (textarea): Enter inserts a newline,
  // Ctrl/Cmd+Enter saves. Esc always cancels.
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === "Enter") {
      if (column.type === "textarea") {
        // Only commit on Cmd/Ctrl+Enter; plain Enter falls through to insert
        // a newline naturally.
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          onCommit();
        }
        return;
      }
      e.preventDefault();
      onCommit();
    }
  }

  let editor: React.ReactNode = null;
  switch (column.type) {
    case "text":
      editor = (
        <input
          type="text"
          autoFocus
          className={inputCls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
      );
      break;
    case "textarea":
      editor = <AutoTextarea value={value} onChange={onChange} onKeyDown={onKeyDown} />;
      break;
    case "email":
      editor = (
        <input
          type="email"
          autoFocus
          className={inputCls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="name@example.com"
        />
      );
      break;
    case "phone":
      editor = (
        <input
          type="tel"
          autoFocus
          className={inputCls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="98765 43210"
        />
      );
      break;
    case "money":
      editor = (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="font-mono text-[12.5px] text-mute">₹</span>
          <input
            type="text"
            inputMode="decimal"
            autoFocus
            className={inputCls}
            value={value}
            onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
            onKeyDown={onKeyDown}
            placeholder="0"
          />
        </span>
      );
      break;
    case "date":
      editor = (
        <input
          type="date"
          autoFocus
          className={inputCls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
      );
      break;
    case "select-rating":
      editor = (
        <select
          autoFocus
          className={inputCls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        >
          {LEAD_RATINGS.map((r) => (
            <option key={r} value={r}>{ratingStyles[r as LeadRating].label}</option>
          ))}
        </select>
      );
      break;
    case "select-program":
      editor = (
        <select
          autoFocus
          className={inputCls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        >
          <option value="">—</option>
          {catalog.programs.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      );
      break;
    case "select-advisor":
      editor = (
        <select
          autoFocus
          className={inputCls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        >
          <option value="">—</option>
          {catalog.advisors.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      );
      break;
    case "select-source":
      editor = (
        <select
          autoFocus
          className={inputCls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        >
          <option value="">—</option>
          {catalog.sources.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
      );
      break;
    case "select-delivery":
      editor = (
        <select
          autoFocus
          className={inputCls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        >
          {DELIVERY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
      break;
    case "select-tz":
      editor = (
        <select
          autoFocus
          className={inputCls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        >
          {TZ_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
      break;
    default:
      editor = null;
  }

  return (
    <div
      className="flex items-center gap-1.5"
      onClick={(e) => e.stopPropagation()}
    >
      {editor}
      <button
        type="button"
        onClick={onCommit}
        disabled={busy}
        title="Save (Enter)"
        aria-label="Save"
        className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-md bg-grad text-white disabled:opacity-60"
      >
        {busy ? <Spinner /> : <Icon name="check" size={12} strokeWidth={2.5} />}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        title="Cancel (Esc)"
        aria-label="Cancel"
        className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-md border border-rule bg-paper text-mute hover:border-rule2 hover:text-ink disabled:opacity-50"
      >
        <Icon name="plus" size={12} strokeWidth={2.5} className="rotate-45" />
      </button>
    </div>
  );
}

// Auto-growing textarea. Used for long-form fields like Description so the
// user can see all of what they're typing without scrolling a single-line
// input. Resets to scrollHeight on every change. Caps at ~12 rows so a
// pasted essay doesn't push the rest of the page off-screen.
function AutoTextarea({
  value,
  onChange,
  onKeyDown,
}: {
  value: string;
  onChange: (next: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Resize on mount + every value change.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, 240); // ~12 rows
    el.style.height = `${next}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      autoFocus
      rows={2}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      className="min-w-0 flex-1 resize-none rounded-md border border-rule bg-paper px-2 py-1.5 text-[12.5px] leading-[1.45] text-ink focus:border-brand-violet focus:outline-none focus:ring-1 focus:ring-brand-violet/20"
      placeholder="Notes, context, anything…"
    />
  );
}

function Spinner() {
  return (
    <svg
      className="h-3 w-3 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="9" strokeOpacity=".3" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}

// ─── column picker dropdown ───────────────────────────────────────────────

function ColumnPicker({
  visible, onToggle, onMove, onReorder, onReset,
}: {
  visible: ColumnKey[];
  onToggle: (key: ColumnKey) => void;
  onMove: (key: ColumnKey, dir: -1 | 1) => void;
  /** Drop a dragged column at a specific destination index. */
  onReorder: (key: ColumnKey, toIdx: number) => void;
  onReset: () => void;
}) {
  const [query, setQuery] = useState("");
  const [draggingKey, setDraggingKey] = useState<ColumnKey | null>(null);
  // Index where a drop would land, between rows. Drawn as a violet bar.
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  const visibleSet = new Set(visible);
  const hidden = COLUMNS.filter((c) => !visibleSet.has(c.key));

  // Apply the search filter — to the labels of both visible and hidden
  // columns. Empty query keeps everything; we still want to show the
  // visible group in its current order when the query is empty.
  const q = query.trim().toLowerCase();
  const matches = (label: string) => !q || label.toLowerCase().includes(q);
  const filteredVisible = visible.filter((k) => matches(COLUMN_BY_KEY.get(k)!.label));
  const filteredHidden = hidden.filter((c) => matches(c.label));

  function onDragStart(e: React.DragEvent, key: ColumnKey) {
    setDraggingKey(key);
    e.dataTransfer.effectAllowed = "move";
    // Some browsers refuse to start a drag without payload.
    e.dataTransfer.setData("text/plain", key);
  }
  function onDragEnd() {
    setDraggingKey(null);
    setDropIdx(null);
  }
  function onRowDragOver(e: React.DragEvent, idx: number) {
    if (!draggingKey) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // Snap to the nearer half of this row.
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    const target = before ? idx : idx + 1;
    if (target !== dropIdx) setDropIdx(target);
  }
  function onListDrop(e: React.DragEvent) {
    e.preventDefault();
    if (!draggingKey || dropIdx === null) {
      onDragEnd();
      return;
    }
    onReorder(draggingKey, dropIdx);
    onDragEnd();
  }

  return (
    <div className="absolute right-0 top-full z-30 mt-2 w-[340px] overflow-hidden rounded-xl border border-rule bg-paper shadow-card">
      {/* Search */}
      <div className="border-b border-rule px-3 py-2.5">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search fields…"
          className="w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-1 focus:ring-brand-violet/20"
          autoFocus
        />
      </div>

      {/* Visible group */}
      <div className="border-b border-rule bg-warm/40 px-4 py-2">
        <div className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">
          Visible · {visible.length}{q && ` · ${filteredVisible.length} match${filteredVisible.length === 1 ? "" : "es"}`}
        </div>
      </div>
      <div
        className="max-h-[300px] overflow-y-auto p-1.5"
        onDragOver={(e) => {
          // Allow drops in the empty space below the rows too.
          if (draggingKey) e.preventDefault();
        }}
        onDrop={onListDrop}
      >
        {filteredVisible.length === 0 ? (
          <div className="px-3 py-4 text-center text-[11.5px] text-mute">No matching fields.</div>
        ) : (
          filteredVisible.map((key) => {
            const c = COLUMN_BY_KEY.get(key)!;
            const realIdx = visible.indexOf(key);
            const isDragging = draggingKey === key;
            return (
              <div key={key}>
                {dropIdx === realIdx && draggingKey && draggingKey !== key && (
                  <div className="mx-1 my-0.5 h-0.5 rounded-full bg-brand-violet" />
                )}
                <div
                  draggable={!q}
                  onDragStart={(e) => onDragStart(e, key)}
                  onDragEnd={onDragEnd}
                  onDragOver={(e) => onRowDragOver(e, realIdx)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 transition",
                    !q && "cursor-grab active:cursor-grabbing",
                    isDragging ? "opacity-40" : "hover:bg-warm/60",
                  )}
                >
                  <input
                    type="checkbox"
                    checked
                    onChange={() => onToggle(key)}
                    className="h-3.5 w-3.5 accent-brand-violet"
                    aria-label={`Hide ${c.label}`}
                  />
                  <span className="flex-1 text-[12.5px] text-ink">{c.label}</span>
                  <button
                    type="button"
                    disabled={realIdx === 0 || !!q}
                    onClick={() => onMove(key, -1)}
                    className="rounded text-mute hover:text-ink disabled:opacity-30"
                    aria-label={`Move ${c.label} up`}
                  >
                    <ArrowGlyph dir="up" />
                  </button>
                  <button
                    type="button"
                    disabled={realIdx === visible.length - 1 || !!q}
                    onClick={() => onMove(key, 1)}
                    className="rounded text-mute hover:text-ink disabled:opacity-30"
                    aria-label={`Move ${c.label} down`}
                  >
                    <ArrowGlyph dir="down" />
                  </button>
                </div>
              </div>
            );
          })
        )}
        {/* Drop indicator at the end of the list */}
        {dropIdx === visible.length && draggingKey && (
          <div className="mx-1 my-0.5 h-0.5 rounded-full bg-brand-violet" />
        )}
      </div>

      {/* Hidden group */}
      {(filteredHidden.length > 0 || (q && hidden.length > 0)) && (
        <>
          <div className="border-y border-rule bg-warm/40 px-4 py-2">
            <div className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">
              Hidden · {hidden.length}{q && ` · ${filteredHidden.length} match${filteredHidden.length === 1 ? "" : "es"}`}
            </div>
          </div>
          <div className="max-h-[200px] overflow-y-auto p-1.5">
            {filteredHidden.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11.5px] text-mute">No matching fields.</div>
            ) : (
              filteredHidden.map((c) => (
                <label
                  key={c.key}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-warm/60"
                >
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={() => onToggle(c.key)}
                    className="h-3.5 w-3.5 accent-brand-violet"
                  />
                  <span className="flex-1 text-[12.5px] text-ink2">{c.label}</span>
                </label>
              ))
            )}
          </div>
        </>
      )}

      <div className="border-t border-rule px-2 py-2">
        <button
          type="button"
          onClick={onReset}
          className="w-full rounded-md px-2 py-1 text-left text-[11.5px] font-semibold text-mute hover:bg-warm/60 hover:text-ink"
        >
          Reset to default
        </button>
      </div>
    </div>
  );
}


function ArrowGlyph({ dir }: { dir: "up" | "down" }) {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {dir === "up"
        ? <path d="M4 10l4-4 4 4" />
        : <path d="M4 6l4 4 4-4" />}
    </svg>
  );
}

// ─── bulk update ──────────────────────────────────────────────────────────

// The fields the dialog can edit. Stays narrow on purpose — these are the
// ones where bulk-changing makes sense ("update next follow-up to next
// Friday for everyone in this batch", "reassign these 12 to Priya").
type BulkField =
  | "rating" | "programId" | "advisorId" | "source"
  | "deliveryMode" | "timeZone"
  | "nextFollowupAt" | "demoAttendedAt";

interface BulkFieldSpec {
  key: BulkField;
  label: string;
  /** Renders the value editor and yields the value string. */
  kind: "rating" | "program" | "advisor" | "source" | "delivery" | "tz" | "date";
}

const BULK_FIELDS: BulkFieldSpec[] = [
  { key: "rating",         label: "Rating",         kind: "rating"   },
  { key: "programId",      label: "Program",        kind: "program"  },
  { key: "advisorId",      label: "Advisor",        kind: "advisor"  },
  { key: "source",         label: "Source",         kind: "source"   },
  { key: "deliveryMode",   label: "Mode",           kind: "delivery" },
  { key: "timeZone",       label: "Time zone",      kind: "tz"       },
  { key: "nextFollowupAt", label: "Next follow-up", kind: "date"     },
  { key: "demoAttendedAt", label: "Demo attended",  kind: "date"     },
];

function BulkUpdateDialog({
  count, catalog, busy, onClose, onApply,
}: {
  count: number;
  catalog: CatalogResponse;
  busy: boolean;
  onClose: () => void;
  onApply: (patch: BulkLeadPatch) => Promise<void>;
}) {
  // Each field is opt-in. The dialog tracks (a) which keys are "active" (the
  // user wants to write them) and (b) what value they're set to. Apply only
  // sends active keys — so an untouched field stays untouched per-lead.
  const [active, setActive] = useState<Set<BulkField>>(new Set());
  const [values, setValues] = useState<Record<BulkField, string>>({
    rating: "warm",
    programId: "",
    advisorId: "",
    source: "",
    deliveryMode: "",
    timeZone: "",
    nextFollowupAt: "",
    demoAttendedAt: "",
  });

  function toggleField(k: BulkField) {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function setVal<K extends BulkField>(k: K, v: string) {
    setValues((prev) => ({ ...prev, [k]: v }));
  }

  function buildPatch(): BulkLeadPatch {
    const out: BulkLeadPatch = {};
    for (const k of active) {
      const v = values[k];
      switch (k) {
        case "rating":         out.rating         = v || "warm"; break;
        case "programId":      out.programId      = v || null; break;
        case "advisorId":      out.advisorId      = v || null; break;
        case "source":         out.source         = v || null; break;
        case "deliveryMode":   out.deliveryMode   = (v || null) as BulkLeadPatch["deliveryMode"]; break;
        case "timeZone":       out.timeZone       = v || null; break;
        case "nextFollowupAt": out.nextFollowupAt = v || null; break;
        case "demoAttendedAt": out.demoAttendedAt = v || null; break;
      }
    }
    return out;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (active.size === 0) return;
    await onApply(buildPatch());
  }

  const inputCls =
    "min-w-0 flex-1 rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[13px] text-ink focus:border-brand-violet focus:outline-none focus:ring-1 focus:ring-brand-violet/20";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="my-12 w-full max-w-[560px] rounded-2xl border border-rule bg-paper p-7 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[24px] font-normal leading-tight tracking-[-.01em]">
              Bulk update {count} lead{count === 1 ? "" : "s"}
            </h2>
            <p className="mt-1 text-[12.5px] text-mute">
              Tick the fields you want to overwrite. Untouched fields stay as they were on each lead.
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>

        <form onSubmit={onSubmit} className="space-y-2">
          {BULK_FIELDS.map((f) => {
            const on = active.has(f.key);
            return (
              <div
                key={f.key}
                className={cn(
                  "flex items-center gap-3 rounded-md border px-3 py-2 transition",
                  on ? "border-brand-violet/40 bg-brand-violet/[.04]" : "border-rule",
                )}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleField(f.key)}
                  aria-label={`Update ${f.label}`}
                  className="h-4 w-4 cursor-pointer accent-brand-violet"
                />
                <span className="w-[120px] flex-shrink-0 text-[12.5px] font-semibold text-ink">
                  {f.label}
                </span>
                <BulkFieldEditor
                  spec={f}
                  value={values[f.key]}
                  onChange={(v) => setVal(f.key, v)}
                  catalog={catalog}
                  disabled={!on}
                  inputCls={inputCls}
                />
              </div>
            );
          })}

          <div className="flex items-center justify-between gap-3 pt-4">
            <span className="text-[11.5px] text-mute">
              {active.size === 0
                ? "Tick at least one field to enable Apply"
                : `Will update ${active.size} field${active.size === 1 ? "" : "s"} on ${count} lead${count === 1 ? "" : "s"}`}
            </span>
            <div className="flex items-center gap-3">
              <button type="button" onClick={onClose} disabled={busy} className="btn">
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || active.size === 0}
                className="btn-grad disabled:opacity-60"
              >
                {busy ? "Applying…" : "Apply"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function BulkFieldEditor({
  spec, value, onChange, catalog, disabled, inputCls,
}: {
  spec: BulkFieldSpec;
  value: string;
  onChange: (v: string) => void;
  catalog: CatalogResponse;
  disabled: boolean;
  inputCls: string;
}) {
  switch (spec.kind) {
    case "rating":
      return (
        <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          {LEAD_RATINGS.map((r) => <option key={r} value={r}>{ratingStyles[r].label}</option>)}
        </select>
      );
    case "program":
      return (
        <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">— clear —</option>
          {catalog.programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      );
    case "advisor":
      return (
        <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">— unassign —</option>
          {catalog.advisors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      );
    case "source":
      return (
        <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">— clear —</option>
          {catalog.sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      );
    case "delivery":
      return (
        <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">— clear —</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="hybrid">Hybrid</option>
        </select>
      );
    case "tz":
      return (
        <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">— clear —</option>
          <option value="Asia/Kolkata">IST · India</option>
          <option value="America/New_York">ET · US Eastern</option>
          <option value="America/Chicago">CT · US Central</option>
          <option value="America/Denver">MT · US Mountain</option>
          <option value="America/Los_Angeles">PT · US Pacific</option>
          <option value="Europe/London">UK · London</option>
        </select>
      );
    case "date":
      return (
        <input
          type="date"
          className={inputCls}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      );
  }
}

// Translate a server-shape bulk patch into a Lead-shape local patch — same
// idea as buildLocalPatch above but operates from the BulkLeadPatch input
// (not a single column key + draft string).
function bulkPatchToLocalPatch(patch: BulkLeadPatch, catalog: CatalogResponse): Partial<Lead> {
  const out: Partial<Lead> = {};
  if (patch.rating         !== undefined) out.rating = patch.rating as Lead["rating"];
  if (patch.deliveryMode   !== undefined) out.deliveryMode = patch.deliveryMode ?? null;
  if (patch.timeZone       !== undefined) out.timeZone = patch.timeZone ?? null;
  if (patch.nextFollowupAt !== undefined) out.nextFollowupAt = patch.nextFollowupAt ?? null;
  if (patch.demoAttendedAt !== undefined) out.demoAttendedAt = patch.demoAttendedAt ?? null;
  if (patch.programId !== undefined) {
    const p = catalog.programs.find((x) => x.id === patch.programId);
    out.programId = patch.programId ?? null;
    out.program = p?.name ?? "";
  }
  if (patch.advisorId !== undefined) {
    const a = catalog.advisors.find((x) => x.id === patch.advisorId);
    out.advisorId = patch.advisorId ?? null;
    out.advisorName = a?.name ?? null;
  }
  if (patch.source !== undefined) {
    const s = catalog.sources.find((x) => x.key === patch.source);
    out.source = patch.source ?? null;
    out.sourceLabel = s?.label ?? null;
  }
  return out;
}

// Snapshot a lead's current values for the keys we're about to overwrite —
// used as the rollback patch if the network call fails.
function snapshotForKeys(lead: Lead, keys: (keyof Lead)[]): Partial<Lead> {
  const out: Record<string, unknown> = {};
  const rec = lead as unknown as Record<string, unknown>;
  for (const k of keys) out[k as string] = rec[k as string] ?? null;
  return out as Partial<Lead>;
}
