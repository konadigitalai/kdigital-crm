"use client";

// "Connect Gmail" call-to-action. Shown wherever we'd let someone send an email
// but neither they nor the org has a connected mailbox.
//
// Redirects the whole window (not a popup) to Google's consent screen. The API
// bakes the current URL into the signed OAuth state as `returnTo`, so Google
// bounces the user right back to the page they left, with ?gmailConnected=1.

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { getGmailAuthorizeUrl } from "@/lib/api";
import type { GmailStatus } from "@/lib/types";

export function ConnectGmailPrompt({
  status,
  onChanged,
}: {
  status: GmailStatus | null;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The API has no Google credentials at all — connecting can't work yet, and
  // telling the user to click a button that 503s would be worse than saying so.
  if (status && !status.configured) {
    return (
      <div className="rounded-[10px] border border-dashed border-rule bg-warm/40 px-3 py-2.5 text-[12px] text-mute">
        Gmail isn&apos;t configured on this server yet. An admin needs to set the
        Google OAuth credentials before email can be sent or received.
      </div>
    );
  }

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const url = await getGmailAuthorizeUrl(window.location.href);
      window.location.href = url;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[10px] border border-rule bg-warm/40 px-3 py-3">
      <div className="flex items-start gap-2.5">
        <Icon name="mail" size={15} strokeWidth={2} className="mt-[2px] flex-shrink-0 text-brand-blue" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink">Connect your Gmail to send email</div>
          <p className="mt-0.5 text-[12px] leading-[1.45] text-mute">
            Email will send from your own work address, and replies will show up
            both here and in your normal Gmail inbox.
          </p>
          {error && (
            <div className="mt-2 rounded-md border border-state-warn/30 bg-state-warn/10 px-2.5 py-1.5 text-[11.5px] text-state-warn">
              {error}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void connect()}
          disabled={busy}
          className="flex-shrink-0 rounded-md bg-brand-blue px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-brand-blue/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Opening…" : "Connect Gmail"}
        </button>
      </div>
      {onChanged && status?.connected && (
        <div className="mt-2 border-t border-rule pt-2 text-[11px] text-mute">
          Connected as {status.account?.email}
        </div>
      )}
    </div>
  );
}
