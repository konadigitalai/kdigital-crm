"use client";

import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import type { TwChannel, TwConversationListItem } from "@/lib/types";

export type ChannelFilter  = "all" | TwChannel;
export type AssigneeFilter = "all" | "me" | "unassigned";

export function ThreadList({
  threads, activeId, onSelect,
}: {
  threads: TwConversationListItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  if (threads.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-[12.5px] text-mute">
        No conversations match this filter.
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto">
      {threads.map((t) => (
        <ThreadRow
          key={t.id}
          thread={t}
          active={t.id === activeId}
          onClick={() => onSelect(t.id)}
        />
      ))}
    </div>
  );
}

function ThreadRow({
  thread, active, onClick,
}: {
  thread: TwConversationListItem;
  active: boolean;
  onClick: () => void;
}) {
  const isWA = thread.channel === "whatsapp";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-3 border-b border-rule/60 px-4 py-3 text-left transition",
        active ? "bg-brand-violet/[.06]" : "hover:bg-warm/40",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white",
          isWA ? "bg-state-ok" : "bg-brand-blue",
        )}
        title={isWA ? "WhatsApp" : "SMS"}
      >
        {initials(thread.partyName)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-ink">{thread.partyName}</span>
          <span className="mono-cap flex-shrink-0 rounded-full bg-warm2 px-1.5 py-0.5 text-[8.5px] font-semibold tracking-[.08em] text-mute">
            {isWA ? "WA" : "SMS"}
          </span>
          {thread.leadNumber && (
            <span className="mono-cap flex-shrink-0 rounded-full bg-brand-violet/10 px-1.5 py-0.5 text-[8.5px] font-semibold tracking-[.08em] text-brand-violet">
              {thread.leadNumber}
            </span>
          )}
          {thread.isUnlinked && (
            <span className="mono-cap flex-shrink-0 rounded-full bg-state-amber/15 px-1.5 py-0.5 text-[8.5px] font-semibold tracking-[.08em] text-state-amber">
              UNLINKED
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-ink2">
          {thread.lastMessageText ?? <span className="italic text-hint">no messages yet</span>}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-mute">
          <span>{thread.partyPhone ?? "—"}</span>
          <span>·</span>
          <span>{thread.lastMessageAt ? new Date(thread.lastMessageAt).toLocaleString() : "—"}</span>
        </div>
      </div>
      {thread.unreadCount > 0 && (
        <span className="mt-1 rounded-full bg-brand-magenta px-1.5 py-0.5 font-mono text-[10px] font-bold text-white">
          {thread.unreadCount}
        </span>
      )}
      {active && <Icon name="chevron-down" size={14} className="text-brand-violet -rotate-90 mt-1" />}
    </button>
  );
}

function initials(name: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  return (parts[0]![0]! + (parts[1]?.[0] ?? "")).toUpperCase();
}
