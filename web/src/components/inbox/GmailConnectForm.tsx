"use client";

// The connect step, with the visibility choice. Two checkboxes:
//   1. "Share these emails with everyone" — the actual setting (default ON).
//   2. An acknowledgement gate — Connect stays disabled until it's ticked, so
//      nobody shares (or privatises) their mailbox without seeing the choice.
// The share choice rides through the OAuth `state` and lands on gmail_account.is_shared.

import { useState } from "react";
import { getGmailAuthorizeUrl } from "@/lib/api";
import { cn } from "@/lib/cn";

export function GmailConnectForm({ compact = false }: { compact?: boolean }) {
  const [share, setShare] = useState(true);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    if (!ack) return;
    setBusy(true);
    setError(null);
    try {
      window.location.href = await getGmailAuthorizeUrl(window.location.href, share);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className={cn("flex flex-col gap-2.5", compact ? "text-[12px]" : "text-[13px]")}>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={share}
          onChange={(e) => setShare(e.target.checked)}
          className="mt-0.5 h-4 w-4 flex-shrink-0 accent-brand-violet"
        />
        <span>
          <span className="font-semibold text-ink">Share these emails with everyone</span>
          <span className="mt-0.5 block text-[11.5px] leading-snug text-mute">
            {share
              ? "Your teammates will be able to read this mailbox's conversations in the inbox."
              : "Only you will see this mailbox's conversations — it stays private."}
          </span>
        </span>
      </label>

      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          className="mt-0.5 h-4 w-4 flex-shrink-0 accent-brand-violet"
        />
        <span className="text-[11.5px] leading-snug text-ink2">
          I understand who will be able to see this mailbox&apos;s email.
        </span>
      </label>

      {error && (
        <div className="rounded-md border border-state-warn/30 bg-state-warn/10 px-2.5 py-1.5 text-[11.5px] text-state-warn">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={() => void connect()}
        disabled={busy || !ack}
        className="self-start rounded-md bg-brand-blue px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-brand-blue/90 disabled:cursor-not-allowed disabled:opacity-50"
        title={ack ? undefined : "Tick the box above to continue"}
      >
        {busy ? "Opening…" : "Connect Gmail"}
      </button>
    </div>
  );
}
