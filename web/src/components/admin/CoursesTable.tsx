"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { createCourse, updateCourse } from "@/lib/api";
import type { Course, Program } from "@/lib/types";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField } from "@/components/filter/types";

function buildFields(rows: Course[]): FilterField[] {
  const programs = [...new Set(rows.map((r) => r.programName))];
  return [
    { key: "name",       label: "Course",   type: "text", get: (c: Course) => c.name },
    { key: "code",       label: "Code",     type: "text", get: (c: Course) => c.code },
    { key: "program",    label: "Program",  type: "enum", options: programs.map((p) => ({ value: p, label: p })), get: (c: Course) => c.programName },
    { key: "enabled",    label: "Active",   type: "boolean", get: (c: Course) => c.enabled },
    { key: "batchCount", label: "Batches",  type: "number", get: (c: Course) => c.batchCount },
    { key: "activeLearners", label: "Active learners", type: "number", get: (c: Course) => c.activeLearners },
  ];
}

type Mode =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "editing"; course: Course };

export function CoursesTable({ initial, programs }: { initial: Course[]; programs: Program[] }) {
  const router = useRouter();
  const [courses, setCourses] = useState<Course[]>(initial);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields = useMemo(() => buildFields(courses), [courses]);
  const [filtered, filterState, setFilterState] = useFilter(courses, fields);

  function reload() { router.refresh(); }

  async function onCreate(programId: string, name: string, code: string | null) {
    setBusy("create"); setError(null);
    try {
      const created = await createCourse({ programId, name, code });
      const programName = programs.find((p) => p.id === programId)?.name ?? "—";
      setCourses((all) => [
        ...all,
        { ...created, programName, programEnabled: true, batchCount: 0, runningBatchCount: 0, activeLearners: 0 },
      ].sort(sortCourses));
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onUpdate(c: Course, name: string, code: string | null) {
    setBusy(c.id); setError(null);
    try {
      const updated = await updateCourse(c.id, { name, code });
      setCourses((all) =>
        all.map((x) => (x.id === c.id ? { ...x, ...updated } : x)).sort(sortCourses)
      );
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onToggle(c: Course) {
    setBusy(c.id); setError(null);
    try {
      const updated = await updateCourse(c.id, { enabled: !c.enabled });
      setCourses((all) =>
        all.map((x) => (x.id === c.id ? { ...x, ...updated } : x)).sort(sortCourses)
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
          {courses.length} course{courses.length === 1 ? "" : "s"} ·{" "}
          {courses.filter((c) => c.enabled).length} active
        </div>
        <button
          onClick={() => programs.length > 0 && setMode({ kind: "creating" })}
          disabled={programs.length === 0}
          title={programs.length === 0 ? "Create a program first" : ""}
          className="btn-grad disabled:opacity-50"
        >
          <Icon name="plus" size={14} strokeWidth={2.2} /> New course
        </button>
      </div>

      <div className="mb-4 rounded-[14px] border border-rule bg-paper p-3">
        <FilterBar
          fields={fields}
          state={filterState}
          onChange={setFilterState}
          placeholder="Filter courses by field…"
          totalRows={courses.length}
          filteredRows={filtered.length}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <Row hdr>
          <div>Course</div>
          <div>Program</div>
          <div className="text-center">Batches</div>
          <div className="text-center">Running</div>
          <div className="text-center">Learners</div>
          <div className="text-right">Actions</div>
        </Row>
        {filtered.length === 0 ? (
          <div className="px-[22px] py-10 text-center text-[13px] text-mute">
            {courses.length === 0 ? "No courses yet." : "No courses match the current filter."}
          </div>
        ) : (
          filtered.map((c) => (
            <Row key={c.id} dimmed={!c.enabled}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold tracking-[-.005em]">{c.name}</span>
                  {!c.enabled && (
                    <span className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[9px] font-semibold text-mute">inactive</span>
                  )}
                </div>
                {c.code && <div className="mono-cap mt-0.5 text-[9.5px] tracking-[.04em] text-mute">{c.code}</div>}
              </div>
              <div className="text-[13px] text-ink2 truncate">{c.programName}</div>
              <div className="text-center text-[13px]">{c.batchCount > 0 ? c.batchCount : <span className="text-mute">—</span>}</div>
              <div className="text-center text-[13px]">{c.runningBatchCount > 0 ? c.runningBatchCount : <span className="text-mute">—</span>}</div>
              <div className="text-center text-[13px]">{c.activeLearners > 0 ? c.activeLearners : <span className="text-mute">—</span>}</div>
              <div className="flex items-center justify-end gap-1.5">
                <button
                  onClick={() => setMode({ kind: "editing", course: c })}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
                >
                  Edit
                </button>
                <ToggleSwitch enabled={c.enabled} busy={busy === c.id} onClick={() => onToggle(c)} />
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
        <CourseFormDialog
          title="New course"
          submitLabel="Create"
          programs={programs}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(progId, name, code) => onCreate(progId, name, code)}
          busy={busy === "create"}
        />
      )}
      {mode.kind === "editing" && (
        <CourseFormDialog
          title="Edit course"
          submitLabel="Save"
          programs={programs}
          initial={mode.course}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(_progId, name, code) => onUpdate(mode.course, name, code)}
          busy={busy === mode.course.id}
        />
      )}
    </>
  );
}

function sortCourses(a: Course, b: Course) {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  if (a.programName !== b.programName) return a.programName.localeCompare(b.programName);
  return a.name.localeCompare(b.name);
}

function Row({ hdr = false, dimmed = false, children }: { hdr?: boolean; dimmed?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid items-center gap-4 px-[22px] border-b border-rule last:border-b-0 transition",
        hdr ? "mono-cap py-3 text-[9.5px] font-semibold tracking-[.12em] text-mute bg-warm" : "py-3.5",
        dimmed && !hdr && "bg-warm/40",
      )}
      style={{ gridTemplateColumns: "2fr 1.6fr 90px 90px 100px 200px" }}
    >
      {children}
    </div>
  );
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

function CourseFormDialog({
  title, submitLabel, programs, initial, onClose, onSubmit, busy,
}: {
  title: string; submitLabel: string;
  programs: Program[];
  initial?: Course;
  onClose: () => void;
  onSubmit: (programId: string, name: string, code: string | null) => void;
  busy: boolean;
}) {
  const [programId, setProgramId] = useState(initial?.programId ?? programs[0]?.id ?? "");
  const [name, setName]           = useState(initial?.name ?? "");
  const [code, setCode]           = useState(initial?.code ?? "");
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="my-12 w-full max-w-[560px] rounded-2xl border border-rule bg-paper p-7 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[26px] font-normal leading-tight tracking-[-.01em]">{title}</h2>
            <p className="mt-1 text-[13px] text-mute">A course is a named module inside a program.</p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink"><Icon name="plus" size={18} strokeWidth={2} className="rotate-45" /></button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !programId) return;
            onSubmit(programId, name.trim(), code.trim() || null);
          }}
          className="space-y-4"
        >
          <Field label="Program" required>
            <select value={programId} onChange={(e) => setProgramId(e.target.value)} className={inputCls} disabled={!!initial}>
              {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Course name" required>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="e.g. Python" autoFocus />
          </Field>
          <Field label="Code">
            <input value={code} onChange={(e) => setCode(e.target.value)} className={inputCls} placeholder="e.g. AIDS-PY" />
          </Field>
          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn">Cancel</button>
            <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">
              {busy ? "Saving…" : submitLabel}
            </button>
          </div>
        </form>
      </div>
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
