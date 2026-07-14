"use client";

// The thread pane's bottom half. Four ways to add to a conversation:
//
//   reply → transmitted to the lead on this thread's channel
//   email → transmitted, but always over email regardless of the thread channel
//   call  → NOT transmitted; records a call that happened outside the CRM
//   note  → NOT transmitted; a staff-only annotation
//
// The last two write tw_message rows with kind <> 'message', which is why they
// only need messaging.read server-side. `canSend` therefore gates the first two
// only — an advisor with read-only messaging can still log what they did.

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { addTwConversationNote, logTwConversationCall } from "@/lib/api";
import {
  CALL_OUTCOMES,
  type CallOutcome,
  type TwChannel,
  type TwMessageDirection,
} from "@/lib/types";
import { ReplyBox } from "./ReplyBox";
import { EmailComposer } from "./EmailComposer";

/** Shared with ThreadView so the composer's <select> and the transcript's
 *  call-log callout can never drift apart. */
export const CALL_OUTCOME_LABELS: Record<CallOutcome, string> = {
  connected:      "Call completed",
  no_answer:      "No answer",
  busy:           "Busy",
  voicemail:      "Left voicemail",
  wrong_number:   "Wrong number",
  not_interested: "Marked not interested",
};

/** "4m 12s" / "45s". Null/0 renders as an empty string so callers can just
 *  concatenate without guarding. */
export function formatCallDuration(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

type Mode = "reply" | "email" | "call" | "note";

export function InboxComposer({
  conversationId,
  channel,
  canSend,
  canUpload = false,
  canAddToLibrary = false,
  emailTo,
  emailReplyTo,
  hasEmailThread,
  onStartNewEmail,
  onReplyToLatestEmail,
  onSent,
  onRefresh,
}: {
  conversationId: string;
  channel: TwChannel;
  canSend: boolean;
  canUpload?: boolean;
  canAddToLibrary?: boolean;
  /** Email address, or a lead number the API can resolve one from. */
  emailTo: string;
  emailReplyTo: { id: string; subject: string | null } | null;
  hasEmailThread: boolean;
  onStartNewEmail: () => void;
  onReplyToLatestEmail: () => void;
  /** A message went out — refresh the thread AND the list (its preview changed). */
  onSent: () => void;
  /** A note/call landed — the thread needs to re-fetch to show it. */
  onRefresh: () => void;
}) {
  // A voice thread has no text channel to reply on, and an email thread's
  // "reply" IS the email composer, so neither should open on the reply tab.
  const [mode, setMode] = useState<Mode>(
    channel === "email" ? "email" : channel === "voice" ? "call" : "reply",
  );

  const replyLabel =
    channel === "whatsapp" ? "Reply on WhatsApp"
    : channel === "sms"    ? "Reply on SMS"
    : "Reply";

  return (
    <div className="border-t border-rule bg-paper px-3 pb-3 pt-2">
      <div className="mb-2 flex items-center gap-1">
        <ModeTab active={mode === "reply"} accent="ok" onClick={() => setMode("reply")}>
          {replyLabel}
        </ModeTab>
        <ModeTab active={mode === "email"} onClick={() => setMode("email")}>Email</ModeTab>
        <ModeTab active={mode === "call"} onClick={() => setMode("call")}>Log a call</ModeTab>
        <ModeTab active={mode === "note"} onClick={() => setMode("note")}>Internal note</ModeTab>
      </div>

      {mode === "reply" && (
        !canSend ? (
          <Blocked>
            Read-only — you don&apos;t have the <code>messaging.send</code> permission.
          </Blocked>
        ) : channel === "voice" ? (
          <Blocked>
            Voice threads can&apos;t take a text reply. Call the lead, then log the outcome here.
          </Blocked>
        ) : channel === "email" ? (
          <Blocked>This is an email thread — use the Email tab to reply.</Blocked>
        ) : (
          <ReplyBox
            conversationId={conversationId}
            channel={channel}
            canUpload={canUpload}
            canAddToLibrary={canAddToLibrary}
            onSent={onSent}
          />
        )
      )}

      {mode === "email" && (
        !canSend ? (
          <Blocked>
            Read-only — you don&apos;t have the <code>messaging.send</code> permission.
          </Blocked>
        ) : !emailTo ? (
          <Blocked>No email address on this contact — add one on the lead first.</Blocked>
        ) : (
          <EmailComposer
            to={emailTo}
            replyTo={emailReplyTo}
            hasThread={hasEmailThread}
            onStartNew={onStartNewEmail}
            onReplyToLatest={onReplyToLatestEmail}
            onSent={onSent}
          />
        )
      )}

      {mode === "call" && (
        <CallLogForm conversationId={conversationId} onLogged={onRefresh} />
      )}

      {mode === "note" && (
        <NoteForm conversationId={conversationId} onSaved={onRefresh} />
      )}
    </div>
  );
}

function ModeTab({
  active, accent, onClick, children,
}: {
  active: boolean;
  /** The reply tab is the "this actually reaches the lead" one — green when live. */
  accent?: "ok";
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition",
        active
          ? accent === "ok"
            ? "border border-state-ok/40 bg-state-ok/10 text-state-ok"
            : "bg-warm2 text-ink"
          : "text-mute hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function Blocked({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[10px] border border-dashed border-rule px-3 py-2.5 text-center text-[12px] text-mute">
      {children}
    </div>
  );
}

function FormError({ message }: { message: string }) {
  return (
    <div className="mt-2 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
      {message}
    </div>
  );
}

// ─── Log a call ──────────────────────────────────────────────────────────

function CallLogForm({
  conversationId, onLogged,
}: {
  conversationId: string;
  onLogged: () => void;
}) {
  const [outcome, setOutcome] = useState<CallOutcome>("connected");
  const [direction, setDirection] = useState<TwMessageDirection>("outbound");
  const [mins, setMins] = useState("");
  const [secs, setSecs] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const total = (Number(mins) || 0) * 60 + (Number(secs) || 0);
      await logTwConversationCall(conversationId, {
        outcome,
        durationSec: total > 0 ? total : null,
        notes: notes.trim() || null,
        direction,
      });
      setMins("");
      setSecs("");
      setNotes("");
      onLogged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[10px] border border-rule bg-warm/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as CallOutcome)}
          className="rounded-[8px] border border-rule bg-paper px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-brand-violet"
          aria-label="Call outcome"
        >
          {CALL_OUTCOMES.map((o) => (
            <option key={o} value={o}>{CALL_OUTCOME_LABELS[o]}</option>
          ))}
        </select>

        <div className="flex items-center gap-1 text-[11.5px] text-mute">
          <DurationInput value={mins} onChange={setMins} label="Minutes" max={999} />
          <span>m</span>
          <DurationInput value={secs} onChange={setSecs} label="Seconds" max={59} />
          <span>s</span>
        </div>

        <div className="ml-auto flex items-center gap-1 rounded-full bg-warm2 p-0.5">
          {(["outbound", "inbound"] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDirection(d)}
              className={cn(
                "rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize transition",
                direction === d ? "bg-paper text-ink shadow-sm" : "text-mute hover:text-ink",
              )}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
        placeholder="What was said? (optional)"
        className="mt-2 w-full resize-none rounded-[8px] border border-rule bg-paper px-2.5 py-2 text-[12.5px] leading-[1.4] text-ink placeholder:text-hint outline-none focus:border-brand-violet"
        disabled={busy}
      />

      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-[10.5px] text-hint">
          Recorded on the thread — never sent to the lead.
        </span>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="btn-primary !py-1.5 !text-[12px] disabled:opacity-60"
        >
          <Icon name="phone" size={12} strokeWidth={2.2} />
          {busy ? "Saving…" : "Log call"}
        </button>
      </div>

      {error && <FormError message={error} />}
    </div>
  );
}

function DurationInput({
  value, onChange, label, max,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  max: number;
}) {
  return (
    <input
      type="number"
      min={0}
      max={max}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="0"
      aria-label={label}
      className="w-[52px] rounded-[8px] border border-rule bg-paper px-1.5 py-1.5 text-center text-[12.5px] text-ink placeholder:text-hint outline-none focus:border-brand-violet"
    />
  );
}

// ─── Internal note ───────────────────────────────────────────────────────

function NoteForm({
  conversationId, onSaved,
}: {
  conversationId: string;
  onSaved: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await addTwConversationNote(conversationId, text);
      setBody("");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[10px] border border-state-amber/40 bg-[rgba(224,138,30,.07)] p-3">
      <div className="mono-cap mb-1.5 text-[9px] tracking-[.12em] text-state-amber">
        Internal note
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="Context for your team — pricing discussed, objections, anything worth remembering."
        className="w-full resize-none rounded-[8px] border border-state-amber/25 bg-paper px-2.5 py-2 text-[12.5px] leading-[1.4] text-ink placeholder:text-hint outline-none focus:border-state-amber"
        disabled={busy}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-[10.5px] text-state-amber">
          Only your team can see this — it is never sent to the lead.
        </span>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !body.trim()}
          className="btn-primary !py-1.5 !text-[12px] disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save note"}
        </button>
      </div>
      {error && <FormError message={error} />}
    </div>
  );
}
