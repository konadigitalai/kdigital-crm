"use client";

// Per-lead "Sync to Interakt" action. Pushes this one lead's phone number to
// Interakt (WhatsApp) and shows the outcome inline. The backend returns 400
// "Interakt is not configured…" when no key is set and 502 on an Interakt
// failure — both come through as the thrown error's message, so we surface it.

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { syncLeadToInterakt } from "@/lib/api";

export function SyncInteraktButton({ idOrNumber }: { idOrNumber: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const outcome = await syncLeadToInterakt(idOrNumber);
      if (outcome.status === "synced") {
        setOk(true);
        setResult("Synced ✓");
      } else if (outcome.status === "skipped") {
        setOk(false);
        setResult(`Skipped — ${outcome.reason}`);
      } else {
        setOk(false);
        setResult(`Failed — ${outcome.error}`);
      }
    } catch (err) {
      setOk(false);
      setResult(`Failed — ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex items-center gap-2.5">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-rule bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-ink2 transition hover:border-rule2 hover:text-ink",
          busy && "opacity-50",
        )}
      >
        <Icon name="chat" size={13} strokeWidth={2} />
        {busy ? "Syncing…" : "Sync to Interakt"}
      </button>
      {result && (
        <span className={cn("text-[11.5px] font-semibold", ok ? "text-state-ok" : "text-state-warn")}>
          {result}
        </span>
      )}
    </div>
  );
}
