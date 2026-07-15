"use client";

// Compact Gmail-connection control for the inbox Email tab. Shows which mailbox
// the user has connected and lets them disconnect. After disconnecting, their
// email vanishes from the inbox (the API scopes email to the user's own
// mailbox) until they connect an account again — which may be a different one.

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { disconnectGmail } from "@/lib/api";
import { cn } from "@/lib/cn";
import { GmailConnectForm } from "./GmailConnectForm";
import type { GmailStatus } from "@/lib/types";

export function GmailAccountControl({
  status,
  onChanged,
}: {
  status: GmailStatus | null;
  /** Called after connect/disconnect so the parent reloads status + the list. */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!status || !status.configured) return null;

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await disconnectGmail();
      setConfirming(false);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const connected = status.connected && status.account;

  return (
    <div className="border-b border-rule bg-warm/40 px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon name="mail" size={13} strokeWidth={2} className="flex-shrink-0 text-brand-blue" />
        {connected ? (
          <>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="truncate text-[12px] font-semibold text-ink" title={status.account!.email}>
                {status.account!.email}
              </span>
              <span
                className={cn(
                  "mono-cap flex-shrink-0 rounded-full px-1.5 py-0.5 text-[8.5px] font-semibold tracking-[.06em]",
                  status.account!.isShared
                    ? "bg-brand-violet/12 text-brand-violet"
                    : "bg-warm2 text-mute",
                )}
                title={status.account!.isShared
                  ? "Everyone in the workspace can see this mailbox's email"
                  : "Only you can see this mailbox's email"}
              >
                {status.account!.isShared ? "Shared" : "Private"}
              </span>
            </span>
            {confirming ? (
              <span className="flex flex-shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void disconnect()}
                  disabled={busy}
                  className="rounded-md bg-state-warn px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-state-warn/90 disabled:opacity-50"
                >
                  {busy ? "…" : "Disconnect"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded-md px-2 py-1 text-[11px] font-semibold text-mute hover:text-ink"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="flex-shrink-0 rounded-md border border-rule bg-paper px-2.5 py-1 text-[11px] font-semibold text-ink2 transition hover:border-state-warn/50 hover:text-state-warn"
              >
                Disconnect
              </button>
            )}
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-[12px] text-mute">
              No mailbox connected
            </span>
            <button
              type="button"
              onClick={() => setConnecting((v) => !v)}
              className="flex-shrink-0 rounded-md bg-brand-blue px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-brand-blue/90"
            >
              {connecting ? "Cancel" : "Connect Gmail"}
            </button>
          </>
        )}
      </div>
      {!connected && connecting && (
        <div className="mt-2 rounded-md border border-rule bg-paper p-2.5">
          <GmailConnectForm compact />
        </div>
      )}
      {confirming && (
        <div className="mt-1.5 text-[10.5px] leading-snug text-mute">
          You&apos;ll stop seeing this mailbox&apos;s email here until you reconnect it.
        </div>
      )}
      {error && (
        <div className={cn("mt-1.5 rounded-md border border-state-warn/30 bg-state-warn/10 px-2 py-1 text-[11px] text-state-warn")}>
          {error}
        </div>
      )}
    </div>
  );
}
