"use client";

// Compose an email to an address that has no thread — and possibly no CRM
// record — yet. The inbox's other surfaces all start from an existing thread or
// a lead, so this is the only way to cold-email someone new.
//
// The API resolves `to` for us: an unknown address gets a stub party and an
// unlinked conversation you can later promote to a lead, exactly like an
// inbound WhatsApp from an unknown number does. So there is nothing to create
// up front — we just send.

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { sendEmail } from "@/lib/api";

const inputCls =
  "w-full rounded-[10px] border border-rule bg-warm/40 px-3 py-2 text-[13.5px] text-ink placeholder:text-hint outline-none focus:border-brand-blue";

export function ComposeEmailDialog({
  senderEmail,
  defaultTo = "",
  onClose,
  onSent,
}: {
  /** The mailbox this will send from. Shown so the user isn't guessing. */
  senderEmail?: string | null;
  defaultTo?: string;
  onClose: () => void;
  /** Fires with the conversation the send landed in, so the caller can open it. */
  onSent: (conversationId: string) => void;
}) {
  const [to, setTo] = useState(defaultTo);
  const [cc, setCc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Accept either an email address or a lead number — same contract the API's
  // `to` field has, so "LEAD-9864" works here without special-casing.
  const toTrimmed = to.trim();
  const toLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toTrimmed) || /^LEAD-\d+$/i.test(toTrimmed);
  const canSubmit = toLooksValid && subject.trim().length > 0 && body.trim().length > 0 && !sending;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSending(true);
    setError(null);
    try {
      const r = await sendEmail({
        to: toTrimmed,
        subject: subject.trim(),
        body,
        ...(cc.trim()
          ? { cc: cc.split(",").map((s) => s.trim()).filter((s) => s.includes("@")) }
          : {}),
      });
      onSent(r.conversationId);
    } catch (err) {
      setError((err as Error).message);
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm sm:p-6"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        className="flex max-h-[calc(100vh-3rem)] w-full max-w-[640px] flex-col rounded-2xl border border-rule bg-paper shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-none border-b border-rule px-7 pb-5 pt-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-serif text-[28px] font-normal leading-tight tracking-[-.01em]">
                New email
              </h2>
              <p className="mt-1 text-[13px] text-mute">
                {senderEmail
                  ? <>Sending from <span className="font-mono text-[12px] text-ink2">{senderEmail}</span>.</>
                  : <>Sending from your connected Gmail.</>}
                {" "}Replies land here and in your Gmail inbox.
              </p>
            </div>
            <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
              <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
            </button>
          </div>
        </div>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-7 py-6">
            {error && (
              <div className="rounded-[10px] border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
                {error}
              </div>
            )}

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="mono-cap text-[10px] font-semibold tracking-[.08em] text-mute">
                  To
                </label>
                {!showCc && (
                  <button
                    type="button"
                    onClick={() => setShowCc(true)}
                    className="mono-cap text-[10px] tracking-[.06em] text-mute transition hover:text-ink"
                  >
                    + Cc
                  </button>
                )}
              </div>
              <input
                className={inputCls}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="someone@example.com — or a lead number like LEAD-9864"
                autoFocus
              />
              {toTrimmed && !toLooksValid && (
                <p className="mt-1 text-[11.5px] text-state-warn">
                  Enter a valid email address, or a lead number like LEAD-9864.
                </p>
              )}
            </div>

            {showCc && (
              <div>
                <label className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.08em] text-mute">
                  Cc
                </label>
                <input
                  className={inputCls}
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                  placeholder="someone@example.com, another@example.com"
                />
              </div>
            )}

            <div>
              <label className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.08em] text-mute">
                Subject
              </label>
              <input
                className={cn(inputCls, "font-semibold")}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Your Full-Stack AI programme — next steps"
              />
            </div>

            <div>
              <label className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.08em] text-mute">
                Message
              </label>
              <textarea
                className={cn(inputCls, "resize-y leading-[1.55]")}
                rows={10}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void submit(e as unknown as React.FormEvent);
                  }
                }}
                placeholder="Write your message…"
              />
            </div>
          </div>

          <div className="flex flex-none items-center justify-between gap-3 border-t border-rule px-7 py-4">
            <span className="font-mono text-[10px] text-hint">⌘/Ctrl + Enter to send</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-rule px-3 py-1.5 text-[12.5px] font-semibold text-mute transition hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-4 py-1.5 text-[12.5px] font-semibold transition",
                  canSubmit
                    ? "bg-brand-blue text-white hover:bg-brand-blue/90"
                    : "cursor-not-allowed bg-warm2 text-hint",
                )}
              >
                <Icon name="send" size={12} strokeWidth={2.2} />
                {sending ? "Sending…" : "Send email"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
