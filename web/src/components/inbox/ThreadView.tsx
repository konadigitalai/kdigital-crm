"use client";

// Thread pane: header + message bubbles + reply box.
// Polls thread detail every 10s while active + tab visible.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  getTwConversation,
  markTwConversationRead,
  promoteTwConversationToLead,
} from "@/lib/api";
import type { TwConversationDetail, TwConversationListItem, TwMessage } from "@/lib/types";
import { ReplyBox } from "./ReplyBox";

const DETAIL_POLL_MS = 10_000;

export function ThreadView({
  threadId, summary, canSend, canPromote, onRefreshList,
}: {
  threadId: string;
  summary: TwConversationListItem;
  canSend: boolean;
  canPromote: boolean;
  onRefreshList: () => void;
}) {
  const [detail, setDetail] = useState<TwConversationDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyPromote, setBusyPromote] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchDetail = useCallback(async () => {
    try {
      const d = await getTwConversation(threadId);
      setDetail(d);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [threadId]);

  // Initial load + mark-read on open.
  useEffect(() => {
    void fetchDetail();
    void markTwConversationRead(threadId).catch(() => {});
  }, [fetchDetail, threadId]);

  // Poll every 10s while tab is visible.
  useEffect(() => {
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void fetchDetail();
    }, DETAIL_POLL_MS);
    return () => clearInterval(t);
  }, [fetchDetail]);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [detail?.messages.length]);

  async function promote() {
    if (!canPromote) return;
    setBusyPromote(true);
    try {
      await promoteTwConversationToLead(threadId);
      await fetchDetail();
      onRefreshList();
    } finally {
      setBusyPromote(false);
    }
  }

  const messages = detail?.messages ?? [];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-rule px-5 py-4">
        <span
          className={cn(
            "flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white",
            summary.channel === "whatsapp" ? "bg-state-ok" : "bg-brand-blue",
          )}
        >
          {initials(summary.partyName)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[16px] font-bold tracking-[-.005em]">{summary.partyName}</h2>
            <span className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[9px] font-semibold tracking-[.08em] text-mute">
              {summary.channel === "whatsapp" ? "WhatsApp" : "SMS"}
            </span>
            {summary.leadNumber && (
              <Link
                href={`/records/${summary.leadNumber}`}
                className="mono-cap rounded-full bg-brand-violet/10 px-2 py-0.5 text-[9px] font-semibold tracking-[.08em] text-brand-violet hover:underline"
              >
                {summary.leadNumber}
              </Link>
            )}
          </div>
          <div className="mt-0.5 text-[12px] text-mute">{summary.partyPhone ?? "—"}</div>
        </div>
        {summary.isUnlinked && canPromote && (
          <button
            type="button"
            disabled={busyPromote}
            onClick={promote}
            className="rounded-md border border-brand-violet bg-brand-violet px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-brand-violet/90 disabled:opacity-60"
          >
            {busyPromote ? "Promoting…" : "Promote to lead"}
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-warm/30 px-5 py-4">
        {loadError && (
          <div className="mb-3 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
            {loadError}
          </div>
        )}
        {messages.length === 0 && !loadError && (
          <div className="text-center text-[12.5px] text-mute">Loading…</div>
        )}
        <div className="flex flex-col gap-2">
          {messages.map((m) => <MessageBubble key={m.id} msg={m} />)}
        </div>
      </div>

      {/* Reply */}
      <div className="border-t border-rule bg-paper p-3">
        {canSend ? (
          <ReplyBox
            conversationId={threadId}
            onSent={() => { void fetchDetail(); onRefreshList(); }}
          />
        ) : (
          <div className="rounded-md border border-dashed border-rule px-3 py-2 text-center text-[12px] text-mute">
            Read-only — you don&apos;t have the <code>messaging.send</code> permission.
          </div>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: TwMessage }) {
  const outbound = msg.direction === "outbound";
  const failed   = msg.status === "failed";
  return (
    <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[70%] rounded-2xl px-3.5 py-2 text-[13px] leading-[1.45]",
          outbound
            ? failed
              ? "bg-state-warn/10 text-ink2 ring-1 ring-state-warn/40"
              : "bg-brand-violet text-white"
            : "bg-paper text-ink2 ring-1 ring-rule",
        )}
      >
        <p className="whitespace-pre-wrap">{msg.body ?? ""}</p>
        <div className={cn(
          "mt-1 flex items-center gap-1 font-mono text-[9.5px]",
          outbound && !failed ? "text-white/70" : "text-mute",
        )}>
          <span>{new Date(msg.sentAt).toLocaleString()}</span>
          {outbound && <span>· {msg.status}</span>}
          {failed && msg.errorMessage && (
            <span title={msg.errorMessage} className="cursor-help">· err {msg.errorCode ?? ""}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function initials(name: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  return (parts[0]![0]! + (parts[1]?.[0] ?? "")).toUpperCase();
}
