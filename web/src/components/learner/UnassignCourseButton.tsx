"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { unassignLearnerCourse } from "@/lib/api";

// Hard-removes a course assignment from a learner. Cascade-deletes any
// batches under it server-side, so the confirm dialog calls that out when
// batches are present.
export function UnassignCourseButton({
  partyId,
  courseAssignmentId,
  courseName,
  batchCount,
}: {
  partyId: string;
  courseAssignmentId: string;
  courseName: string;
  batchCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doRemove() {
    setError(null);
    try {
      await unassignLearnerCourse(partyId, courseAssignmentId);
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Unassign ${courseName}`}
        title="Unassign course"
        className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-rule bg-paper text-mute transition hover:border-state-warn/60 hover:bg-state-warn/5 hover:text-state-warn"
      >
        <Icon name="plus" size={11} strokeWidth={2.4} className="rotate-45" />
      </button>
      <ConfirmDialog
        open={open}
        title={`Unassign ${courseName}?`}
        body={
          <>
            <p className="mb-1.5">This removes the course from the learner.</p>
            {batchCount > 0 && (
              <p className="text-state-warn">
                {batchCount} batch{batchCount === 1 ? "" : "es"} under this course will also be removed.
              </p>
            )}
            {error && (
              <p className="mt-2 rounded-md border border-state-warn/30 bg-state-warn/10 px-2 py-1 text-[12px] text-state-warn">
                {error}
              </p>
            )}
          </>
        }
        confirmLabel="Unassign"
        variant="danger"
        onConfirm={doRemove}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
