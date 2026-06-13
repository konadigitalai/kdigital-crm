"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { rescoreLead, runOutreachDraft } from "@/lib/api";

// Two header-rail buttons that invoke real Claude-backed agents on this lead.
//   - Draft outreach → creates an approval row, refresh shows ApprovalCard.
//   - Re-score       → updates score / heat / signals in-place.
export function AgentActions({
  leadNumber,
  hasPendingApproval,
}: {
  leadNumber: string;
  hasPendingApproval: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"draft" | "score" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onDraft() {
    if (hasPendingApproval) return;
    setBusy("draft");
    setError(null);
    try {
      await runOutreachDraft(leadNumber);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onRescore() {
    setBusy("score");
    setError(null);
    try {
      await rescoreLead(leadNumber);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={onDraft}
        disabled={busy !== null || hasPendingApproval}
        title={hasPendingApproval ? "A draft is already awaiting approval" : "Have the Outreach Agent draft a follow-up"}
        className="btn disabled:opacity-50"
      >
        <Icon name="spark" size={14} strokeWidth={2} />
        {busy === "draft" ? "Drafting…" : "Draft outreach"}
      </button>
      <button
        type="button"
        onClick={onRescore}
        disabled={busy !== null}
        title="Re-score this lead with the Lead Scoring Agent"
        className="btn disabled:opacity-50"
      >
        <Icon name="star" size={14} strokeWidth={2} />
        {busy === "score" ? "Scoring…" : "Re-score"}
      </button>
      {error && (
        <span className="ml-2 max-w-[260px] truncate text-[11px] text-state-warn" title={error}>
          {error}
        </span>
      )}
    </>
  );
}
