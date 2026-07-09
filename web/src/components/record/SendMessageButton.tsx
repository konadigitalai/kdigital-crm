"use client";

// Quick-send modal for a lead. Header button on the record page.
// Channel toggle (SMS / WhatsApp), phone pre-filled from the lead, textarea, Send.
// Shares no state with the Inbox — this fires a one-off /twilio/send.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { sendTwMessageToLead } from "@/lib/api";
import type { TwChannel } from "@/lib/types";

export function SendMessageButton({
  leadNumber,
  leadPhone,
  className,
}: {
  leadNumber: string;
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
        <Icon name="message-square" size={12} strokeWidth={2.2} />
        Send message
      </button>
      {open && leadPhone && (
        <SendMessageDialog
          leadNumber={leadNumber}
          leadPhone={leadPhone}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function SendMessageDialog({
  leadNumber, leadPhone, onClose,
}: {
  leadNumber: string;
  leadPhone: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [channel, setChannel] = useState<TwChannel>("whatsapp");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | { channel: TwChannel; providerMessageId: string | null }>(null);

  async function submit() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await sendTwMessageToLead({ channel, to: leadNumber, body: text });
      if (!r.ok) {
        setError(r.errorMessage ?? `Send failed${r.errorCode ? ` (${r.errorCode})` : ""}`);
        return;
      }
      setDone({ channel, providerMessageId: r.providerMessageId });
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
        className="my-12 w-full max-w-[560px] rounded-2xl border border-rule bg-paper p-6 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[22px] font-normal leading-tight tracking-[-.01em]">Send message</h2>
            <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">
              To {leadPhone} · {leadNumber}
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>

        {done ? (
          <div className="rounded-[12px] border border-state-ok/30 bg-state-ok/10 p-4 text-center">
            <Icon name="check" size={20} strokeWidth={2.2} className="mx-auto mb-2 text-state-ok" />
            <div className="text-[14px] font-semibold text-ink">Message sent</div>
            <div className="mt-1 text-[12.5px] text-mute">
              via Twilio {done.channel === "whatsapp" ? "WhatsApp" : "SMS"}
              {done.providerMessageId ? ` · ${done.providerMessageId}` : ""}.
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
            <div className="mb-4 inline-flex rounded-full border border-rule bg-paper p-1 text-[12.5px]">
              <ChannelToggle active={channel === "whatsapp"} onClick={() => setChannel("whatsapp")}>WhatsApp</ChannelToggle>
              <ChannelToggle active={channel === "sms"}      onClick={() => setChannel("sms")}>SMS</ChannelToggle>
            </div>

            <textarea
              autoFocus
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder={channel === "whatsapp"
                ? "Hi — following up on your enquiry. Do you have 5 minutes for a quick call?"
                : "Hi — following up on your enquiry."}
              className="w-full resize-y rounded-[10px] border border-rule bg-warm/40 p-3 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
            />
            <p className="mono-cap mt-1 text-[10px] tracking-[.04em] text-hint">
              {channel === "whatsapp"
                ? "Freeform WhatsApp messages only work inside a 24h window from the customer's last reply. Outside that, Twilio returns error 63016 — templates arrive in a later version."
                : "Standard SMS. Character limits and cost per segment apply on the Twilio side."}
            </p>

            {error && (
              <div className="mt-3 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
                {error}
              </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-3 border-t border-rule pt-4">
              <button type="button" onClick={onClose} disabled={busy} className="btn">Cancel</button>
              <button
                type="button"
                onClick={submit}
                disabled={busy || !body.trim()}
                className="btn-grad disabled:opacity-60"
              >
                {busy ? "Sending…" : `Send ${channel === "whatsapp" ? "WhatsApp" : "SMS"}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ChannelToggle({
  active, onClick, children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-semibold transition",
        active ? "bg-ink text-white" : "text-ink2 hover:bg-warm",
      )}
    >
      {children}
    </button>
  );
}
