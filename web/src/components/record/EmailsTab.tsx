"use client";

// The lead-record "Emails" tab. Renders the lead's real email thread inline —
// everything exchanged with their address, whether it was sent from the CRM or
// typed directly in Gmail, since the sync worker ingests both.
//
// This replaced a stub that filtered `activity` rows and always said "No emails
// sent or received yet." It reads from the same tw_conversation/tw_message
// tables as the Inbox tab, scoped to (party, channel='email').

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  getGmailStatus, getTwConversation, getTwConversations,
  markTwConversationRead,
} from "@/lib/api";
import type {
  GmailStatus, TwConversationDetail, TwConversationListItem, TwMessage,
} from "@/lib/types";
import { EmailComposer } from "@/components/inbox/EmailComposer";
import { MessageMediaGallery } from "@/components/media/MessageMediaGallery";
import { ConnectGmailPrompt } from "./ConnectGmailPrompt";

const POLL_MS = 20_000;

export function EmailsTab({
  partyId, partyEmail, leadNumber, canSend,
}: {
  partyId: string;
  /** The lead's address. Without one there's nowhere to send. */
  partyEmail: string | null;
  leadNumber: string;
  canSend: boolean;
}) {
  const [thread, setThread] = useState<TwConversationListItem | null>(null);
  const [detail, setDetail] = useState<TwConversationDetail | null>(null);
  const [gmail, setGmail] = useState<GmailStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const all = await getTwConversations({ channel: "email", limit: 500 });
      setThread(all.find((t) => t.partyId === partyId) ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [partyId]);

  useEffect(() => { void refreshList(); }, [refreshList]);
  useEffect(() => { void getGmailStatus().then(setGmail).catch(() => {}); }, []);

  const refreshDetail = useCallback(async () => {
    if (!thread) { setDetail(null); return; }
    try {
      setDetail(await getTwConversation(thread.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [thread]);

  useEffect(() => {
    void refreshDetail();
    if (thread) void markTwConversationRead(thread.id).catch(() => {});
  }, [refreshDetail, thread]);

  useEffect(() => {
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refreshDetail();
      void refreshList();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [refreshDetail, refreshList]);

  const messages = detail?.messages ?? [];
  const lastEmail = useMemo(
    () => [...messages].reverse().find((m) => m.channel === "email") ?? null,
    [messages],
  );

  // Composer target: reply to a specific message (default: the newest), or
  // start a brand-new thread. Owned here so each EmailCard's Reply button can
  // aim the composer at an older message.
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [composeNew, setComposeNew] = useState(false);
  const replyTarget = composeNew
    ? null
    : (messages.find((m) => m.id === replyToId) ?? lastEmail);

  // Which mailbox a send would actually leave from. Mirrors the API's
  // resolution order in routes/gmail.ts: your own account, else the shared one.
  const senderEmail = gmail?.account?.email ?? gmail?.shared ?? null;
  const canActuallySend = canSend && !!senderEmail && !!partyEmail;

  if (!partyEmail) {
    return (
      <Empty>
        This lead has no email address on file. Add one to their contact details
        before you can email them.
      </Empty>
    );
  }

  return (
    <div className="rounded-[14px] border border-rule bg-paper">
      <div className="flex items-center gap-2 border-b border-rule px-3 py-2">
        <Icon name="mail" size={13} strokeWidth={2.2} className="text-brand-blue" />
        <span className="font-mono text-[11px] text-mute">{partyEmail}</span>
        <span className="ml-auto text-[11px] text-mute">
          {loading ? "Loading…" : messages.length === 0 ? "No emails yet" : `${messages.length} message${messages.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {error && (
        <div className="border-b border-rule bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
          {error}
        </div>
      )}

      <div className="max-h-[520px] overflow-y-auto bg-warm/30 px-3 py-3">
        {messages.length === 0 ? (
          <div className="py-8 text-center text-[12.5px] text-mute">
            {canActuallySend
              ? "No emails with this lead yet. Send the first one below."
              : "No emails with this lead yet."}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {messages.map((m) => (
              <EmailCard
                key={m.id}
                msg={m}
                isReplyTarget={m.id === replyTarget?.id}
                onReplyTo={canActuallySend
                  ? () => { setComposeNew(false); setReplyToId(m.id); }
                  : undefined}
              />
            ))}
          </div>
        )}
      </div>

      {!canSend ? (
        <div className="border-t border-rule px-3 py-2 text-center text-[11.5px] text-mute">
          Read-only — you don&apos;t have the <code>messaging.send</code> permission.
        </div>
      ) : !senderEmail ? (
        <div className="border-t border-rule p-3">
          <ConnectGmailPrompt status={gmail} onChanged={() => void getGmailStatus().then(setGmail).catch(() => {})} />
        </div>
      ) : (
        <div className="border-t border-rule p-3">
          <EmailComposer
            to={partyEmail ?? leadNumber}
            replyTo={replyTarget ? { id: replyTarget.id, subject: replyTarget.subject ?? null } : null}
            hasThread={!!lastEmail}
            senderEmail={senderEmail}
            onStartNew={() => { setComposeNew(true); setReplyToId(null); }}
            onReplyToLatest={() => { setComposeNew(false); setReplyToId(null); }}
            onSent={() => {
              setComposeNew(false);
              setReplyToId(null);
              void refreshDetail();
              void refreshList();
            }}
          />
        </div>
      )}
    </div>
  );
}

/** One email in the record-page thread. Flatter than the inbox chat bubble —
 *  a record timeline reads better as stacked cards than as a chat. */
function EmailCard({
  msg, isReplyTarget = false, onReplyTo,
}: {
  msg: TwMessage;
  isReplyTarget?: boolean;
  /** Undefined when the user can't send — the Reply button then doesn't render. */
  onReplyTo?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const outbound = msg.direction === "outbound";
  const failed   = msg.status === "failed";
  const body     = msg.body ?? "";
  // Collapse long bodies — a record page shouldn't be a wall of quoted replies.
  const isLong   = body.length > 400;
  const shown    = open || !isLong ? body : body.slice(0, 400).trimEnd() + "…";

  return (
    <div
      className={cn(
        "group/card rounded-[12px] border p-3",
        failed   ? "border-state-warn/40 bg-state-warn/[.06]"
        : outbound ? "border-brand-blue/25 bg-[#f2f6fd]"
        :            "border-rule bg-paper",
        isReplyTarget && "ring-2 ring-brand-blue/45",
      )}
    >
      <div className="mb-1.5 flex items-start gap-2">
        <span
          className={cn(
            "mono-cap mt-[2px] flex-shrink-0 rounded-full px-1.5 py-0.5 text-[8.5px] font-semibold tracking-[.08em]",
            outbound ? "bg-brand-blue/10 text-brand-blue" : "bg-warm2 text-mute",
          )}
        >
          {outbound ? "Sent" : "Received"}
        </span>
        <span className="min-w-0 flex-1 break-words text-[13px] font-semibold leading-[1.3]">
          {msg.subject?.trim() || "(no subject)"}
        </span>
        <span className="mt-[2px] flex-shrink-0 font-mono text-[10px] text-mute">
          {new Date(msg.sentAt).toLocaleString("en-GB", {
            day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
          })}
        </span>
        {/* Aim the composer at THIS message, so you can answer an old mail in
            the thread rather than only the newest. */}
        {onReplyTo && (
          <button
            type="button"
            onClick={onReplyTo}
            title="Reply to this email"
            className={cn(
              "mt-[1px] flex h-[22px] flex-shrink-0 items-center gap-1 rounded-md border px-1.5 text-[10.5px] font-semibold transition",
              isReplyTarget
                ? "border-brand-blue bg-brand-blue text-white"
                : "border-rule bg-paper text-mute opacity-0 hover:text-ink group-hover/card:opacity-100 focus-visible:opacity-100",
            )}
          >
            <Icon name="reply" size={10} strokeWidth={2.2} />
            Reply
          </button>
        )}
      </div>

      <div className="mb-2 break-all font-mono text-[10px] text-mute">
        {msg.fromNumber}
        {msg.toAddrs?.length ? <> → {msg.toAddrs.join(", ")}</> : null}
      </div>

      {shown && (
        <p className="whitespace-pre-wrap break-words text-[12.5px] leading-[1.5] text-ink2">
          {shown}
        </p>
      )}
      {isLong && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1.5 text-[11.5px] font-semibold text-brand-blue hover:underline"
        >
          {open ? "Show less" : "Show full email"}
        </button>
      )}

      {msg.media && msg.media.length > 0 && (
        <div className="mt-2">
          <MessageMediaGallery media={msg.media} outbound={outbound} />
        </div>
      )}

      {failed && (
        <div className="mt-2 text-[11.5px] text-state-warn">
          Failed to send{msg.errorMessage ? ` — ${msg.errorMessage}` : ""}
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[14px] border border-dashed border-rule bg-paper px-5 py-10 text-center text-[12.5px] text-mute">
      {children}
    </div>
  );
}
