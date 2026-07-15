"use client";

// Topbar bell. Shows the unread count from NotificationProvider; opening the
// dropdown clears the count and lists recent inbound calls / messages. Each row
// opens that conversation in the inbox. "Clear all" empties the list + count.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { AnchoredPopover } from "@/components/ui/AnchoredPopover";
import { cn } from "@/lib/cn";
import { useNotifications } from "./NotificationProvider";
import { channelUi, notifHref, notifPreview, notifTime, notifTitle } from "./notificationUi";
import type { InboundEvent } from "@/lib/types";

export function NotificationBell() {
  const { enabled, unread, events, markAllSeen, clearAll } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!enabled) return null;

  function toggle() {
    setOpen((o) => {
      const next = !o;
      if (next) markAllSeen(); // opening the panel is the "seen" signal
      return next;
    });
  }

  function openEvent(event: InboundEvent) {
    setOpen(false);
    router.push(notifHref(event));
  }

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={toggle}
        aria-label={unread > 0 ? `${unread} new notifications` : "Notifications"}
        className={cn(
          "relative flex h-9 w-9 items-center justify-center rounded-full border transition",
          open
            ? "border-brand-violet bg-brand-violet/10 text-brand-violet"
            : "border-rule bg-paper text-ink2 hover:border-rule2 hover:text-ink",
        )}
      >
        <Icon name="bell" size={16} strokeWidth={2} />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand-magenta px-1 font-mono text-[10px] font-bold leading-none text-white ring-2 ring-canvas">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <AnchoredPopover anchor={ref.current} align="right" className="w-[340px]">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-[13px] font-bold text-ink">Notifications</span>
            {events.length > 0 && (
              <button
                type="button"
                onClick={clearAll}
                className="text-[12px] font-semibold text-brand-violet hover:underline"
              >
                Clear all
              </button>
            )}
          </div>

          {events.length === 0 ? (
            <div className="px-4 pb-8 pt-2 text-center">
              <Icon name="bell" size={22} strokeWidth={1.6} className="mx-auto mb-2 text-hint" />
              <div className="text-[12.5px] text-mute">You&apos;re all caught up.</div>
              <div className="mt-0.5 text-[11px] text-hint">New calls and messages show up here.</div>
            </div>
          ) : (
            <div className="max-h-[400px] overflow-y-auto border-t border-rule">
              {events.map((e) => (
                <EventRow key={e.id} event={e} onClick={() => openEvent(e)} />
              ))}
            </div>
          )}
        </AnchoredPopover>
      )}
    </div>
  );
}

function EventRow({ event, onClick }: { event: InboundEvent; onClick: () => void }) {
  const ui = channelUi(event.channel);
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-3 border-b border-rule/60 px-4 py-3 text-left transition last:border-b-0 hover:bg-warm/60"
    >
      <span className={cn("flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-white", ui.bg)}>
        <Icon name={ui.icon} size={16} strokeWidth={2.2} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[12.5px] font-bold text-ink">{notifTitle(event)}</span>
          <span className="ml-auto flex-shrink-0 text-[10px] text-hint">{notifTime(event.sentAt)}</span>
        </div>
        <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-mute">{notifPreview(event)}</div>
      </div>
    </button>
  );
}
