"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { decideApproval } from "@/lib/api";

export function InlineApproveButtons({ approvalId }: { approvalId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    setBusy(decision);
    setError(null);
    try {
      await decideApproval(approvalId, decision);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2 flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => decide("approve")}
        disabled={busy !== null}
        className="rounded-md border-0 bg-grad px-2.5 py-1 text-[11px] font-semibold text-white shadow-glow disabled:opacity-60"
      >
        {busy === "approve" ? "Sending…" : "Approve & send"}
      </button>
      <button
        type="button"
        onClick={() => decide("reject")}
        disabled={busy !== null}
        className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11px] font-semibold text-ink2 hover:border-state-warn hover:text-state-warn disabled:opacity-50"
      >
        {busy === "reject" ? "Rejecting…" : "Reject"}
      </button>
      {error && (
        <span className="ml-1.5 truncate text-[10.5px] text-state-warn" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
