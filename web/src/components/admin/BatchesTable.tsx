"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { createBatch, updateBatch } from "@/lib/api";
import type { Batch, BatchSlot, BatchStatus, Course, WeekDay } from "@/lib/types";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField } from "@/components/filter/types";
import { TrainerPicker } from "@/components/admin/TrainerPicker";

interface StaffMember { id: string; name: string; email: string; role: string }
const WEEKDAYS: { code: WeekDay; label: string }[] = [
  { code: "mon", label: "Mon" },
  { code: "tue", label: "Tue" },
  { code: "wed", label: "Wed" },
  { code: "thu", label: "Thu" },
  { code: "fri", label: "Fri" },
  { code: "sat", label: "Sat" },
  { code: "sun", label: "Sun" },
];

const STATUSES: BatchStatus[] = ["upcoming", "running", "completed", "cancelled"];
const STATUS_CLS: Record<BatchStatus, string> = {
  upcoming:  "bg-[rgba(31,63,207,.08)]  text-brand-blue",
  running:   "bg-[rgba(46,158,106,.10)] text-state-ok",
  completed: "bg-warm2                  text-mute",
  cancelled: "bg-[rgba(217,83,79,.10)]  text-state-warn",
};
const SLOTS: BatchSlot[] = ["morning", "afternoon", "evening"];

function buildFields(rows: Batch[]): FilterField[] {
  const programs = [...new Set(rows.map((r) => r.programName).filter(Boolean))] as string[];
  const courses  = [...new Set(rows.map((r) => r.courseName ).filter(Boolean))] as string[];
  return [
    { key: "name",    label: "Batch name", type: "text",   get: (b: Batch) => b.name },
    { key: "code",    label: "Code",       type: "text",   get: (b: Batch) => b.code },
    { key: "program", label: "Program",    type: "enum",   options: programs.map((p) => ({ value: p, label: p })), get: (b: Batch) => b.programName },
    { key: "course",  label: "Course",     type: "enum",   options: courses.map((c) => ({ value: c, label: c })),  get: (b: Batch) => b.courseName },
    { key: "slot",    label: "Slot",       type: "enum",
      options: SLOTS.map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) })),
      get: (b: Batch) => b.slot,
    },
    { key: "status",  label: "Status",     type: "enum",
      options: STATUSES.map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1), cls: STATUS_CLS[s] })),
      get: (b: Batch) => b.status,
    },
    { key: "enabled",        label: "Active",            type: "boolean", get: (b: Batch) => b.enabled },
    { key: "activeCount",    label: "Active enrolments", type: "number",  get: (b: Batch) => b.activeCount },
    { key: "enrolmentCount", label: "Total enrolments",  type: "number",  get: (b: Batch) => b.enrolmentCount },
    { key: "seats",          label: "Seats",             type: "number",  get: (b: Batch) => b.seats },
  ];
}

type Mode =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "editing"; batch: Batch };

export function BatchesTable({ initial, courses, staff }: { initial: Batch[]; courses: Course[]; staff: StaffMember[] }) {
  const router = useRouter();
  const [batches, setBatches] = useState<Batch[]>(initial);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields = useMemo(() => buildFields(batches), [batches]);
  const [filtered, filterState, setFilterState] = useFilter(batches, fields);

  function reload() { router.refresh(); }

  async function onCreate(input: BatchFormValues) {
    setBusy("create"); setError(null);
    try {
      const created = await createBatch(input);
      const c = courses.find((c) => c.id === input.courseId);
      setBatches((all) => [
        ...all,
        {
          ...created,
          courseName: c?.name ?? null,
          courseCode: c?.code ?? null,
          courseEnabled: c?.enabled ?? null,
          programId: c?.programId ?? null,
          programName: c?.programName ?? null,
          programEnabled: c?.programEnabled ?? null,
          enrolmentCount: 0,
          activeCount: 0,
        },
      ].sort(sortBatches));
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onUpdate(b: Batch, input: BatchFormValues) {
    setBusy(b.id); setError(null);
    try {
      const updated = await updateBatch(b.id, input);
      setBatches((all) =>
        all.map((x) => (x.id === b.id ? { ...x, ...updated } : x)).sort(sortBatches)
      );
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onToggleEnabled(b: Batch) {
    setBusy(b.id); setError(null);
    try {
      const updated = await updateBatch(b.id, { enabled: !b.enabled });
      setBatches((all) =>
        all.map((x) => (x.id === b.id ? { ...x, ...updated } : x)).sort(sortBatches)
      );
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[13px] text-mute">
          {batches.length} batch{batches.length === 1 ? "" : "es"} ·{" "}
          {batches.filter((b) => b.enabled).length} active
        </div>
        <button
          onClick={() => courses.length > 0 && setMode({ kind: "creating" })}
          disabled={courses.length === 0}
          title={courses.length === 0 ? "Create a course first" : ""}
          className="btn-grad disabled:opacity-50"
        >
          <Icon name="plus" size={14} strokeWidth={2.2} /> New batch
        </button>
      </div>

      <div className="mb-4 rounded-[14px] border border-rule bg-paper p-3">
        <FilterBar
          fields={fields}
          state={filterState}
          onChange={setFilterState}
          placeholder="Filter batches by field…"
          totalRows={batches.length}
          filteredRows={filtered.length}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <Row hdr>
          <div>Batch</div>
          <div>Course / Program</div>
          <div>Slot</div>
          <div>Status</div>
          <div className="text-center">Active</div>
          <div className="text-center">Enrolled</div>
          <div className="text-right">Actions</div>
        </Row>

        {filtered.length === 0 ? (
          <div className="px-[22px] py-10 text-center text-[13px] text-mute">
            {batches.length === 0 ? "No batches yet." : "No batches match the current filter."}
          </div>
        ) : (
          filtered.map((b) => (
            <Row key={b.id} dimmed={!b.enabled}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold tracking-[-.005em]">{b.name}</span>
                  {!b.enabled && <span className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[9px] font-semibold text-mute">inactive</span>}
                </div>
                <div className="mono-cap mt-0.5 text-[9.5px] tracking-[.04em] text-mute">
                  {[b.code, b.timeLabel, fmtDate(b.startDate)].filter(Boolean).join(" · ") || "—"}
                </div>
                {b.trainerName && (
                  <div className="mt-0.5 text-[11px] text-ink2">
                    {b.trainerName}
                    {b.coTrainerName && <span className="ml-1 rounded-full bg-warm2 px-1.5 py-0.5 text-[9px] font-semibold text-mute">+{b.coTrainerName}</span>}
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium text-ink2">{b.courseName ?? "—"}</div>
                <div className="mono-cap mt-0.5 truncate text-[9.5px] tracking-[.04em] text-mute">{b.programName ?? ""}</div>
              </div>
              <div className="text-[12.5px] capitalize text-ink2">{b.slot ?? "—"}</div>
              <div>
                <span className={cn("mono-cap inline-flex items-center rounded-full px-2 py-0.5 text-[9.5px] font-semibold", STATUS_CLS[b.status])}>
                  {b.status}
                </span>
              </div>
              <div className="text-center text-[13px]">{b.activeCount > 0 ? b.activeCount : <span className="text-mute">—</span>}</div>
              <div className="text-center text-[13px]">{b.enrolmentCount > 0 ? b.enrolmentCount : <span className="text-mute">—</span>}</div>
              <div className="flex items-center justify-end gap-1.5">
                <button
                  onClick={() => setMode({ kind: "editing", batch: b })}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
                >
                  Edit
                </button>
                <ToggleSwitch enabled={b.enabled} busy={busy === b.id} onClick={() => onToggleEnabled(b)} />
              </div>
            </Row>
          ))
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
          {error}
        </div>
      )}

      {mode.kind === "creating" && (
        <BatchFormDialog
          title="New batch"
          submitLabel="Create"
          courses={courses}
          staff={staff}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(v) => onCreate(v)}
          busy={busy === "create"}
        />
      )}
      {mode.kind === "editing" && (
        <BatchFormDialog
          title="Edit batch"
          submitLabel="Save"
          courses={courses}
          staff={staff}
          initial={mode.batch}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(v) => onUpdate(mode.batch, v)}
          busy={busy === mode.batch.id}
        />
      )}
    </>
  );
}

function fmtDate(d: string | null): string | null {
  if (!d) return null;
  return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function sortBatches(a: Batch, b: Batch) {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  const ap = (a.programName ?? "");
  const bp = (b.programName ?? "");
  if (ap !== bp) return ap.localeCompare(bp);
  const ac = (a.courseName ?? "");
  const bc = (b.courseName ?? "");
  if (ac !== bc) return ac.localeCompare(bc);
  if ((a.startDate ?? "") !== (b.startDate ?? "")) return (a.startDate ?? "").localeCompare(b.startDate ?? "");
  return a.name.localeCompare(b.name);
}

function ToggleSwitch({ enabled, busy, onClick }: { enabled: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={enabled ? "Click to deactivate" : "Click to reactivate"}
      className={cn(
        "relative h-[22px] w-[40px] flex-shrink-0 rounded-full transition disabled:opacity-50",
        enabled ? "bg-grad" : "bg-rule2",
      )}
    >
      <span className={cn("absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all", enabled ? "left-[20px]" : "left-0.5")} />
    </button>
  );
}

function Row({ hdr = false, dimmed = false, children }: { hdr?: boolean; dimmed?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid items-center gap-4 px-[22px] border-b border-rule last:border-b-0 transition",
        hdr ? "mono-cap py-3 text-[9.5px] font-semibold tracking-[.12em] text-mute bg-warm" : "py-3.5",
        dimmed && !hdr && "bg-warm/40",
      )}
      style={{ gridTemplateColumns: "2fr 2fr 90px 100px 80px 90px 200px" }}
    >
      {children}
    </div>
  );
}

interface BatchFormValues {
  courseId: string;
  name: string;
  code: string | null;
  slot: BatchSlot | null;
  startDate: string | null;
  endDate: string | null;
  seats: number | null;
  status: BatchStatus;
  trainerId: string | null;
  coTrainerId: string | null;
  daysOfWeek: WeekDay[];
  startTime: string | null;
  endTime: string | null;
}

function BatchFormDialog({
  title, submitLabel, courses, staff, initial, onClose, onSubmit, busy,
}: {
  title: string; submitLabel: string;
  courses: Course[];
  staff: StaffMember[];
  initial?: Batch;
  onClose: () => void;
  onSubmit: (v: BatchFormValues) => void;
  busy: boolean;
}) {
  const [courseId, setCourseId] = useState<string>(initial?.courseId ?? courses[0]?.id ?? "");
  const [name,      setName]      = useState(initial?.name ?? "");
  const [code,      setCode]      = useState(initial?.code ?? "");
  const [slot,      setSlot]      = useState<BatchSlot | "">(initial?.slot ?? "");
  const [startDate, setStart]     = useState(initial?.startDate?.slice(0, 10) ?? "");
  const [endDate,   setEnd]       = useState(initial?.endDate?.slice(0, 10) ?? "");
  const [seats,     setSeats]     = useState(initial?.seats != null ? String(initial.seats) : "");
  const [status,    setStatus]    = useState<BatchStatus>(initial?.status ?? "upcoming");
  const [trainerId,    setTrainerId]    = useState<string | null>(initial?.trainerId    ?? null);
  const [coTrainerId,  setCoTrainerId]  = useState<string | null>(initial?.coTrainerId  ?? null);
  const [daysOfWeek,   setDaysOfWeek]   = useState<WeekDay[]>(initial?.daysOfWeek ?? []);
  const [startTime,    setStartTime]    = useState(initial?.startTime ?? "");
  const [endTime,      setEndTime]      = useState(initial?.endTime ?? "");
  const [formError,    setFormError]    = useState<string | null>(null);

  function toggleDay(d: WeekDay) {
    setDaysOfWeek((cur) => cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Panel is height-bounded; header + footer stay pinned, the form
          body becomes the only scrollable region. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setFormError(null);
          if (!name.trim() || !courseId) return;
          // Mirror the API's cross-field validation so the user gets feedback fast.
          if (trainerId && coTrainerId && trainerId === coTrainerId) {
            setFormError("Trainer and co-trainer must be different people.");
            return;
          }
          if (daysOfWeek.length > 0 && (!startTime || !endTime)) {
            setFormError("Pick start time and end time when days are selected.");
            return;
          }
          if (startTime && endTime && endTime <= startTime) {
            setFormError("End time must be after start time.");
            return;
          }
          onSubmit({
            courseId,
            name: name.trim(),
            code: code.trim() || null,
            slot: (slot || null) as BatchSlot | null,
            startDate: startDate || null,
            endDate: endDate || null,
            seats: seats !== "" ? Number(seats) : null,
            status,
            trainerId,
            coTrainerId,
            daysOfWeek,
            startTime: startTime || null,
            endTime:   endTime   || null,
          });
        }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[calc(100vh-3rem)] w-full max-w-[640px] flex-col rounded-2xl border border-rule bg-paper shadow-card"
      >
        <div className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-rule p-7 pb-5">
          <div>
            <h2 className="font-serif text-[26px] font-normal leading-tight tracking-[-.01em]">{title}</h2>
            <p className="mt-1 text-[13px] text-mute">A batch is a time-fenced run of one course. Active batches with a trainer + days + time auto-populate the trainer's calendar.</p>
          </div>
          <button type="button" onClick={onClose} className="text-mute hover:text-ink"><Icon name="plus" size={18} strokeWidth={2} className="rotate-45" /></button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-7">
          <Field label="Course" required>
            <select className={inputCls} value={courseId} onChange={(e) => setCourseId(e.target.value)} disabled={!!initial}>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>{c.programName} → {c.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Batch name" required>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Python · Jul-2026 · Morning" autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Code">
              <input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} placeholder="PY-Jul-2026-M" />
            </Field>
            <Field label="Slot">
              <select className={inputCls} value={slot} onChange={(e) => setSlot(e.target.value as BatchSlot | "")}>
                <option value="">— none —</option>
                {SLOTS.map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}
              </select>
            </Field>
          </div>

          {/* ── Phase H: structured trainer + cadence ─────────────────── */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Trainer">
              <TrainerPicker
                people={staff}
                value={trainerId}
                onChange={setTrainerId}
                excludeId={coTrainerId}
                placeholder="— pick a trainer —"
              />
            </Field>
            <Field label="Co-trainer">
              <TrainerPicker
                people={staff}
                value={coTrainerId}
                onChange={setCoTrainerId}
                excludeId={trainerId}
                placeholder="— optional —"
              />
            </Field>
          </div>

          <Field label="Days of the week">
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((d) => {
                const on = daysOfWeek.includes(d.code);
                return (
                  <button
                    type="button"
                    key={d.code}
                    onClick={() => toggleDay(d.code)}
                    className={cn(
                      "rounded-full px-3 py-1.5 text-[12px] font-semibold transition",
                      on
                        ? "border border-transparent bg-ink text-white"
                        : "border border-rule bg-paper text-ink2 hover:border-rule2",
                    )}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Start time">
              <input className={inputCls} type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </Field>
            <Field label="End time">
              <input className={inputCls} type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Start date">
              <input className={inputCls} type="date" value={startDate} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="Tentative end date">
              <input className={inputCls} type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
          <Field label="Seats">
            <input className={inputCls} type="number" min={0} value={seats} onChange={(e) => setSeats(e.target.value)} placeholder="30" />
          </Field>
          <Field label="Status">
            <div className="flex flex-wrap gap-2">
              {STATUSES.map((s) => (
                <button
                  type="button" key={s}
                  onClick={() => setStatus(s)}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-[12px] font-semibold capitalize transition",
                    status === s ? "border border-transparent bg-ink text-white" : "border border-rule bg-paper text-ink2 hover:border-rule2",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </Field>

        </div>

        <div className="flex flex-shrink-0 flex-col gap-3 border-t border-rule p-5">
          {formError && (
            <div className="rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">{formError}</div>
          )}
          <div className="flex items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="btn">Cancel</button>
            <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">
              {busy ? "Saving…" : submitLabel}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

const inputCls = "w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20 disabled:bg-warm";

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">
        {label}{required && <span className="ml-1 text-brand-magenta">*</span>}
      </span>
      {children}
    </label>
  );
}
