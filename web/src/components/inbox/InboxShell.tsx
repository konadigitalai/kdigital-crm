"use client";

// Unified inbox shell — 2-column layout: thread list on the left, thread
// view on the right. Polls the thread list every 30s (paused when the tab
// is hidden). Open thread polls every 10s inside <ThreadView>.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { getTwConversations } from "@/lib/api";
import type { TwChannel, TwConversationListItem } from "@/lib/types";
import { ThreadList } from "./ThreadList";
import { ThreadView } from "./ThreadView";

const LIST_POLL_MS = 30_000;

export function InboxShell({
  initialConversations,
  canSend,
  canPromote,
  canUpload = false,
  canAddToLibrary = false,
}: {
  initialConversations: TwConversationListItem[];
  canSend: boolean;
  canPromote: boolean;
  canUpload?: boolean;
  canAddToLibrary?: boolean;
}) {
  const [threads, setThreads] = useState(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(initialConversations[0]?.id ?? null);
  // Inbox is now a two-tab surface — WhatsApp OR Voice calls. SMS traffic is
  // still supported by the API but not surfaced here (the FE stopped showing
  // an SMS tab after Twilio SMS was deprioritised in favour of WA templates).
  // Assignee filtering is gone too — operators wanted a simpler view.
  const [channel, setChannel] = useState<TwChannel>("whatsapp");
  const [q, setQ] = useState("");

  const refresh = useCallback(async () => {
    const filter: Parameters<typeof getTwConversations>[0] = {};
    filter.channel = channel;
    if (q.trim()) filter.q = q.trim();
    const rows = await getTwConversations(filter).catch(() => null);
    if (rows) setThreads(rows);
  }, [channel, q]);

  // Refresh whenever the filter changes.
  useEffect(() => { void refresh(); }, [refresh]);

  // Poll every 30s, paused on hidden tab.
  useEffect(() => {
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh();
    }, LIST_POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeId) ?? null,
    [threads, activeId],
  );

  return (
    <div className="grid h-[calc(100vh-140px)] grid-cols-[360px_1fr] gap-4">
      <div className="flex flex-col overflow-hidden rounded-2xl border border-rule bg-paper">
        <div className="border-b border-rule p-3">
          {/* Two-tab channel switch — WhatsApp | Voice calls. A single row of
              equal-width segments so it reads as a mode toggle, not a chip
              filter you can accidentally deselect. */}
          <div className="mb-2 grid grid-cols-2 gap-1 rounded-full border border-rule bg-warm/40 p-1">
            <ChannelTab
              active={channel === "whatsapp"}
              onClick={() => setChannel("whatsapp")}
              icon="message-square"
              label="WhatsApp"
              activeClass="bg-state-ok text-white"
            />
            <ChannelTab
              active={channel === "voice"}
              onClick={() => setChannel("voice")}
              icon="phone"
              label="Calls"
              activeClass="bg-brand-violet text-white"
            />
          </div>
          <div className="flex items-center gap-2 rounded-[10px] border border-rule bg-warm/40 px-2.5 py-1.5">
            <Icon name="search" size={12} strokeWidth={2} className="text-mute" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={channel === "whatsapp" ? "Search WhatsApp threads…" : "Search call threads…"}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink placeholder:text-hint outline-none"
            />
          </div>
        </div>
        <ThreadList
          threads={threads}
          activeId={activeId}
          onSelect={setActiveId}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        {activeThread ? (
          <ThreadView
            threadId={activeThread.id}
            summary={activeThread}
            canSend={canSend}
            canPromote={canPromote}
            canUpload={canUpload}
            canAddToLibrary={canAddToLibrary}
            onRefreshList={refresh}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-[13px] text-mute">
            <div>
              <Icon name="message-square" size={28} strokeWidth={1.5} className="mx-auto mb-3 text-hint" />
              <div className="font-serif text-[20px] text-ink">No thread selected</div>
              <div className="mt-1 text-[12.5px]">Pick a conversation from the list, or wait for a new message to arrive.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Segmented tab in the channel switch. Active tab uses a full-colour fill
 *  (green for WhatsApp, violet for Calls) to match the thread-list styling.
 *  Inactive tabs stay transparent inside the rounded track. */
function ChannelTab({
  active, onClick, icon, label, activeClass,
}: {
  active: boolean;
  onClick: () => void;
  icon: "message-square" | "phone";
  label: string;
  activeClass: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition",
        active ? activeClass : "text-mute hover:text-ink",
      )}
    >
      <Icon name={icon} size={12} strokeWidth={2.2} />
      {label}
    </button>
  );
}
