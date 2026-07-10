"use client";

// Unified inbox shell — 2-column layout: thread list on the left, thread
// view on the right. Polls the thread list every 30s (paused when the tab
// is hidden). Open thread polls every 10s inside <ThreadView>.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { getTwConversations } from "@/lib/api";
import type { TwChannel, TwConversationListItem } from "@/lib/types";
import { ThreadList, type ChannelFilter, type AssigneeFilter } from "./ThreadList";
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
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [assignee, setAssignee] = useState<AssigneeFilter>("all");
  const [q, setQ] = useState("");

  const refresh = useCallback(async () => {
    const filter: Parameters<typeof getTwConversations>[0] = {};
    if (channel !== "all")  filter.channel  = channel as TwChannel;
    if (assignee !== "all") filter.assignee = assignee;
    if (q.trim())           filter.q        = q.trim();
    const rows = await getTwConversations(filter).catch(() => null);
    if (rows) setThreads(rows);
  }, [channel, assignee, q]);

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
          <div className="mb-2 flex items-center gap-2 rounded-[10px] border border-rule bg-warm/40 px-2.5 py-1.5">
            <Icon name="search" size={12} strokeWidth={2} className="text-mute" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, phone, message…"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink placeholder:text-hint outline-none"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            <FilterChip active={channel === "all"}      onClick={() => setChannel("all")}     >All</FilterChip>
            <FilterChip active={channel === "sms"}      onClick={() => setChannel("sms")}     >SMS</FilterChip>
            <FilterChip active={channel === "whatsapp"} onClick={() => setChannel("whatsapp")}>WhatsApp</FilterChip>
            <span className="mx-1 w-px self-stretch bg-rule" />
            <FilterChip active={assignee === "all"}        onClick={() => setAssignee("all")}       >Any owner</FilterChip>
            <FilterChip active={assignee === "me"}         onClick={() => setAssignee("me")}        >Mine</FilterChip>
            <FilterChip active={assignee === "unassigned"} onClick={() => setAssignee("unassigned")}>Unassigned</FilterChip>
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

function FilterChip({
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
        "rounded-full border px-2.5 py-1 text-[11px] font-semibold transition",
        active
          ? "border-brand-violet bg-brand-violet/10 text-brand-violet"
          : "border-rule bg-paper text-ink2 hover:border-rule2",
      )}
    >
      {children}
    </button>
  );
}
