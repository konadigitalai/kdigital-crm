"use client";

// Free-form timesheet viewer. Owns:
//   - anchor date + scope (day / week / month) — toolbar with ‹ › Today + a
//     mini calendar popover so you can jump to any date.
//   - filter (free-text note search).
//   - block list with inline Edit per row.
//   - "+ Add block" dialog that, on a 409 overlap, lets the user inline-edit
//     the conflicting block and re-submits the original block automatically.
//
// Data is refetched from /timesheets/range whenever the visible window
// changes, so navigation is fluid without a full page reload.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  ApiError,
  addLeave,
  addTimeBlock,
  deleteLeave,
  deleteTimeBlock,
  getTimesheetRange,
  patchTimeBlock,
} from "@/lib/api";
import type { LeaveDay, LeaveKind, TimeBlock, TimeBlockConflict } from "@/lib/types";

interface Props {
  initialWeek: { sessions: unknown[]; blocks: TimeBlock[]; leaves: LeaveDay[] };
  weekDates: string[];
  todayISO: string;
}

type Scope = "day" | "week" | "month";

const LEAVE_LABEL: Record<LeaveKind, string> = {
  sick: "Sick", personal: "Personal", vacation: "Vacation", wfh: "WFH", holiday: "Holiday",
};

const LEAVE_TONES: Record<LeaveKind, string> = {
  sick:     "bg-state-warn/10 text-state-warn",
  personal: "bg-brand-violet/10 text-brand-violet",
  vacation: "bg-brand-blue/10 text-brand-blue",
  wfh:      "bg-state-amber/10 text-state-amber",
  holiday:  "bg-state-ok/10 text-state-ok",
};

// ── IST date / time helpers ───────────────────────────────────────────────
function timeIST(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata",
  });
}
function durMins(startISO: string, endISO: string): number {
  return Math.max(0, Math.round((new Date(endISO).getTime() - new Date(startISO).getTime()) / 60_000));
}
function fmtDur(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
function localISTToISO(local: string): string {
  return new Date(`${local}:00+05:30`).toISOString();
}
function isoToLocalIST(iso: string): string {
  const ist = new Date(new Date(iso).getTime() + (5 * 60 + 30) * 60_000);
  return ist.toISOString().slice(0, 16);
}
function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function startOfWeekISO(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const sinceMon = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - sinceMon);
  return d.toISOString().slice(0, 10);
}
function weekDatesFor(anchor: string): string[] {
  const start = startOfWeekISO(anchor);
  return Array.from({ length: 7 }, (_, i) => addDaysISO(start, i));
}
// 6×7 month grid, Mon-aligned. Every IST date string for the calendar popover.
function monthGrid(anchor: string): string[] {
  const a = new Date(`${anchor}T12:00:00Z`);
  const first = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1, 12));
  const sinceMon = (first.getUTCDay() + 6) % 7;
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - sinceMon);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}
function monthBoundsISO(anchor: string): { from: string; to: string } {
  const dates = monthGrid(anchor);
  return { from: dates[0]!, to: dates[dates.length - 1]! };
}
function rangeFor(scope: Scope, anchor: string): { from: string; to: string; dates: string[] } {
  if (scope === "day") return { from: anchor, to: anchor, dates: [anchor] };
  if (scope === "week") {
    const dates = weekDatesFor(anchor);
    return { from: dates[0]!, to: dates[6]!, dates };
  }
  // month: scope-visible dates are the month-of-anchor; loaded range is the
  // 6×7 grid so leading/trailing cells render the carry-over weeks too.
  const { from, to } = monthBoundsISO(anchor);
  const ymA = anchor.slice(0, 7);
  const dates = monthGrid(anchor).filter((d) => d.startsWith(ymA));
  return { from, to, dates };
}

// ── component ────────────────────────────────────────────────────────────
export function TimesheetView({ initialWeek, weekDates, todayISO }: Props) {
  const router = useRouter();

  // Navigation state. Default = today, Day view.
  const [anchor, setAnchor] = useState<string>(todayISO);
  const [scope, setScope] = useState<Scope>("day");

  // Server data + loaded range so we don't refetch when staying inside it.
  const [blocks, setBlocks] = useState<TimeBlock[]>(initialWeek.blocks);
  const [leaves, setLeaves] = useState<LeaveDay[]>(initialWeek.leaves);
  const [loadedRange, setLoadedRange] = useState({
    from: weekDates[0]!,
    to: weekDates[weekDates.length - 1]!,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter.
  const [noteQuery, setNoteQuery] = useState("");

  // Dialog state. Single dialog used for create + edit + conflict resolution.
  const [dialog, setDialog] = useState<DialogState | null>(null);

  // Mini-calendar popover.
  const [calOpen, setCalOpen] = useState(false);
  const calBtnRef = useRef<HTMLButtonElement>(null);

  // Whenever scope/anchor changes we may need to load a wider window.
  // Always refetch a generous superset (the whole month containing the
  // anchor) so adjacent navigation is instant.
  const wantedRange = useMemo(() => monthBoundsISO(anchor), [anchor]);
  useEffect(() => {
    const sameRange = wantedRange.from === loadedRange.from && wantedRange.to === loadedRange.to;
    if (sameRange) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    getTimesheetRange(wantedRange.from, wantedRange.to)
      .then((r) => {
        if (cancelled) return;
        setBlocks(r.blocks);
        setLeaves(r.leaves);
        setLoadedRange(wantedRange);
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [wantedRange, loadedRange]);

  // Pull a fresh slice (used after writes).
  const refresh = useCallback(async () => {
    try {
      const r = await getTimesheetRange(wantedRange.from, wantedRange.to);
      setBlocks(r.blocks);
      setLeaves(r.leaves);
      setLoadedRange(wantedRange);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [wantedRange, router]);

  // ── Derived data ────────────────────────────────────────────────────────
  const { dates: scopeDates } = useMemo(() => rangeFor(scope, anchor), [scope, anchor]);
  const scopeDateSet = useMemo(() => new Set(scopeDates), [scopeDates]);

  const blocksInScope = useMemo(
    () => blocks.filter((b) => scopeDateSet.has(b.date)).sort((a, b) => a.startAt.localeCompare(b.startAt)),
    [blocks, scopeDateSet],
  );
  const filteredBlocks = useMemo(() => {
    const q = noteQuery.trim().toLowerCase();
    if (!q) return blocksInScope;
    return blocksInScope.filter((b) => (b.note ?? "").toLowerCase().includes(q));
  }, [blocksInScope, noteQuery]);

  const groupedBlocks = useMemo(() => {
    const m = new Map<string, TimeBlock[]>();
    for (const b of filteredBlocks) {
      const list = m.get(b.date) ?? [];
      list.push(b);
      m.set(b.date, list);
    }
    return Array.from(m.entries()).sort(([a], [b]) => b.localeCompare(a));
  }, [filteredBlocks]);

  const filteredTotalMins = useMemo(
    () => filteredBlocks.reduce((s, b) => s + durMins(b.startAt, b.endAt), 0),
    [filteredBlocks],
  );

  const blocksByDay = useMemo(() => {
    const m = new Map<string, TimeBlock[]>();
    for (const b of blocks) {
      const list = m.get(b.date) ?? [];
      list.push(b);
      m.set(b.date, list);
    }
    return m;
  }, [blocks]);
  const leavesByDay = useMemo(() => {
    const m = new Map<string, LeaveDay>();
    for (const l of leaves) m.set(l.date, l);
    return m;
  }, [leaves]);

  function minsForDay(date: string): number {
    return (blocksByDay.get(date) ?? []).reduce((s, b) => s + durMins(b.startAt, b.endAt), 0);
  }

  // ── Navigation ──────────────────────────────────────────────────────────
  function step(dir: -1 | 1) {
    if (scope === "day") setAnchor(addDaysISO(anchor, dir));
    else if (scope === "week") setAnchor(addDaysISO(anchor, dir * 7));
    else {
      const d = new Date(`${anchor}T12:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + dir);
      setAnchor(d.toISOString().slice(0, 10));
    }
  }
  function goToday() { setAnchor(todayISO); }

  // ── Filter helpers ──────────────────────────────────────────────────────
  function clearFilters() { setNoteQuery(""); }
  const filtersDirty = noteQuery.trim().length > 0;

  // ── Dialog helpers ──────────────────────────────────────────────────────
  function defaultSlotFor(date: string): { start: string; end: string } {
    const onDay = (blocksByDay.get(date) ?? []).slice().sort((a, b) => a.endAt.localeCompare(b.endAt));
    const last = onDay[onDay.length - 1];
    if (last) {
      const start = isoToLocalIST(last.endAt);
      const end = isoToLocalIST(new Date(new Date(last.endAt).getTime() + 60 * 60_000).toISOString());
      return { start, end };
    }
    return { start: `${date}T09:00`, end: `${date}T10:00` };
  }
  function openAddDialog(date: string) {
    setError(null);
    const slot = defaultSlotFor(date);
    setDialog({ kind: "create", defaultStart: slot.start, defaultEnd: slot.end });
  }
  function openEditDialog(b: TimeBlock) {
    setError(null);
    setDialog({ kind: "edit", block: b });
  }

  async function onAddSubmit(form: { startAt: string; endAt: string; note: string | null }) {
    try {
      await addTimeBlock(form);
      setDialog(null);
      await refresh();
      return { ok: true as const };
    } catch (e) {
      const conflict = extractConflict(e);
      if (conflict) return { ok: false as const, conflict, message: (e as Error).message };
      setError((e as Error).message);
      return { ok: false as const };
    }
  }
  async function onEditSubmit(blockId: string, patch: { startAt?: string; endAt?: string; note?: string | null }) {
    try {
      await patchTimeBlock(blockId, patch);
      setDialog(null);
      await refresh();
      return { ok: true as const };
    } catch (e) {
      const conflict = extractConflict(e);
      if (conflict) return { ok: false as const, conflict, message: (e as Error).message };
      setError((e as Error).message);
      return { ok: false as const };
    }
  }

  async function onDelete(b: TimeBlock) {
    if (!confirm("Delete this time block?")) return;
    try { await deleteTimeBlock(b.id); await refresh(); }
    catch (e) { setError((e as Error).message); }
  }

  // ── Title ───────────────────────────────────────────────────────────────
  const title = useMemo(() => {
    const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) =>
      new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { ...opts, timeZone: "Asia/Kolkata" });
    if (scope === "day") return fmt(anchor, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    if (scope === "week") {
      const dates = weekDatesFor(anchor);
      return `${fmt(dates[0]!, { day: "numeric", month: "short" })} – ${fmt(dates[6]!, { day: "numeric", month: "short", year: "numeric" })}`;
    }
    return fmt(anchor, { month: "long", year: "numeric" });
  }, [scope, anchor]);

  const todayMins = useMemo(() => minsForDay(todayISO), [todayISO, blocksByDay]); // eslint-disable-line react-hooks/exhaustive-deps
  const todayHasBlocks = (blocksByDay.get(todayISO) ?? []).length > 0;

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* HERO — quick-glance Today + primary actions. */}
      <div className="flex items-center gap-6 rounded-2xl border border-rule bg-paper p-6 shadow-card">
        <div>
          <div className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">
            {new Date(`${todayISO}T12:00:00Z`).toLocaleDateString("en-IN", {
              weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata",
            })}
          </div>
          <div className="mt-1 font-mono text-[34px] font-bold tracking-tight text-ink">
            {fmtDur(todayMins)}
          </div>
          <div className="mt-1 text-[12.5px] text-mute">
            {todayHasBlocks
              ? `${(blocksByDay.get(todayISO) ?? []).length} block${(blocksByDay.get(todayISO) ?? []).length === 1 ? "" : "s"} today`
              : "No blocks logged yet today"}
          </div>
        </div>
        <div className="flex-1" />
        <button onClick={() => openAddDialog(todayISO)} className="btn-grad">
          <Icon name="plus" size={14} strokeWidth={2.2} />
          Add block
        </button>
        <button
          onClick={() => setDialog({ kind: "leave" })}
          className="btn"
        >
          <Icon name="plus" size={13} strokeWidth={2.2} />
          Mark leave
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-mute hover:text-ink" aria-label="Dismiss">✕</button>
        </div>
      )}

      {/* Viewer */}
      <div className="rounded-2xl border border-rule bg-paper">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-rule px-5 py-3">
          <button onClick={() => step(-1)} title="Previous"
            className="rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet">‹</button>
          <button onClick={() => step(1)} title="Next"
            className="rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet">›</button>
          <button onClick={goToday}
            className="rounded-md border border-rule bg-paper px-3 py-1.5 text-[12px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet">
            Today
          </button>

          {/* Date pill — opens mini calendar */}
          <div className="relative">
            <button
              ref={calBtnRef}
              onClick={() => setCalOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:border-brand-violet"
              title="Pick a date"
            >
              <Icon name="clock" size={12} strokeWidth={2} className="text-mute" />
              {title}
              <span className="text-mute">▾</span>
            </button>
            {calOpen && (
              <MiniCalendar
                anchor={anchor}
                todayISO={todayISO}
                blocksByDay={blocksByDay}
                leavesByDay={leavesByDay}
                onPick={(iso) => { setAnchor(iso); setCalOpen(false); }}
                onClose={() => setCalOpen(false)}
              />
            )}
          </div>

          {busy && <span className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">syncing…</span>}

          <div className="flex-1" />

          <input
            value={noteQuery}
            onChange={(e) => setNoteQuery(e.target.value)}
            placeholder="Search notes…"
            className="w-[220px] rounded-[10px] border border-rule bg-paper px-3 py-1.5 text-[12.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
          />

          <div className="inline-flex rounded-[10px] border border-rule bg-warm/50 p-0.5">
            {(["day", "week", "month"] as Scope[]).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={cn(
                  "rounded-[8px] px-3 py-1 text-[12px] font-semibold capitalize transition",
                  scope === s ? "bg-grad text-white shadow-glow" : "text-ink2 hover:text-brand-violet",
                )}
              >
                {s}
              </button>
            ))}
          </div>

          <button
            onClick={() => openAddDialog(scope === "day" ? anchor : todayISO)}
            className="rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
            title="Add a new block on this date"
          >
            + New
          </button>
        </div>

        {/* Summary + filter chips */}
        <div className="flex flex-wrap items-center gap-2 border-b border-rule bg-warm/40 px-5 py-2.5">
          <span className="text-[11.5px] text-mute">
            <b className="font-semibold text-ink2">{filteredBlocks.length}</b>{" "}
            block{filteredBlocks.length === 1 ? "" : "s"} ·{" "}
            <b className="font-mono font-semibold text-ink2">{fmtDur(filteredTotalMins)}</b>
          </span>
          {filtersDirty && (
            <button onClick={clearFilters} className="ml-1 text-[11px] font-semibold text-mute hover:text-state-warn">
              Clear filters
            </button>
          )}
        </div>

        {/* Body */}
        {scope === "month" ? (
          <MonthBody
            anchor={anchor}
            todayISO={todayISO}
            blocksByDay={blocksByDay}
            leavesByDay={leavesByDay}
            noteQuery={noteQuery}
            onPickDay={(iso) => { setAnchor(iso); setScope("day"); }}
            onAddOnDay={openAddDialog}
          />
        ) : filteredBlocks.length === 0 ? (
          <div className="px-5 py-12 text-center text-[13px] text-mute">
            {filtersDirty
              ? "No blocks match the current filter."
              : (<>Click <b className="text-ink2">Add block</b> to log work — no need to clock in or out.</>)}
          </div>
        ) : (
          <div className="divide-y divide-rule">
            {groupedBlocks.map(([dateISO, blocksOnDay]) => {
              const dayMins = blocksOnDay.reduce((s, b) => s + durMins(b.startAt, b.endAt), 0);
              const leave = leavesByDay.get(dateISO);
              return (
                <div key={dateISO}>
                  <div className="flex items-baseline gap-3 bg-warm/30 px-5 py-1.5">
                    <span className="text-[12.5px] font-semibold text-ink2">
                      {new Date(`${dateISO}T12:00:00Z`).toLocaleDateString("en-IN", {
                        weekday: "short", day: "numeric", month: "short", year: "numeric",
                        timeZone: "Asia/Kolkata",
                      })}
                      {dateISO === todayISO && <span className="ml-2 mono-cap rounded bg-brand-violet/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-[.04em] text-brand-violet">TODAY</span>}
                    </span>
                    <span className="font-mono text-[11.5px] text-mute">{fmtDur(dayMins)}</span>
                    {leave && (
                      <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold", LEAVE_TONES[leave.kind])}>
                        {LEAVE_LABEL[leave.kind]}
                      </span>
                    )}
                    <div className="flex-1" />
                    <button
                      onClick={() => openAddDialog(dateISO)}
                      className="text-[11px] font-semibold text-mute hover:text-brand-violet"
                    >
                      + add to this day
                    </button>
                  </div>
                  <div className="divide-y divide-rule">
                    {blocksOnDay.map((b) => (
                      <BlockRow
                        key={b.id}
                        block={b}
                        onEdit={() => openEditDialog(b)}
                        onDelete={() => onDelete(b)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Leaves list — within the loaded month range. */}
      {leaves.length > 0 && (
        <div className="rounded-2xl border border-rule bg-paper">
          <div className="border-b border-rule px-5 py-3 mono-cap text-[10px] font-semibold tracking-[.12em] text-brand-violet">
            Leaves
          </div>
          <div className="divide-y divide-rule">
            {leaves.map((l) => (
              <div key={l.id} className="flex items-center gap-3 px-5 py-3">
                <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold", LEAVE_TONES[l.kind])}>
                  {LEAVE_LABEL[l.kind]}
                </span>
                <span className="text-[13px] font-semibold">{l.date}</span>
                {l.halfDay !== "full" && <span className="text-[11.5px] text-mute">({l.halfDay.toUpperCase()})</span>}
                {l.note && <span className="text-[12.5px] text-ink2">· {l.note}</span>}
                <div className="flex-1" />
                <button
                  onClick={async () => {
                    if (!confirm("Remove this leave?")) return;
                    try { await deleteLeave(l.id); await refresh(); } catch (e) { setError((e as Error).message); }
                  }}
                  className="text-[11.5px] font-semibold text-mute hover:text-state-warn"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Dialog */}
      {dialog?.kind === "create" && (
        <BlockDialog
          mode={{ kind: "create" }}
          defaultStart={dialog.defaultStart}
          defaultEnd={dialog.defaultEnd}
          onClose={() => { setDialog(null); setError(null); }}
          onAddSubmit={onAddSubmit}
          onEditSubmit={onEditSubmit}
          refreshAfterEdit={refresh}
        />
      )}
      {dialog?.kind === "edit" && (
        <BlockDialog
          mode={{ kind: "edit", block: dialog.block }}
          defaultStart={isoToLocalIST(dialog.block.startAt)}
          defaultEnd={isoToLocalIST(dialog.block.endAt)}
          onClose={() => { setDialog(null); setError(null); }}
          onAddSubmit={onAddSubmit}
          onEditSubmit={onEditSubmit}
          refreshAfterEdit={refresh}
        />
      )}
      {dialog?.kind === "leave" && (
        <LeaveDialog
          onClose={() => setDialog(null)}
          onSubmit={async (form) => {
            try { await addLeave(form); setDialog(null); await refresh(); }
            catch (e) { setError((e as Error).message); }
          }}
        />
      )}
    </div>
  );
}

// ── DialogState union ─────────────────────────────────────────────────────
type DialogState =
  | { kind: "create"; defaultStart: string; defaultEnd: string }
  | { kind: "edit"; block: TimeBlock }
  | { kind: "leave" };

// Extract the conflict shape from an ApiError thrown by post/patch. Returns
// null if this isn't an overlap.
function extractConflict(err: unknown): TimeBlockConflict | null {
  if (!(err instanceof ApiError)) return null;
  if (err.status !== 409) return null;
  const body = err.body as { conflict?: TimeBlockConflict } | undefined;
  return body?.conflict ?? null;
}

// ── BlockRow ──────────────────────────────────────────────────────────────
// Read-only by default. Every mutation goes through Edit (which opens the
// dialog) or Delete — the row never accepts inline changes on its own.
function BlockRow({
  block, onEdit, onDelete,
}: {
  block: TimeBlock;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const mins = durMins(block.startAt, block.endAt);
  return (
    <div className="grid items-center gap-3 px-5 py-3"
         style={{ gridTemplateColumns: "120px 1fr 160px" }}>
      <span className="font-mono text-[12.5px] tracking-tight text-ink">
        {timeIST(block.startAt)}–{timeIST(block.endAt)}
      </span>
      <span className={cn("truncate text-[12.5px]", block.note ? "text-ink2" : "text-hint")}>
        {block.note || "—"}
      </span>
      <div className="flex items-center justify-end gap-1.5 text-[11px]">
        <span className="font-mono text-mute">{fmtDur(mins)}</span>
        <button
          onClick={onEdit}
          className="rounded border border-rule px-2 py-0.5 text-[11px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
        >
          Edit
        </button>
        <button
          onClick={onDelete}
          className="rounded border border-rule px-1.5 py-0.5 text-mute hover:text-state-warn hover:border-state-warn"
          title="Delete"
        >×</button>
      </div>
    </div>
  );
}

// ── MonthBody — calendar-grid view ────────────────────────────────────────
function MonthBody({
  anchor, todayISO, blocksByDay, leavesByDay,
  noteQuery, onPickDay, onAddOnDay,
}: {
  anchor: string;
  todayISO: string;
  blocksByDay: Map<string, TimeBlock[]>;
  leavesByDay: Map<string, LeaveDay>;
  noteQuery: string;
  onPickDay: (iso: string) => void;
  onAddOnDay: (iso: string) => void;
}) {
  const dates = monthGrid(anchor);
  const monthIdx = new Date(`${anchor}T12:00:00Z`).getUTCMonth();

  function visibleBlocksOn(iso: string): TimeBlock[] {
    const all = blocksByDay.get(iso) ?? [];
    const q = noteQuery.trim().toLowerCase();
    if (!q) return all;
    return all.filter((b) => (b.note ?? "").toLowerCase().includes(q));
  }

  return (
    <div>
      <div className="grid grid-cols-7 border-b border-rule bg-warm">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="px-2 py-2 text-center mono-cap text-[9px] font-semibold tracking-[.12em] text-mute">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {dates.map((iso, i) => {
          const inMonth = new Date(`${iso}T12:00:00Z`).getUTCMonth() === monthIdx;
          const isToday = iso === todayISO;
          const dayBlocks = visibleBlocksOn(iso);
          const totalMins = dayBlocks.reduce((s, b) => s + durMins(b.startAt, b.endAt), 0);
          const leave = leavesByDay.get(iso);
          return (
            <div
              key={iso}
              className={cn(
                "group/cell relative min-h-[110px] border-b border-r border-rule p-1.5",
                !inMonth && "bg-warm/30",
                isToday && "bg-warm2",
                (i + 1) % 7 === 0 && "border-r-0",
                i >= 35 && "border-b-0",
              )}
            >
              <div className="mb-1 flex items-center justify-between">
                <button
                  onClick={() => onPickDay(iso)}
                  className={cn(
                    "rounded px-1 py-0.5 text-[12px] font-semibold transition hover:bg-warm",
                    isToday ? "text-brand-violet" : inMonth ? "text-ink" : "text-mute",
                  )}
                  title="Open day view"
                >
                  {new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", timeZone: "Asia/Kolkata" })}
                </button>
                <button
                  onClick={() => onAddOnDay(iso)}
                  className="rounded p-0.5 text-mute opacity-0 transition hover:text-brand-violet group-hover/cell:opacity-100"
                  title="Add block on this day"
                >
                  <Icon name="plus" size={12} strokeWidth={2.4} />
                </button>
              </div>
              {leave && (
                <div className={cn("mb-1 inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-semibold", LEAVE_TONES[leave.kind])}>
                  {LEAVE_LABEL[leave.kind]}
                </div>
              )}
              {totalMins > 0 && (
                <div className="font-mono text-[11.5px] font-semibold text-ink">{fmtDur(totalMins)}</div>
              )}
              <div className="space-y-0.5">
                {dayBlocks.slice(0, 3).map((b) => (
                  <button
                    key={b.id}
                    onClick={() => onPickDay(iso)}
                    title={`${timeIST(b.startAt)}–${timeIST(b.endAt)} ${b.note ?? ""}`}
                    className="block w-full truncate rounded bg-brand-violet/10 px-1.5 py-0.5 text-left text-[10px] font-semibold text-brand-violet"
                  >
                    {timeIST(b.startAt)} {b.note ?? ""}
                  </button>
                ))}
                {dayBlocks.length > 3 && (
                  <button onClick={() => onPickDay(iso)} className="text-[10px] font-semibold text-mute hover:text-brand-violet">
                    +{dayBlocks.length - 3} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── MiniCalendar (popover) ────────────────────────────────────────────────
function MiniCalendar({
  anchor, todayISO, blocksByDay, leavesByDay, onPick, onClose,
}: {
  anchor: string;
  todayISO: string;
  blocksByDay: Map<string, TimeBlock[]>;
  leavesByDay: Map<string, LeaveDay>;
  onPick: (iso: string) => void;
  onClose: () => void;
}) {
  const [shown, setShown] = useState<string>(anchor);
  const grid = monthGrid(shown);
  const monthIdx = new Date(`${shown}T12:00:00Z`).getUTCMonth();
  const monthLabel = new Date(`${shown}T12:00:00Z`).toLocaleDateString("en-IN", {
    month: "long", year: "numeric", timeZone: "Asia/Kolkata",
  });

  // Click-outside to close
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  function shiftMonth(dir: -1 | 1) {
    const d = new Date(`${shown}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + dir);
    setShown(d.toISOString().slice(0, 10));
  }

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-30 mt-1.5 w-[280px] rounded-2xl border border-rule bg-paper p-3 shadow-card"
      role="dialog"
    >
      <div className="mb-2 flex items-center gap-2">
        <button onClick={() => shiftMonth(-1)} className="rounded px-1.5 py-0.5 text-mute hover:bg-warm">‹</button>
        <div className="flex-1 text-center text-[12.5px] font-semibold text-ink">{monthLabel}</div>
        <button onClick={() => shiftMonth(1)} className="rounded px-1.5 py-0.5 text-mute hover:bg-warm">›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center mono-cap text-[8.5px] font-semibold tracking-[.1em] text-mute">
        {["M","T","W","T","F","S","S"].map((d, i) => <div key={i}>{d}</div>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {grid.map((iso) => {
          const inMonth = new Date(`${iso}T12:00:00Z`).getUTCMonth() === monthIdx;
          const isToday = iso === todayISO;
          const isSelected = iso === anchor;
          const has = (blocksByDay.get(iso) ?? []).length > 0;
          const leave = leavesByDay.get(iso);
          return (
            <button
              key={iso}
              onClick={() => onPick(iso)}
              className={cn(
                "relative rounded-md py-1.5 text-[12px] transition",
                isSelected
                  ? "bg-grad text-white shadow-glow"
                  : isToday
                  ? "bg-warm2 text-brand-violet font-bold"
                  : inMonth
                  ? "text-ink hover:bg-warm"
                  : "text-mute hover:bg-warm",
              )}
            >
              {new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", timeZone: "Asia/Kolkata" })}
              {(has || leave) && (
                <span
                  className={cn(
                    "absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full",
                    isSelected ? "bg-white" : leave ? "bg-state-warn" : "bg-brand-violet",
                  )}
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <button onClick={() => onPick(todayISO)} className="text-[11px] font-semibold text-brand-violet hover:underline">Today</button>
        <button onClick={onClose} className="text-[11px] font-semibold text-mute hover:text-ink">Close</button>
      </div>
    </div>
  );
}

// ── BlockDialog (create + edit + conflict resolution) ────────────────────
type BlockDialogMode =
  | { kind: "create" }
  | { kind: "edit"; block: TimeBlock };

function BlockDialog({
  mode, defaultStart, defaultEnd,
  onClose, onAddSubmit, onEditSubmit, refreshAfterEdit,
}: {
  mode: BlockDialogMode;
  defaultStart: string;
  defaultEnd: string;
  onClose: () => void;
  onAddSubmit: (form: { startAt: string; endAt: string; note: string | null }) =>
    Promise<{ ok: true } | { ok: false; conflict?: TimeBlockConflict; message?: string }>;
  onEditSubmit: (id: string, patch: { startAt?: string; endAt?: string; note?: string | null }) =>
    Promise<{ ok: true } | { ok: false; conflict?: TimeBlockConflict; message?: string }>;
  refreshAfterEdit: () => Promise<void>;
}) {
  const isEdit = mode.kind === "edit";
  const initialNote = isEdit ? (mode.block.note ?? "") : "";

  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultEnd);
  const [note, setNote] = useState(initialNote);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // When the dialog encounters a 409 we capture the conflicting block and
  // show an inline pane below the form. Resolve it (delete or shrink), then
  // we'll auto-retry the original submission.
  const [conflict, setConflict] = useState<TimeBlockConflict | null>(null);

  const ms = new Date(localISTToISO(end)).getTime() - new Date(localISTToISO(start)).getTime();
  const durLabel = ms > 0 ? fmtDur(Math.round(ms / 60_000)) : "—";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const startISO = localISTToISO(start);
    const endISO = localISTToISO(end);
    if (new Date(endISO) <= new Date(startISO)) { setErr("End must be after start."); return; }
    setBusy(true);
    const out = isEdit
      ? await onEditSubmit(mode.block.id, { startAt: startISO, endAt: endISO, note: note.trim() || null })
      : await onAddSubmit({ startAt: startISO, endAt: endISO, note: note.trim() || null });
    setBusy(false);
    if (!out.ok) {
      if (out.conflict) {
        setConflict(out.conflict);
        setErr(out.message ?? "Overlaps an existing block.");
      } else if (out.message) {
        setErr(out.message);
      }
    }
  }

  // Conflict-resolution outcomes — each retries the user's submission.
  async function onConflictResolved() {
    setConflict(null);
    await refreshAfterEdit();
    // Auto-retry by submitting the form fields directly.
    setErr(null);
    setBusy(true);
    const startISO = localISTToISO(start);
    const endISO = localISTToISO(end);
    const out = isEdit
      ? await onEditSubmit(mode.block.id, { startAt: startISO, endAt: endISO, note: note.trim() || null })
      : await onAddSubmit({ startAt: startISO, endAt: endISO, note: note.trim() || null });
    setBusy(false);
    if (!out.ok) {
      if (out.conflict) setConflict(out.conflict);
      if (out.message) setErr(out.message);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="my-12 w-full max-w-[520px] rounded-2xl border border-rule bg-paper p-6 shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="font-serif text-[24px] font-normal leading-tight">{isEdit ? "Edit time block" : "New time block"}</h2>
            <p className="mt-1 text-[12.5px] text-mute">{durLabel} · IST</p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink">✕</button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts">
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Ends">
              <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} />
            </Field>
          </div>
          <Field label="Note">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={cn(inputCls, "min-h-[60px] resize-y")}
              placeholder="What did you work on?"
            />
          </Field>

          {err && (
            <div className="rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">{err}</div>
          )}

          {conflict && (
            <ConflictPane
              conflict={conflict}
              onShrunkOrDeleted={onConflictResolved}
              onPatch={async (patch) => {
                const out = await onEditSubmit(conflict.id, patch);
                if (!out.ok && out.message) setErr(out.message);
                return out.ok;
              }}
              onDelete={async () => {
                try {
                  await deleteTimeBlock(conflict.id);
                  return true;
                } catch (e) {
                  setErr((e as Error).message);
                  return false;
                }
              }}
            />
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn">Cancel</button>
            <button
              type="submit"
              disabled={busy || conflict !== null}
              title={conflict ? "Resolve the conflict above first." : undefined}
              className="btn-grad disabled:opacity-60"
            >
              {busy ? "Saving…" : isEdit ? "Save changes" : "Add block"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── ConflictPane ─────────────────────────────────────────────────────────
// Inline editor for an existing block that's blocking a new save. The user
// can shrink or delete it; either action will refetch and auto-retry the
// outer dialog's submit.
function ConflictPane({
  conflict, onShrunkOrDeleted, onPatch, onDelete,
}: {
  conflict: TimeBlockConflict;
  onShrunkOrDeleted: () => void;
  onPatch: (patch: { startAt?: string; endAt?: string; note?: string | null }) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const [start, setStart] = useState(isoToLocalIST(conflict.startAt));
  const [end, setEnd] = useState(isoToLocalIST(conflict.endAt));
  const [note, setNote] = useState(conflict.note ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const ok = await onPatch({
      startAt: localISTToISO(start),
      endAt: localISTToISO(end),
      note: note.trim() || null,
    });
    setBusy(false);
    if (ok) onShrunkOrDeleted();
  }
  async function remove() {
    if (!confirm("Delete the conflicting block?")) return;
    setBusy(true);
    const ok = await onDelete();
    setBusy(false);
    if (ok) onShrunkOrDeleted();
  }

  return (
    <div className="rounded-[12px] border border-state-warn/40 bg-state-warn/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="mono-cap text-[9.5px] font-semibold tracking-[.12em] text-state-warn">
          Conflicts with this existing block
        </span>
        <span className="font-mono text-[11px] text-state-warn">
          {timeIST(conflict.startAt)}–{timeIST(conflict.endAt)}
        </span>
        {conflict.note && <span className="truncate text-[11px] text-mute">· {conflict.note}</span>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Starts">
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Ends">
          <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} />
        </Field>
      </div>
      <div className="mt-2">
        <Field label="Note">
          <input value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} placeholder="Note" />
        </Field>
      </div>
      <p className="mt-2 text-[11px] text-mute">
        Shorten or move this block so the new one fits — Save will retry your original change automatically.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={remove} disabled={busy} className="rounded-md border border-state-warn/40 bg-paper px-3 py-1 text-[11.5px] font-semibold text-state-warn hover:bg-state-warn/10 disabled:opacity-50">
          Delete this block
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-md bg-grad px-3 py-1 text-[11.5px] font-semibold text-white shadow-glow disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save & retry"}
        </button>
      </div>
    </div>
  );
}

// ── LeaveDialog ──────────────────────────────────────────────────────────
function LeaveDialog({
  onClose, onSubmit,
}: {
  onClose: () => void;
  onSubmit: (form: { date: string; kind: LeaveKind; halfDay: "full" | "am" | "pm"; note: string | null }) => Promise<void>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [kind, setKind] = useState<LeaveKind>("sick");
  const [halfDay, setHalfDay] = useState<"full" | "am" | "pm">("full");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="my-12 w-full max-w-[420px] rounded-2xl border border-rule bg-paper p-6 shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <h2 className="font-serif text-[24px] font-normal leading-tight">Mark leave</h2>
          <button onClick={onClose} className="text-mute hover:text-ink">✕</button>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true); setErr(null);
            try { await onSubmit({ date, kind, halfDay, note: note.trim() || null }); }
            catch (e2) { setErr((e2 as Error).message); }
            finally { setBusy(false); }
          }}
          className="space-y-3"
        >
          <Field label="Date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Type">
            <select value={kind} onChange={(e) => setKind(e.target.value as LeaveKind)} className={inputCls}>
              <option value="sick">Sick</option>
              <option value="personal">Personal</option>
              <option value="vacation">Vacation</option>
              <option value="wfh">WFH</option>
              <option value="holiday">Holiday</option>
            </select>
          </Field>
          <Field label="Half day">
            <select value={halfDay} onChange={(e) => setHalfDay(e.target.value as "full" | "am" | "pm")} className={inputCls}>
              <option value="full">Full day</option>
              <option value="am">First half (AM)</option>
              <option value="pm">Second half (PM)</option>
            </select>
          </Field>
          <Field label="Note">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} className={cn(inputCls, "min-h-[60px] resize-y")} placeholder="Optional" />
          </Field>
          {err && <div className="rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">{err}</div>}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn">Cancel</button>
            <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">{busy ? "Saving…" : "Mark leave"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputCls = "w-full rounded-[10px] border border-rule bg-paper px-3 py-2 text-[13px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20";

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mono-cap mb-1 block text-[10px] font-semibold tracking-[.12em] text-mute">
        {label}
        {required && <span className="ml-1 text-brand-magenta">*</span>}
      </span>
      {children}
    </label>
  );
}
