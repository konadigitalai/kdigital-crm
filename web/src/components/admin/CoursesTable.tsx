"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { createCourse, updateCourse } from "@/lib/api";
import type { Course } from "@/lib/types";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField } from "@/components/filter/types";
import { Pill, RegistryId, distinct } from "@/components/admin/formKit";

function buildFields(rows: Course[]): FilterField[] {
  const families = distinct(rows, (c) => c.family);
  return [
    { key: "name",             label: "Course",      type: "text",   get: (c: Course) => c.name },
    { key: "registryId",       label: "Registry ID", type: "text",   get: (c: Course) => c.registryId },
    { key: "shortCode",        label: "Code",        type: "text",   get: (c: Course) => c.shortCode },
    { key: "family",           label: "Family",      type: "enum",   options: families.map((f) => ({ value: f, label: f })), get: (c: Course) => c.family },
    { key: "description",      label: "Description", type: "text",   get: (c: Course) => c.description },
    { key: "enabled",          label: "Active",      type: "boolean",get: (c: Course) => c.enabled },
    // CAT-002 — whether completing this course carries credit into another
    // pathway. The single most useful thing to filter a 52-course registry by.
    { key: "reusable",         label: "Reusable",    type: "boolean",get: (c: Course) => c.reusableAcrossProgrammes },
    { key: "standalone",       label: "Standalone",  type: "boolean",get: (c: Course) => c.independentlyDeliverable },
    { key: "programCount",     label: "Programs",    type: "number", get: (c: Course) => c.programCount },
    { key: "batchCount",       label: "Batches",     type: "number", get: (c: Course) => c.batchCount },
    { key: "activeLearners",   label: "Active learners", type: "number", get: (c: Course) => c.activeLearners },
  ];
}

type Mode =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "editing"; course: Course };

export function CoursesTable({ initial }: { initial: Course[] }) {
  const router = useRouter();
  const [courses, setCourses] = useState<Course[]>(initial);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields = useMemo(() => buildFields(courses), [courses]);
  const [filtered, filterState, setFilterState] = useFilter(courses, fields);

  function reload() { router.refresh(); }

  async function onCreate(name: string, description: string | null) {
    setBusy("create"); setError(null);
    try {
      const created = await createCourse({ name, description });
      setCourses((all) => [...all, created].sort(sortCourses));
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onUpdate(c: Course, name: string, description: string | null) {
    setBusy(c.id); setError(null);
    try {
      const updated = await updateCourse(c.id, { name, description });
      setCourses((all) => all.map((x) => (x.id === c.id ? { ...x, ...updated } : x)).sort(sortCourses));
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
      setCourses((all) => all.map((x) => (x.id === c.id ? { ...x, ...updated } : x)).sort(sortCourses));
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
          {courses.length} course{courses.length === 1 ? "" : "s"} · {courses.filter((c) => c.enabled).length} active
        </div>
        <button onClick={() => setMode({ kind: "creating" })} className="btn-grad">
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
          <div>Family</div>
          <div className="text-center">Reuse</div>
          <div className="text-center">Programs</div>
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
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-semibold tracking-[-.005em]">{c.name}</span>
                  {c.shortCode && (
                    <span className="mono-cap rounded bg-grad-soft px-1.5 py-0.5 text-[9.5px] font-bold tracking-[.06em] text-brand-violet">
                      {c.shortCode}
                    </span>
                  )}
                  {!c.enabled && <Pill>inactive</Pill>}
                  {c.catalogueStatus === "Retired" && <Pill tone="bad">retired</Pill>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <RegistryId id={c.registryId} />
                  {/* CAT-015: the stable ID and the dated syllabus are
                      different things. Showing the pattern makes that visible
                      at the point someone would otherwise conflate them. */}
                  {c.curriculumVersionPattern && (
                    <span
                      className="font-mono text-[10.5px] text-hint"
                      title="Curriculum version pattern — a batch teaches a dated version of this stable course (CAT-015)"
                    >
                      {c.curriculumVersionPattern}
                    </span>
                  )}
                </div>
              </div>
              <div className="min-w-0 truncate text-[13px] text-ink2">
                {c.family ?? <span className="text-mute">—</span>}
              </div>
              <div className="flex items-center justify-center gap-1">
                {c.reusableAcrossProgrammes && (
                  <Pill tone="good" title="Completion can be credited into another pathway (CAT-002/003)">reusable</Pill>
                )}
                {c.independentlyDeliverable && (
                  <Pill tone="info" title="Can be sold and delivered on its own, outside any pathway">standalone</Pill>
                )}
                {!c.reusableAcrossProgrammes && !c.independentlyDeliverable && <span className="text-mute">—</span>}
              </div>
              <div className="text-center text-[13px]">{c.programCount > 0 ? c.programCount : <span className="text-mute">—</span>}</div>
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
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(name, description) => onCreate(name, description)}
          busy={busy === "create"}
        />
      )}
      {mode.kind === "editing" && (
        <CourseFormDialog
          title="Edit course"
          submitLabel="Save"
          initialName={mode.course.name}
          initialDescription={mode.course.description ?? ""}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(name, description) => onUpdate(mode.course, name, description)}
          busy={busy === mode.course.id}
        />
      )}
    </>
  );
}

function sortCourses(a: Course, b: Course) {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
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
      style={{ gridTemplateColumns: "2fr 1.1fr 190px 90px 90px 90px 100px 200px" }}
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
  title, submitLabel, initialName = "", initialDescription = "", onClose, onSubmit, busy,
}: {
  title: string; submitLabel: string;
  initialName?: string; initialDescription?: string;
  onClose: () => void;
  onSubmit: (name: string, description: string | null) => void;
  busy: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
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
            <p className="mt-1 text-[13px] text-mute">A course is a reusable module — programs pick it in their form.</p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            onSubmit(name.trim(), description.trim() || null);
          }}
          className="space-y-4"
        >
          <Field label="Course name" required>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="e.g. Python" autoFocus />
          </Field>
          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={cn(inputCls, "min-h-[100px] resize-y")}
              placeholder="One or two sentences on what this course covers."
            />
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
