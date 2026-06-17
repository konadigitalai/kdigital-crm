"use client";

// Left-rail conversation list. One row per conversation:
//   • avatar with initials
//   • party name + (small) phone
//   • last message preview (truncated)
//   • timestamp on the right
//   • unread badge if unreadCount > 0
//   • dot if assigned to current user

import type { WaConversationListItem } from "@/lib/types";

export function ThreadList({
  conversations,
  selectedId,
  onSelect,
  currentUserId,
}: {
  conversations: WaConversationListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  currentUserId: string | null;
}) {
  if (conversations.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-[12.5px] text-mute">
        No conversations match the current filter.
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto">
      {conversations.map((c) => {
        const selected = c.id === selectedId;
        const mine = c.assignedUserId && c.assignedUserId === currentUserId;
        const initials = (c.partyName ?? "?").trim().slice(0, 2).toUpperCase();
        const ago = c.lastMessageAt ? agoLabel(new Date(c.lastMessageAt)) : "";
        const phone = c.partyPhone
          ? `${c.partyPhoneCc ?? ""} ${c.partyPhone}`.trim()
          : "";
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            className={
              "flex w-full items-start gap-3 border-b border-rule px-4 py-3 text-left transition " +
              (selected
                ? "bg-brand-violet/[.06]"
                : "hover:bg-warm2")
            }
          >
            <div className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-full bg-grad-violet text-[12px] font-bold text-white">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13.5px] font-semibold text-ink">{c.partyName}</span>
                {mine && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-brand-violet" title="Assigned to you" />}
                <span className="ml-auto flex-shrink-0 text-[10.5px] text-mute">{ago}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-2">
                <span className="truncate text-[12px] text-mute">
                  {c.lastMessageText ?? <span className="text-hint">No messages yet</span>}
                </span>
                {c.unreadCount > 0 && (
                  <span className="ml-auto flex-shrink-0 rounded-full bg-brand-magenta px-1.5 py-0.5 text-[9.5px] font-semibold text-white">
                    {c.unreadCount > 99 ? "99+" : c.unreadCount}
                  </span>
                )}
              </div>
              {phone && <div className="mono-cap mt-0.5 text-[9.5px] tracking-[.04em] text-hint">{phone}</div>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// Compact "now / 2m / 4h / Mon / 14 Jun" timestamp.
function agoLabel(d: Date): string {
  const now = Date.now();
  const diffMs = now - d.getTime();
  const min = diffMs / 60_000;
  if (min < 1) return "now";
  if (min < 60) return `${Math.round(min)}m`;
  const hr = min / 60;
  if (hr < 24) return `${Math.round(hr)}h`;
  const days = hr / 24;
  if (days < 7) return d.toLocaleDateString("en-IN", { weekday: "short" });
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}
