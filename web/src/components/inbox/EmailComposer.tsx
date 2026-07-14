"use client";

// Email composer for the inbox and the record page.
//
// Deliberately NOT the same component as <ReplyBox> (SMS/WhatsApp): email has a
// subject, a cc line, and a reply-vs-compose distinction a chat input has no
// concept of.
//
// Two modes, switchable by the caller:
//
//   Reply  (replyTo set)  — inherits the parent's subject and Gmail thread
//     server-side, so the subject field is hidden. Editing the subject on a
//     reply forks the thread in the recipient's mail client, which is why we
//     don't offer it.
//
//   New    (replyTo null) — a fresh thread with its own subject.
//
// The caller decides which message is being replied to, so you can reply to an
// OLD message in the thread, not just the newest one.

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { sendEmail } from "@/lib/api";

export interface ReplyTarget {
  id: string;
  subject: string | null;
}

export function EmailComposer({
  to,
  replyTo,
  senderEmail,
  onStartNew,
  onReplyToLatest,
  hasThread = false,
  onSent,
}: {
  /** Email address or lead number ("LEAD-9865"). The API resolves either. */
  to: string;
  /** The message being replied to. Null = compose a new thread. */
  replyTo?: ReplyTarget | null;
  /** The mailbox this will send from, for the "from" hint. */
  senderEmail?: string | null;
  /** Switch to composing a brand-new thread. */
  onStartNew?: () => void;
  /** Switch back to replying to the newest message. */
  onReplyToLatest?: () => void;
  /** Whether there's an existing thread at all (enables the Reply tab). */
  hasThread?: boolean;
  onSent: () => void;
}) {
  const isReply = !!replyTo;
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [cc, setCc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = body.trim().length > 0 && (isReply || subject.trim().length > 0) && !sending;

  async function submit() {
    if (!canSubmit) return;
    setSending(true);
    setError(null);
    try {
      await sendEmail({
        to,
        body,
        ...(isReply ? { inReplyToMessageId: replyTo!.id } : { subject: subject.trim() }),
        ...(cc.trim()
          ? { cc: cc.split(",").map((s) => s.trim()).filter((s) => s.includes("@")) }
          : {}),
      });
      setBody("");
      setSubject("");
      setCc("");
      setShowCc(false);
      onSent();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rounded-[10px] border border-rule bg-paper p-2">
      {error && (
        <div className="mb-2 rounded-md border border-state-warn/30 bg-state-warn/10 px-2.5 py-1.5 text-[12px] text-state-warn">
          {error}
        </div>
      )}

      {/* Mode switch. Only meaningful once a thread exists — with no prior mail
          there's nothing to reply to, so we just compose. */}
      {hasThread && (onStartNew || onReplyToLatest) && (
        <div className="mb-2 flex items-center gap-1">
          <ModeTab
            active={isReply}
            disabled={!onReplyToLatest}
            onClick={() => onReplyToLatest?.()}
            icon="reply"
          >
            Reply
          </ModeTab>
          <ModeTab
            active={!isReply}
            disabled={!onStartNew}
            onClick={() => onStartNew?.()}
            icon="mail"
          >
            New email
          </ModeTab>
        </div>
      )}

      <div className="mb-1.5 flex items-center gap-2 px-1 font-mono text-[10px] text-mute">
        <span className="truncate">
          {senderEmail ? <>from {senderEmail}</> : <>from your connected Gmail</>} → {to}
        </span>
        {!showCc && (
          <button
            type="button"
            onClick={() => setShowCc(true)}
            className="ml-auto flex-shrink-0 rounded px-1 py-0.5 uppercase tracking-[.06em] transition hover:bg-warm2 hover:text-ink"
          >
            + Cc
          </button>
        )}
      </div>

      {showCc && (
        <input
          value={cc}
          onChange={(e) => setCc(e.target.value)}
          placeholder="cc: someone@example.com, another@example.com"
          className="mb-1.5 w-full rounded-md border border-rule bg-warm/40 px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-hint outline-none focus:border-brand-blue"
        />
      )}

      {isReply ? (
        <div className="mb-1.5 truncate px-1 text-[12px] text-mute">
          Replying to:{" "}
          <span className="font-semibold text-ink">
            {replyTo!.subject?.trim() || "(no subject)"}
          </span>
        </div>
      ) : (
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject"
          className="mb-1.5 w-full rounded-md border border-rule bg-warm/40 px-2.5 py-1.5 text-[13px] font-semibold text-ink placeholder:text-hint outline-none focus:border-brand-blue"
        />
      )}

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Ctrl/Cmd+Enter sends. Plain Enter must insert a newline — email
          // bodies are paragraphs, unlike a chat input where Enter-to-send is
          // the expected reflex.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        rows={isReply ? 4 : 7}
        placeholder="Write your message…"
        className="w-full resize-y rounded-md border border-rule bg-warm/40 px-2.5 py-2 text-[13px] leading-[1.5] text-ink placeholder:text-hint outline-none focus:border-brand-blue"
      />

      <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
        <span className="font-mono text-[10px] text-hint">⌘/Ctrl + Enter to send</span>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold transition",
            canSubmit
              ? "bg-brand-blue text-white hover:bg-brand-blue/90"
              : "cursor-not-allowed bg-warm2 text-hint",
          )}
        >
          <Icon name="send" size={12} strokeWidth={2.2} />
          {sending ? "Sending…" : isReply ? "Reply" : "Send email"}
        </button>
      </div>
    </div>
  );
}

function ModeTab({
  active, disabled, onClick, icon, children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: "mail" | "reply";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition",
        active
          ? "bg-brand-blue text-white"
          : "text-mute hover:bg-warm2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <Icon name={icon} size={11} strokeWidth={2.2} />
      {children}
    </button>
  );
}
