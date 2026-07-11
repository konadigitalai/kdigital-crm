"use client";

// The lead-record "Inbox" tab. Renders the lead's WhatsApp + voice-call
// threads inline. Users pick between the two channels (each is its own
// tw_conversation) and reply / dial from here without leaving the record
// page. Text replies work only for WhatsApp; the Calls tab is read-only
// (calls are placed via the header's Call button which opens the Exotel
// click-to-call dialog).

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  getTwConversation,
  getTwConversations,
  markTwConversationRead,
  sendTwMessageInThread,
} from "@/lib/api";
import type {
  TwChannel, TwConversationDetail, TwConversationListItem, TwMessage,
} from "@/lib/types";
import { MessageMediaGallery } from "@/components/media/MessageMediaGallery";

const POLL_MS = 15_000;

export function MessagesTab({
  partyId, canSend,
}: {
  partyId: string;
  canSend: boolean;
}) {
  const [threads, setThreads] = useState<TwConversationListItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [channel, setChannel] = useState<TwChannel>("whatsapp");
  const [detail, setDetail] = useState<TwConversationDetail | null>(null);
  const [text, setText] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the two possible threads for this party (one per channel).
  const refreshList = useCallback(async () => {
    try {
      const all = await getTwConversations({ limit: 500 });
      const mine = all.filter((t) => t.partyId === partyId);
      setThreads(mine);
    } finally {
      setLoadingList(false);
    }
  }, [partyId]);

  useEffect(() => { void refreshList(); }, [refreshList]);

  const activeThread = useMemo(
    () => threads.find((t) => t.channel === channel) ?? null,
    [threads, channel],
  );

  // Fetch detail for the active thread; mark read on view.
  const refreshDetail = useCallback(async () => {
    if (!activeThread) { setDetail(null); return; }
    try {
      const d = await getTwConversation(activeThread.id);
      setDetail(d);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeThread]);

  useEffect(() => {
    void refreshDetail();
    if (activeThread) void markTwConversationRead(activeThread.id).catch(() => {});
  }, [refreshDetail, activeThread]);

  // Poll the detail every 15s.
  useEffect(() => {
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refreshDetail();
      void refreshList();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [refreshDetail, refreshList]);

  async function submit() {
    if (!activeThread || !canSend) return;
    const body = text.trim();
    if (!body || sendBusy) return;
    setSendBusy(true);
    setError(null);
    try {
      const r = await sendTwMessageInThread(activeThread.id, body);
      if (!r.ok) {
        setError(r.errorMessage ?? `Send failed${r.errorCode ? ` (${r.errorCode})` : ""}`);
        return;
      }
      setText("");
      await refreshDetail();
      await refreshList();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSendBusy(false);
    }
  }

  const messages = detail?.messages ?? [];

  return (
    <div className="rounded-[14px] border border-rule bg-paper">
      <div className="flex items-center gap-1 border-b border-rule px-3 py-2">
        <ChannelPill active={channel === "whatsapp"} onClick={() => setChannel("whatsapp")} icon="message-square">WhatsApp</ChannelPill>
        <ChannelPill active={channel === "voice"}    onClick={() => setChannel("voice")}    icon="phone"         >Calls</ChannelPill>
        <span className="ml-auto text-[11px] text-mute">
          {loadingList ? "Loading…" : activeThread ? "" : "No conversation yet"}
        </span>
      </div>

      <div className="max-h-[420px] overflow-y-auto bg-warm/30 px-3 py-3">
        {activeThread ? (
          messages.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-mute">
              No messages in this thread yet.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {messages.map((m) => <MiniBubble key={m.id} msg={m} />)}
            </div>
          )
        ) : (
          <div className="py-8 text-center text-[12.5px] text-mute">
            {canSend ? (
              channel === "voice"
                ? <>No calls with this contact yet. Use the <b>Call</b> button in the header to place the first one.</>
                : <>Send your first WhatsApp message below to start a thread.</>
            ) : (
              channel === "voice"
                ? <>No calls with this contact yet.</>
                : <>No WhatsApp conversation with this contact yet.</>
            )}
          </div>
        )}
      </div>

      {/* Reply area — text composer for WhatsApp; hidden for voice (calls
          are placed from the record page's Call button, not from here). */}
      {channel === "voice" ? (
        <div className="border-t border-rule px-3 py-2 text-center text-[11.5px] text-mute">
          Voice threads are read-only here. Use the <b>Call</b> button in the header to place or return a call.
        </div>
      ) : canSend ? (
        <div className="border-t border-rule p-3">
          <div className="flex items-end gap-2 rounded-[10px] border border-rule bg-warm/40 px-2.5 py-2 focus-within:border-brand-violet focus-within:ring-2 focus-within:ring-brand-violet/20">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
              }}
              placeholder={
                activeThread
                  ? "Type a reply… (Ctrl/⌘+Enter to send)"
                  : "Type your first message… (Ctrl/⌘+Enter to send)"
              }
              className="min-h-[36px] flex-1 resize-y bg-transparent text-[13px] text-ink placeholder:text-hint outline-none"
            />
            <button
              type="button"
              onClick={submit}
              disabled={sendBusy || !text.trim() || !activeThread}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold transition",
                text.trim() && activeThread && !sendBusy
                  ? "bg-brand-violet text-white hover:bg-brand-violet/90"
                  : "bg-warm2 text-mute cursor-not-allowed",
              )}
            >
              <Icon name="send" size={12} strokeWidth={2.2} />
              {sendBusy ? "Sending…" : "Send"}
            </button>
          </div>
          {!activeThread && (
            <p className="mono-cap mt-2 text-[10px] tracking-[.04em] text-hint">
              Use the &ldquo;Send message&rdquo; button in the header to open the first thread.
            </p>
          )}
          {error && (
            <div className="mt-2 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
              {error}
            </div>
          )}
        </div>
      ) : (
        <div className="border-t border-rule px-3 py-2 text-center text-[11.5px] text-mute">
          Read-only — you don&apos;t have the <code>messaging.send</code> permission.
        </div>
      )}
    </div>
  );
}

function ChannelPill({
  active, onClick, icon, children,
}: {
  active: boolean;
  onClick: () => void;
  icon?: "message-square" | "phone";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-semibold transition",
        active ? "bg-ink text-white" : "text-ink2 hover:bg-warm",
      )}
    >
      {icon && <Icon name={icon} size={11} strokeWidth={2.2} />}
      {children}
    </button>
  );
}

function MiniBubble({ msg }: { msg: TwMessage }) {
  const outbound = msg.direction === "outbound";
  const failed   = msg.status === "failed";
  const isVoice  = msg.channel === "voice";
  const audio    = isVoice ? (msg.media ?? []).find((m) => (m.contentType ?? "").startsWith("audio/")) : null;
  return (
    <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-3 py-2 text-[12.5px] leading-[1.4]",
          outbound
            ? failed
              ? "bg-state-warn/10 text-ink2 ring-1 ring-state-warn/40"
              : "bg-brand-violet text-white"
            : "bg-paper text-ink2 ring-1 ring-rule",
        )}
      >
        {isVoice ? (
          <div>
            <div className="flex items-center gap-1.5">
              <Icon name="phone" size={12} strokeWidth={2.2} className={outbound && !failed ? "text-white" : "text-brand-violet"} />
              <span className="font-semibold">
                {msg.body?.trim() || (outbound ? "Outbound call" : "Inbound call")}
              </span>
            </div>
            {audio?.fetchUrl && (
              <audio controls preload="none" src={audio.fetchUrl} className="mt-2 w-full min-w-[220px]" />
            )}
          </div>
        ) : (
          <>
            {msg.body && <p className="whitespace-pre-wrap">{msg.body}</p>}
            {msg.media && msg.media.length > 0 && (
              <MessageMediaGallery media={msg.media} outbound={outbound} />
            )}
          </>
        )}
        <div className={cn(
          "mt-1 font-mono text-[9.5px]",
          outbound && !failed ? "text-white/70" : "text-mute",
        )}>
          {new Date(msg.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          {outbound && ` · ${msg.status}`}
          {failed && msg.errorCode && ` · err ${msg.errorCode}`}
        </div>
      </div>
    </div>
  );
}
