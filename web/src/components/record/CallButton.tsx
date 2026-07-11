"use client";

// Click-to-call button — mirrors SendMessageButton's shape. Opens a small
// confirm dialog before firing /exotel/call, so an accidental click doesn't
// dial anyone. On success the toast says "Ringing your phone now — pick up
// to connect" because that's exactly what Exotel does — the advisor's
// phone rings first, they pick up, THEN Exotel bridges the customer.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { initiateExotelCall } from "@/lib/api";

export function CallButton({
  leadNumber,
  leadPhone,
  className,
}: {
  /** LEAD-XXXX identifier. Passed to /exotel/call as the `to` param — the
   *  server resolves the party's phone from the lead. Also accepts a raw
   *  E.164 if you're calling from a context that doesn't have a lead. */
  leadNumber: string;
  /** Display-only — the phone we'll be dialing, shown in the confirm modal.
   *  If null, the button is disabled (no target to call). */
  leadPhone: string | null | undefined;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!leadPhone}
        title={leadPhone ? "" : "No phone number on this lead"}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-[9px] border border-rule bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-ink2 transition",
          leadPhone
            ? "hover:border-brand-violet hover:text-brand-violet"
            : "cursor-not-allowed opacity-50",
          className,
        )}
      >
        <Icon name="phone" size={12} strokeWidth={2.2} />
        Call
      </button>
      {open && leadPhone && (
        <ConfirmCallDialog
          leadNumber={leadNumber}
          leadPhone={leadPhone}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ConfirmCallDialog({
  leadNumber, leadPhone, onClose,
}: {
  leadNumber: string;
  leadPhone: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | { callSid: string | null; usingFallback: boolean }>(null);

  async function fire() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await initiateExotelCall(leadNumber);
      if (!r.exotelOk) {
        setError(r.errorMessage ?? `Call failed${r.errorCode ? ` (${r.errorCode})` : ""}`);
        return;
      }
      setDone({ callSid: r.callSid, usingFallback: r.usingFallback });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="my-16 w-full max-w-[440px] rounded-2xl border border-rule bg-paper p-6 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[22px] font-normal leading-tight tracking-[-.01em]">
              Call this lead
            </h2>
            <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">
              {leadPhone} · {leadNumber}
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>

        {done ? (
          <div className="rounded-[12px] border border-state-ok/30 bg-state-ok/10 p-4 text-center">
            <Icon name="check" size={20} strokeWidth={2.2} className="mx-auto mb-2 text-state-ok" />
            <div className="text-[14px] font-semibold text-ink">Ringing your phone now</div>
            <div className="mt-1 text-[12.5px] text-mute">
              Pick up and Exotel will bridge {leadPhone}.
              {done.usingFallback && (
                <> Routing through the team call desk (your Advisor profile has no phone set).</>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="mt-4 rounded-md border border-rule bg-paper px-4 py-1.5 text-[12.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="rounded-[10px] border border-rule bg-warm/40 p-3 text-[13px] text-ink2">
              <p>
                Exotel will call <b>you</b> first. Pick up your phone, then it will connect{" "}
                <b>{leadPhone}</b>. The call is recorded and lands on this lead&apos;s timeline.
              </p>
            </div>

            {error && (
              <div className="mt-3 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
                {error}
              </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-3 border-t border-rule pt-4">
              <button type="button" onClick={onClose} disabled={busy} className="btn">Cancel</button>
              <button
                type="button"
                onClick={fire}
                disabled={busy}
                className="btn-grad disabled:opacity-60"
              >
                {busy ? "Dialing…" : "Start call"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
