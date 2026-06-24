"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { assignLearnerToBatch, getBatches } from "@/lib/api";
import type { Batch, BatchSlot } from "@/lib/types";

const SLOT_LABEL: Record<BatchSlot, string> = {
  morning:   "Morning",
  afternoon: "Afternoon",
  evening:   "Evening",
};

export function AssignBatchButton({
  partyId, courseId, courseName, alreadyEnrolledCohortIds, variant = "primary", label,
}: {
  partyId: string;
  courseId: string;
  courseName: string;
  alreadyEnrolledCohortIds: string[];
  variant?: "primary" | "ghost";
  label?: string;
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
        {label ?? "Assign batch"}
      </button>
      {open && (
        <Dialog
          partyId={partyId}
          courseId={courseId}
          courseName={courseName}
          alreadyEnrolledCohortIds={alreadyEnrolledCohortIds}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function Dialog({
  partyId, courseId, courseName, alreadyEnrolledCohortIds, onClose,
}: {
  partyId: string;
  courseId: string;
  courseName: string;
  alreadyEnrolledCohortIds: string[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [picked, setPicked]   = useState<string>("");
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    getBatches()
      .then((all) => {
        const enrolledSet = new Set(alreadyEnrolledCohortIds);
        const eligible = all.filter(
          (b) => b.enabled && !enrolledSet.has(b.id) &&
                 (b.status === "upcoming" || b.status === "running") &&
                 b.courseId === courseId,   // ← scope to the course we're assigning under
        );
        setBatches(eligible);
        if (eligible[0]) setPicked(eligible[0].id);
      })
      .catch((e) => setError((e as Error).message));
  }, [courseId, alreadyEnrolledCohortIds]);

  // (Scoped to a single course now — no need to group by program/course.)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await assignLearnerToBatch(partyId, picked);
      router.refresh();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="my-12 w-full max-w-[640px] rounded-2xl border border-rule bg-paper p-7 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[26px] font-normal leading-tight tracking-[-.01em]">
              Assign batch in {courseName}
            </h2>
            <p className="mt-1 text-[13px] leading-[1.5] text-mute">
              Pick the live or upcoming batch this learner will join for {courseName}.
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink"><Icon name="plus" size={18} strokeWidth={2} className="rotate-45" /></button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          {batches === null && <div className="text-[13px] text-mute">Loading batches…</div>}
          {batches !== null && batches.length === 0 && (
            <div className="rounded-lg border border-state-amber/30 bg-state-amber/10 p-3 text-[12.5px] text-state-amber">
              No additional active batches available.
            </div>
          )}

          {batches !== null && batches.length > 0 && (
            <div className="max-h-[420px] overflow-y-auto pr-1">
              <div className="flex flex-col gap-1.5">
                {batches.map((b) => (
                  <label
                    key={b.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-[10px] border p-2.5 transition",
                      picked === b.id ? "border-brand-violet bg-grad-soft" : "border-rule bg-paper hover:border-rule2",
                    )}
                  >
                    <input type="radio" name="batch" className="sr-only" checked={picked === b.id} onChange={() => setPicked(b.id)} />
                    <span className={cn("flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2", picked === b.id ? "border-brand-violet" : "border-rule2")}>
                      {picked === b.id && <span className="h-2 w-2 rounded-full bg-brand-violet" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold tracking-[-.005em]">{b.name}</div>
                      <div className="mono-cap mt-0.5 text-[9.5px] tracking-[.04em] text-mute">
                        {[
                          b.code,
                          b.slot ? SLOT_LABEL[b.slot] : null,
                          b.timeLabel,
                        ].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <span className={cn("mono-cap inline-flex items-center rounded-full px-2 py-0.5 text-[9.5px] font-semibold",
                      b.status === "running" ? "bg-[rgba(46,158,106,.10)] text-state-ok" : "bg-[rgba(31,63,207,.08)] text-brand-blue",
                    )}>
                      {b.status}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">{error}</div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn">Cancel</button>
            <button type="submit" disabled={busy || !picked} className="btn-grad disabled:opacity-60">
              {busy ? "Assigning…" : "Assign"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

