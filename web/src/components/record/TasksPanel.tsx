"use client";

// The record page's "Activities" tab — the *write* side of the lead-task model.
// Everything scheduled here shows up in Leads > Calendar; this panel is where
// those rows are born, completed, and deleted.

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { createLeadTask, deleteLeadTask, getLeadTasks, updateLeadTask } from "@/lib/api";
import type { LeadTask, LeadTaskKind } from "@/lib/types";
import { LEAD_TASK_KINDS } from "@/lib/types";
import { fmtFollowup, taskKindStyles } from "@/lib/ui";

export function TasksPanel({ leadNumber, canWrite }: { leadNumber: string; canWrite: boolean }) {
  const [tasks, setTasks] = useState<LeadTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getLeadTasks({ lead: leadNumber })
      .then((rows) => { if (alive) { setTasks(rows); setLoadError(null); } })
      .catch((err) => { if (alive) setLoadError((err as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [leadNumber]);

  // Complete / delete are optimistic: the advisor is ticking off a list and a
  // round-trip per row makes it feel broken. On failure we put the row back.
  const complete = useCallback(async (task: LeadTask) => {
    const before = tasks;
    setRowError(null);
    setTasks((rows) =>
      rows.map((r) => (r.id === task.id ? { ...r, status: "done", completedAt: new Date().toISOString() } : r)),
    );
    try {
      const updated = await updateLeadTask(task.id, { status: "done" });
      setTasks((rows) => rows.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      setTasks(before);
      setRowError((err as Error).message);
    }
  }, [tasks]);

  const remove = useCallback(async (task: LeadTask) => {
    const before = tasks;
    setRowError(null);
    setTasks((rows) => rows.filter((r) => r.id !== task.id));
    try {
      await deleteLeadTask(task.id);
    } catch (err) {
      setTasks(before);
      setRowError((err as Error).message);
    }
  }, [tasks]);

  const upcoming = tasks
    .filter((t) => t.status === "open")
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const done = tasks.filter((t) => t.status !== "open");

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-serif text-[19px] leading-tight tracking-[-.01em] text-ink">Activities</h3>
        {canWrite && (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="btn-primary px-3 py-1.5 text-[12.5px]"
          >
            <Icon name="plus" size={13} strokeWidth={2.4} />
            Schedule
          </button>
        )}
      </div>

      {rowError && (
        <div className="mb-3 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
          {rowError}
        </div>
      )}
      {loadError && (
        <div className="mb-3 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
          {loadError}
        </div>
      )}

      {loading ? (
        <div className="rounded-2xl border border-dashed border-rule p-8 text-center text-[12.5px] text-mute">
          Loading…
        </div>
      ) : upcoming.length === 0 && done.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-rule p-8 text-center">
          <p className="text-[12.5px] text-mute">Nothing scheduled.</p>
          {canWrite && (
            <button type="button" onClick={() => setDialogOpen(true)} className="btn-primary px-3 py-1.5 text-[12.5px]">
              <Icon name="plus" size={13} strokeWidth={2.4} />
              Schedule
            </button>
          )}
        </div>
      ) : (
        <>
          {upcoming.length > 0 && (
            <div className="flex flex-col gap-2">
              {upcoming.map((t) => (
                <TaskRow key={t.id} task={t} canWrite={canWrite} onComplete={complete} onDelete={remove} />
              ))}
            </div>
          )}

          {upcoming.length === 0 && (
            <div className="rounded-2xl border border-dashed border-rule p-6 text-center text-[12.5px] text-mute">
              Nothing scheduled.
            </div>
          )}

          {done.length > 0 && (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => setShowDone((v) => !v)}
                className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute hover:text-ink2"
              >
                {showDone ? "Hide" : "Show"} {done.length} completed
              </button>
              {showDone && (
                <div className="mt-2 flex flex-col gap-2">
                  {done.map((t) => (
                    <TaskRow key={t.id} task={t} canWrite={canWrite} onComplete={complete} onDelete={remove} />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {dialogOpen && (
        <ScheduleDialog
          leadNumber={leadNumber}
          onClose={() => setDialogOpen(false)}
          onCreated={(task) => {
            setTasks((rows) => [task, ...rows]);
            setDialogOpen(false);
          }}
        />
      )}
    </>
  );
}

function TaskRow({
  task, canWrite, onComplete, onDelete,
}: {
  task: LeadTask;
  canWrite: boolean;
  onComplete: (t: LeadTask) => void;
  onDelete: (t: LeadTask) => void;
}) {
  const s = taskKindStyles[task.kind];
  const open = task.status === "open";
  // fmtFollowup is already IST-pinned and already flags overdue ("Overdue · 3 Jul")
  // and today — re-deriving either here would drift from the leads grid.
  const when = fmtFollowup(task.dueAt);
  const overdue = open && when.urgent && when.label.startsWith("Overdue");

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-[12px] border border-rule bg-paper px-3.5 py-2.5",
        !open && "opacity-60",
      )}
    >
      <span className={cn("h-[7px] w-[7px] flex-shrink-0 rounded-full", s.dot)} />
      <span className={cn("mono-cap flex-shrink-0 rounded-full px-2 py-[3px] text-[9px] font-semibold tracking-[.06em]", s.bg, s.text)}>
        {s.label}
      </span>

      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-[13px] font-semibold text-ink", !open && "line-through")}>
          {task.title}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-mute">
          <span
            className={cn(
              overdue ? "font-semibold text-state-warn"
              : when.urgent ? "font-semibold text-state-amber"
              : when.muted ? "text-hint"
              : "text-ink2",
            )}
          >
            {task.allDay && !overdue ? when.label.replace(/,.*$/, "") : when.label}
          </span>
          {task.assigneeName && (
            <>
              <span className="text-hint">·</span>
              <span className="text-[11px] text-mute">{task.assigneeName}</span>
            </>
          )}
        </div>
        {task.notes && (
          <p className="mt-1 whitespace-pre-line text-[12px] leading-[1.45] text-ink2">{task.notes}</p>
        )}
      </div>

      {canWrite && (
        <div className="flex flex-shrink-0 items-center gap-1">
          {open && (
            <button
              type="button"
              onClick={() => onComplete(task)}
              className="grid h-6 w-6 place-items-center rounded-md border border-rule text-mute transition hover:border-state-ok hover:text-state-ok"
              aria-label={`Mark "${task.title}" done`}
              title="Mark done"
            >
              <Icon name="check" size={12} strokeWidth={2.4} />
            </button>
          )}
          <button
            type="button"
            onClick={() => onDelete(task)}
            className="grid h-6 w-6 place-items-center rounded-md text-hint transition hover:text-state-warn"
            aria-label={`Delete "${task.title}"`}
            title="Delete"
          >
            <Icon name="plus" size={13} strokeWidth={2.2} className="rotate-45" />
          </button>
        </div>
      )}
    </div>
  );
}

function ScheduleDialog({
  leadNumber, onClose, onCreated,
}: {
  leadNumber: string;
  onClose: () => void;
  onCreated: (task: LeadTask) => void;
}) {
  const [kind, setKind] = useState<LeadTaskKind>("follow_up");
  const [title, setTitle] = useState(taskKindStyles.follow_up.label);
  const [date, setDate] = useState(todayInIst);
  const [time, setTime] = useState("10:00");
  const [allDay, setAllDay] = useState(false);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The title is prefilled from the kind so the common case is one click, but
  // once the advisor has typed their own we must not clobber it.
  const titleTouched = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function pickKind(k: LeadTaskKind) {
    setKind(k);
    if (!titleTouched.current) setTitle(taskKindStyles[k].label);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setError("Title is required"); return; }
    if (!date) { setError("Pick a date"); return; }

    // The user types a wall-clock time and means it in IST — everyone here is
    // in India — but the column is timestamptz, so it must go over the wire as
    // a UTC instant. Stamping the offset explicitly (rather than letting
    // `new Date("2026-07-14T10:00")` guess the runtime zone) keeps the stored
    // instant correct no matter where the browser thinks it is. All-day rows
    // land on IST midnight, which is the convention the calendar reads back.
    const wall = allDay ? "00:00" : time || "00:00";
    const due = new Date(`${date}T${wall}:00+05:30`);
    if (Number.isNaN(due.getTime())) { setError("That date/time isn't valid"); return; }

    setSubmitting(true);
    setError(null);
    try {
      const task = await createLeadTask({
        lead: leadNumber,
        kind,
        title: title.trim(),
        notes: notes.trim() || null,
        dueAt: due.toISOString(),
        allDay,
      });
      onCreated(task);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}
    >
      <div className="flex w-full max-w-[520px] max-h-[calc(100vh-3rem)] flex-col rounded-2xl border border-rule bg-paper shadow-card">
        <div className="flex-none border-b border-rule px-6 pt-5 pb-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-serif text-[24px] font-normal leading-tight tracking-[-.01em]">Schedule activity</h2>
              <p className="mt-1 text-[12.5px] text-mute">It'll show up on this lead and in Leads → Calendar.</p>
            </div>
            <button type="button" onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
              <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
            </button>
          </div>
        </div>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <Field label="Kind">
              <div className="flex flex-wrap gap-2">
                {LEAD_TASK_KINDS.map((k) => {
                  const s = taskKindStyles[k];
                  const on = kind === k;
                  return (
                    <button
                      type="button" key={k}
                      onClick={() => pickKind(k)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition",
                        on
                          ? cn(s.bg, s.text, "ring-2 ring-offset-1 ring-offset-paper", s.text.replace("text-", "ring-"))
                          : "border border-rule bg-paper text-mute hover:border-rule2",
                      )}
                    >
                      <span className={cn("h-1.5 w-1.5 rounded-full", on ? s.dot : "bg-rule2")} />
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Title" required>
              <input
                className={inputCls}
                value={title}
                onChange={(e) => { titleTouched.current = true; setTitle(e.target.value); }}
                placeholder="Call back about the fee structure"
                autoFocus
              />
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Date" required>
                <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label="Time">
                <input
                  type="time"
                  className={cn(inputCls, allDay && "opacity-50")}
                  value={time}
                  disabled={allDay}
                  onChange={(e) => setTime(e.target.value)}
                />
              </Field>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink2">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => setAllDay(e.target.checked)}
                className="h-3.5 w-3.5 accent-brand-violet"
              />
              All day
            </label>

            <Field label="Notes">
              <textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="What needs to happen, and anything the next person should know…"
                className={cn(inputCls, "min-h-[70px] resize-y leading-[1.45]")}
              />
            </Field>
          </div>

          <div className="flex-none border-t border-rule px-6 py-4">
            {error && (
              <div className="mb-3 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
                {error}
              </div>
            )}
            <div className="flex items-center justify-end gap-3">
              <button type="button" onClick={onClose} className="btn">Cancel</button>
              <button type="submit" disabled={submitting} className="btn-primary disabled:opacity-60">
                {submitting ? "Scheduling…" : "Schedule"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputCls = "w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20";

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

/** The date input defaults to *today in IST*, not today in the runtime's zone —
 *  a browser sitting in UTC would otherwise pre-select yesterday for anyone
 *  scheduling before 05:30 IST. en-CA gives the "YYYY-MM-DD" the input wants. */
function todayInIst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
