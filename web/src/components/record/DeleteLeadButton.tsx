"use client";

// Soft-delete a single lead from the record page header. Confirms first,
// then hits DELETE /leads/:number, then redirects back to /leads. The
// activity row + work_item are preserved server-side for audit; this just
// hides the lead from list/board/search.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { deleteLead } from "@/lib/api";
import { emitCrmMutation } from "@/lib/live-summary";

export function DeleteLeadButton({
  leadNumber,
  leadName,
}: {
  leadNumber: string;
  leadName: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function doDelete() {
    setBusy(true);
    setError(null);
    try {
      await deleteLead(leadNumber);
      emitCrmMutation("lead.deleted");
      setConfirmOpen(false);
      // Bounce back to the list — the deleted lead won't render there.
      startTransition(() => {
        router.replace("/leads");
        router.refresh();
      });
    } catch (err) {
      setError((err as Error).message);
      setConfirmOpen(false);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-[9px] border border-state-warn/40 bg-state-warn/5 px-3 py-1.5 text-[12.5px] font-semibold text-state-warn transition hover:border-state-warn hover:bg-state-warn/10 disabled:opacity-50"
      >
        <Icon name="info" size={12} strokeWidth={2.2} className="rotate-45" />
        {busy ? "Deleting…" : "Delete lead"}
      </button>
      {error && (
        <span className="mt-1 text-[11px] text-state-warn">{error}</span>
      )}
      <ConfirmDialog
        open={confirmOpen}
        title={`Delete lead ${leadNumber}?`}
        body={
          <>
            <p className="mb-1.5">
              <span className="font-semibold text-ink">{leadName}</span> will be hidden from the pipeline.
            </p>
            <p className="text-mute">
              Activity history is preserved — an admin can restore it later.
            </p>
          </>
        }
        confirmLabel="Delete lead"
        variant="danger"
        onConfirm={doDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
