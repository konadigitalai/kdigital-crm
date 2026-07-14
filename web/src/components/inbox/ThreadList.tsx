"use client";

import { Icon, type IconName } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { avatarGradClass, gradFor, initialsOf, ratingStyles } from "@/lib/ui";
import type { TwChannel, TwConversationListItem } from "@/lib/types";

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

const CHANNEL_BADGE: Record<TwChannel, { bg: string; icon: IconName; label: string }> = {
  whatsapp: { bg: "bg-state-ok",      icon: "chat",           label: "WhatsApp" },
  voice:    { bg: "bg-brand-magenta", icon: "phone",          label: "Voice call" },
  email:    { bg: "bg-brand-blue",    icon: "mail",           label: "Email" },
  sms:      { bg: "bg-mute",          icon: "message-square", label: "SMS" },
};

function ThreadRow({
  thread, active, onClick,
}: {
  thread: TwConversationListItem;
  active: boolean;
  onClick: () => void;
}) {
  const badge  = CHANNEL_BADGE[thread.channel];
  const unread = thread.unreadCount > 0;
  const rating = thread.leadRating ? ratingStyles[thread.leadRating] : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // The inactive border is transparent rather than absent so selecting a
        // row doesn't shove its content 3px to the right.
        "flex w-full items-start gap-3 border-b border-rule/60 border-l-[3px] px-3 py-3 text-left transition",
        active
          ? "border-l-brand-violet bg-warm"
          : "border-l-transparent hover:bg-warm/40",
      )}
    >
      <span className="relative mt-0.5 flex-shrink-0">
        <span
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-full text-[12px] font-bold text-white",
            avatarGradClass[gradFor(thread.partyId)],
          )}
        >
          {initialsOf(thread.partyName)}
        </span>
        <span
          title={badge.label}
          className={cn(
            "absolute -bottom-0.5 -left-0.5 flex h-[15px] w-[15px] items-center justify-center rounded-full text-white ring-2 ring-paper",
            badge.bg,
          )}
        >
          <Icon name={badge.icon} size={8} strokeWidth={2.6} />
        </span>
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "truncate text-[13px]",
              unread ? "font-bold text-ink" : "font-semibold text-ink2",
            )}
          >
            {thread.partyName}
          </span>
          <span className="ml-auto flex-shrink-0 text-[10.5px] text-mute">
            {fmtRelative(thread.lastMessageAt)}
          </span>
        </div>

        <div className="mt-0.5 truncate text-[12px] text-mute">
          {thread.lastMessageText ?? <span className="italic text-hint">no messages yet</span>}
        </div>

        {(rating || thread.isUnlinked) && (
          <div className="mt-1.5 flex items-center gap-1.5">
            {thread.isUnlinked ? (
              <span className="mono-cap inline-flex items-center rounded-full bg-state-amber/15 px-1.5 py-0.5 text-[8.5px] font-semibold tracking-[.08em] text-state-amber">
                UNLINKED
              </span>
            ) : rating ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                  rating.bg, rating.text,
                )}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", rating.dot)} />
                {rating.label}
              </span>
            ) : null}
          </div>
        )}
      </div>

      {unread && (
        <span
          className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-brand-magenta"
          title={`${thread.unreadCount} unread`}
        />
      )}
    </button>
  );
}

// Relative timestamps, pinned to IST — same reasoning as lib/ui.ts: every user
// is in India, and a zone-dependent "Yest" is worse than a wrong-but-consistent
// one when the list is polled and re-rendered constantly.
const IST = "Asia/Kolkata";
const istDayFmt     = new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" });
const istTimeFmt    = new Intl.DateTimeFormat("en-IN", { timeZone: IST, hour: "numeric", minute: "2-digit", hour12: true });
const istWeekdayFmt = new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "short" });
const istShortFmt   = new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "numeric", month: "short" });

function istDayStart(d: Date): number {
  return Date.parse(istDayFmt.format(d));
}

/** "11:20a" (today) · "Yest" · "Thu" (this week) · "12 Jul" (older). */
function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";

  const days = Math.round((istDayStart(new Date()) - istDayStart(d)) / 86_400_000);

  if (days <= 0) {
    const parts = istTimeFmt.formatToParts(d);
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
    const suffix = get("dayPeriod").toLowerCase().startsWith("a") ? "a" : "p";
    return `${get("hour")}:${get("minute")}${suffix}`;
  }
  if (days === 1) return "Yest";
  if (days < 7) return istWeekdayFmt.format(d);
  return istShortFmt.format(d);
}
