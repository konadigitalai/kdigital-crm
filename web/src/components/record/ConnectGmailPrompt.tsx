"use client";

// "Connect Gmail" call-to-action. Shown wherever we'd let someone send an email
// but neither they nor the org has a connected mailbox.
//
// Redirects the whole window (not a popup) to Google's consent screen. The API
// bakes the current URL into the signed OAuth state as `returnTo`, so Google
// bounces the user right back to the page they left, with ?gmailConnected=1.

import { Icon } from "@/components/ui/Icon";
import { GmailConnectForm } from "@/components/inbox/GmailConnectForm";
import type { GmailStatus } from "@/lib/types";

export function ConnectGmailPrompt({
  status,
}: {
  status: GmailStatus | null;
  /** Kept for call-site compatibility; the connect flow redirects the whole
   *  window, so there's nothing to call back into here. */
  onChanged?: () => void;
}) {
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

  return (
    <div className="rounded-[10px] border border-rule bg-warm/40 px-3 py-3">
      <div className="flex items-start gap-2.5">
        <Icon name="mail" size={15} strokeWidth={2} className="mt-[2px] flex-shrink-0 text-brand-blue" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink">Connect your Gmail to send email</div>
          <p className="mt-0.5 mb-2.5 text-[12px] leading-[1.45] text-mute">
            Email will send from your own work address, and replies will show up
            both here and in your normal Gmail inbox.
          </p>
          <GmailConnectForm />
        </div>
      </div>
    </div>
  );
}
