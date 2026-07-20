"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { enrollLead } from "@/lib/api";

// Step 1 of the enrollment workflow: lead → enrolled. Fees + payment
// verification are handled on the enrollment record afterwards, so this button
// collects nothing beyond the program (which comes from the lead itself). If
// no program is set the button is disabled with an inline hint. On success we
// route to the new enrollment record page.
export function EnrollButton({ leadNumber, programId }: {
  leadNumber: string; programId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enroll() {
    if (!programId || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await enrollLead(leadNumber, { programId });
      router.push(`/enrollments/${result.enrolmentId}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const disabled = !programId || busy;
  const title = !programId
    ? "Set a program on this lead before enrolling"
    : busy
      ? "Enrolling…"
      : "Enroll this lead";

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={enroll}
        disabled={disabled}
        title={title}
        className="btn-grad disabled:opacity-50"
      >
        <Icon name="check" size={14} strokeWidth={2.2} />
        {busy ? "Enrolling…" : "Enroll"}
      </button>
      {error && (
        <div className="max-w-[280px] rounded-md border border-state-warn/30 bg-state-warn/10 px-2 py-1 text-[11px] text-state-warn">
          {error}
        </div>
      )}
    </div>
  );
}
