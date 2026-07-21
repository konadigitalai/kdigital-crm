"use client";

// Generates planned batch_session rows from the batch's schedule + date range.
// Idempotent on the server — running it again only fills in gaps, so the result
// is either "+N sessions" or "Up to date". A batch with no schedule / start
// date fails server-side (400); we surface that message inline rather than
// swallow it.

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { materializeSessions } from "@/lib/api";

export function MaterializeSessionsButton({
  batchId, onDone, disabled,
}: {
  batchId: string;
  onDone: () => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const n = await materializeSessions(batchId);
      setResult(n > 0 ? `+${n} session${n === 1 ? "" : "s"}` : "Up to date");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2.5">
      <button
        type="button"
        onClick={run}
        disabled={busy || disabled}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-rule bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-ink2 transition hover:border-rule2 hover:text-ink",
          (busy || disabled) && "opacity-50",
        )}
      >
        <Icon name="calendar" size={13} strokeWidth={2} />
        {busy ? "Materializing…" : "Materialize sessions"}
      </button>
      {error ? (
        <span className="text-[11.5px] text-state-warn">{error}</span>
      ) : result ? (
        <span className="text-[11.5px] font-semibold text-state-ok">{result}</span>
      ) : null}
    </div>
  );
}
