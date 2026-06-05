"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { assignLearnerCourses, getCourses } from "@/lib/api";
import type { Course } from "@/lib/types";

export function AddCourseButton({
  partyId, alreadyAssignedCourseIds, label, variant = "primary",
}: {
  partyId: string;
  alreadyAssignedCourseIds: string[];
  label?: string;
  variant?: "primary" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn(
          variant === "primary"
            ? "btn-grad"
            : "rounded-[10px] border border-dashed border-rule2 bg-transparent px-3 py-1.5 text-[12px] font-semibold text-mute hover:border-brand-violet hover:text-brand-violet",
        )}
      >
        {variant === "primary" && <Icon name="plus" size={14} strokeWidth={2.2} />}
        {label ?? "Add courses"}
      </button>
      {open && (
        <Dialog
          partyId={partyId}
          alreadyAssignedCourseIds={alreadyAssignedCourseIds}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function Dialog({
  partyId, alreadyAssignedCourseIds, onClose,
}: {
  partyId: string;
  alreadyAssignedCourseIds: string[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [picked, setPicked]   = useState<Set<string>>(new Set());
  const [filter, setFilter]   = useState("");
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    getCourses()
      .then((all) => {
        const assigned = new Set(alreadyAssignedCourseIds);
        // Show every active course (and active program tag if attached) — no
        // program filter. User picks freely.
        const eligible = all.filter((c) => c.enabled && !assigned.has(c.id));
        setCourses(eligible);
      })
      .catch((e) => setError((e as Error).message));
  }, [alreadyAssignedCourseIds]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Group courses by program for visual orientation; "Standalone" group at the
  // bottom for courses without a program tag.
  const grouped = useMemo(() => {
    if (!courses) return null;
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? courses.filter((c) =>
          c.name.toLowerCase().includes(q) ||
          (c.code ?? "").toLowerCase().includes(q) ||
          (c.programName ?? "").toLowerCase().includes(q),
        )
      : courses;
    const m = new Map<string, Course[]>();
    for (const c of filtered) {
      const key = c.programName ?? "— Unattached —";
      const arr = m.get(key) ?? [];
      arr.push(c);
      m.set(key, arr);
    }
    return m;
  }, [courses, filter]);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll(courses: Course[]) {
    setPicked((prev) => {
      const next = new Set(prev);
      const allOn = courses.every((c) => next.has(c.id));
      if (allOn) {
        for (const c of courses) next.delete(c.id);
      } else {
        for (const c of courses) next.add(c.id);
      }
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (picked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await assignLearnerCourses(partyId, [...picked]);
      if (result.added > 0) {
        router.refresh();
        onClose();
      } else {
        // None added — show a concise summary
        const reasons = result.outcomes.filter((o) => !o.ok).map((o) => (o as { error: string }).error);
        setError(`No courses were added. ${[...new Set(reasons)].join(" · ")}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="my-12 w-full max-w-[640px] rounded-2xl border border-rule bg-paper p-7 shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[26px] font-normal leading-tight tracking-[-.01em]">Add courses</h2>
            <p className="mt-1 text-[13px] leading-[1.5] text-mute">
              Pick one or more courses this learner will take. Batches (morning, evening, etc.) are assigned per-course after this.
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          {/* Search */}
          <div className="flex items-center gap-2 rounded-full border border-rule bg-warm/50 px-3 py-2 text-[13px] text-ink2 focus-within:border-brand-violet">
            <Icon name="search" size={13} strokeWidth={2} className="text-mute" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by course, code, or program…"
              className="w-full bg-transparent outline-none placeholder:text-hint"
            />
          </div>

          {courses === null && <div className="text-[13px] text-mute">Loading courses…</div>}
          {courses !== null && courses.length === 0 && (
            <div className="rounded-lg border border-state-amber/30 bg-state-amber/10 p-3 text-[12.5px] text-state-amber">
              All active courses are already assigned to this learner.
            </div>
          )}

          {grouped && courses !== null && courses.length > 0 && (
            <div className="max-h-[400px] overflow-y-auto pr-1">
              {[...grouped.entries()].length === 0 ? (
                <div className="rounded-lg border border-rule p-3 text-center text-[12.5px] text-mute">
                  No courses match "{filter}".
                </div>
              ) : (
                [...grouped.entries()].map(([groupName, items]) => (
                  <CourseGroup
                    key={groupName}
                    name={groupName}
                    courses={items}
                    pickedIds={picked}
                    onToggle={toggle}
                    onToggleAll={() => selectAll(items)}
                  />
                ))
              )}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">{error}</div>
          )}

          <div className="flex items-center justify-between gap-3 pt-2">
            <div className="text-[12px] text-mute">
              {picked.size === 0 ? "No courses selected" : `${picked.size} course${picked.size === 1 ? "" : "s"} selected`}
            </div>
            <div className="flex items-center gap-3">
              <button type="button" onClick={onClose} className="btn">Cancel</button>
              <button type="submit" disabled={busy || picked.size === 0} className="btn-grad disabled:opacity-60">
                {busy
                  ? "Adding…"
                  : picked.size <= 1
                    ? "Add course"
                    : `Add ${picked.size} courses`}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function CourseGroup({
  name, courses, pickedIds, onToggle, onToggleAll,
}: {
  name: string;
  courses: Course[];
  pickedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}) {
  const allOn = courses.every((c) => pickedIds.has(c.id));
  const someOn = courses.some((c) => pickedIds.has(c.id));
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-2 flex items-center justify-between">
        <div className="mono-cap text-[10px] font-semibold tracking-[.14em] text-brand-violet">{name}</div>
        <button
          type="button"
          onClick={onToggleAll}
          className="text-[10.5px] font-semibold text-brand-violet hover:underline"
        >
          {allOn ? "Deselect all" : someOn ? "Select all" : "Select all"}
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {courses.map((c) => {
          const checked = pickedIds.has(c.id);
          return (
            <label
              key={c.id}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-[10px] border p-2.5 transition",
                checked ? "border-brand-violet bg-grad-soft" : "border-rule bg-paper hover:border-rule2",
              )}
            >
              <input type="checkbox" className="sr-only" checked={checked} onChange={() => onToggle(c.id)} />
              <span
                className={cn(
                  "flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[4px] border-2 transition",
                  checked ? "border-brand-violet bg-brand-violet" : "border-rule2",
                )}
              >
                {checked && <Icon name="check" size={11} strokeWidth={3} className="text-white" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold tracking-[-.005em]">{c.name}</div>
                <div className="mono-cap mt-0.5 text-[9.5px] tracking-[.04em] text-mute">
                  {c.code ? `${c.code} · ` : ""}
                  {c.batchCount} batch{c.batchCount === 1 ? "" : "es"}, {c.runningBatchCount} running
                </div>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}
