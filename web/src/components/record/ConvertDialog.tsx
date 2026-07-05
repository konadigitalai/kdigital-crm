"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { convertLead } from "@/lib/api";

// One-click conversion. Fees (paid / due / etc.) are managed manually on the
// learner record after conversion — this button no longer collects any of
// them. Program comes from the lead itself; if none is set, the button is
// disabled with an inline hint so the advisor sets one on the lead first.
export function ConvertButton({ leadNumber, leadName, programId }: {
  leadNumber: string; leadName: string; programId: string | null;
}) {
  void leadName;
  const router = useRouter();
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function convert() {
    if (!programId || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await convertLead(leadNumber, { programId });
      router.push(`/learners/${result.partyId}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const disabled = !programId || busy;
  const title = !programId
    ? "Set a program on this lead before converting"
    : busy
      ? "Converting…"
      : "Convert to learner";

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={convert}
        disabled={disabled}
        title={title}
        className="btn-grad disabled:opacity-50"
      >
        <Icon name="check" size={14} strokeWidth={2.2} />
        {busy ? "Converting…" : "Convert to learner"}
      </button>
      {error && (
        <div className="max-w-[280px] rounded-md border border-state-warn/30 bg-state-warn/10 px-2 py-1 text-[11px] text-state-warn">
          {error}
        </div>
      )}
    </div>
  );
}
