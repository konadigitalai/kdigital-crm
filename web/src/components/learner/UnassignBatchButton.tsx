"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { unassignLearnerBatch } from "@/lib/api";

// Removes a learner from a single batch (cohort). Leaves the parent
// course assignment alone — use UnassignCourseButton for that.
export function UnassignBatchButton({
  partyId,
  assignmentId,
  cohortName,
}: {
  partyId: string;
  assignmentId: string;
  cohortName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doRemove() {
    setError(null);
    try {
      await unassignLearnerBatch(partyId, assignmentId);
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
        aria-label={`Unassign ${cohortName}`}
        title="Unassign batch"
        className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-rule bg-paper text-mute transition hover:border-state-warn/60 hover:bg-state-warn/5 hover:text-state-warn"
      >
        <Icon name="plus" size={11} strokeWidth={2.4} className="rotate-45" />
      </button>
      <ConfirmDialog
        open={open}
        title={`Unassign ${cohortName}?`}
        body={
          <>
            <p className="mb-1.5">The learner will be removed from this batch.</p>
            <p className="text-mute">The course assignment stays in place — only this cohort enrolment is dropped.</p>
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
