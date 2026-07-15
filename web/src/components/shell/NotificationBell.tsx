"use client";

// Topbar bell. Shows the unread count from NotificationProvider; opening the
// dropdown clears the count and lists recent inbound calls / WhatsApp messages.
// Each row opens that conversation in the inbox.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/Icon";
import { AnchoredPopover } from "@/components/ui/AnchoredPopover";
import { cn } from "@/lib/cn";
import { avatarGradClass, gradFor, initialsOf } from "@/lib/ui";
import { useNotifications } from "./NotificationProvider";
import type { InboundEvent, TwChannel } from "@/lib/types";

const CHANNEL_UI: Record<
  TwChannel,
  { label: string; icon: IconName; dot: string; text: string }
> = {
  voice:    { label: "Incoming call", icon: "phone",          dot: "bg-brand-magenta", text: "text-brand-magenta" },
  whatsapp: { label: "WhatsApp",      icon: "chat",           dot: "bg-state-ok",      text: "text-state-ok" },
  email:    { label: "New email",     icon: "mail",           dot: "bg-brand-blue",    text: "text-brand-blue" },
  sms:      { label: "SMS",           icon: "message-square", dot: "bg-mute",          text: "text-mute" },
};

export function NotificationBell() {
  const { enabled, unread, events, markAllSeen } = useNotifications();
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
      // Opening the panel is the "I've seen them" signal — clear the badge.
      if (next) markAllSeen();
      return next;
    });
  }

  function openEvent(event: InboundEvent) {
    setOpen(false);
    router.push(`/inbox?channel=${event.channel}&t=${encodeURIComponent(event.conversationId)}`);
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
          <div className="flex items-center justify-between border-b border-rule px-3.5 py-2.5">
            <span className="mono-cap text-[10px] font-semibold tracking-[.1em] text-ink">Notifications</span>
            <span className="mono-cap text-[9px] tracking-[.08em] text-hint">Calls · WhatsApp</span>
          </div>

          {events.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <Icon name="bell" size={22} strokeWidth={1.6} className="mx-auto mb-2 text-hint" />
              <div className="text-[12.5px] text-mute">You&apos;re all caught up.</div>
              <div className="mt-0.5 text-[11px] text-hint">New calls and messages show up here.</div>
            </div>
          ) : (
            <div className="max-h-[380px] overflow-y-auto py-1">
              {events.map((e) => (
                <EventRow key={e.id} event={e} onClick={() => openEvent(e)} />
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => { setOpen(false); router.push("/inbox"); }}
            className="block w-full border-t border-rule px-3.5 py-2 text-center text-[11.5px] font-semibold text-brand-violet hover:bg-warm"
          >
            Open inbox
          </button>
        </AnchoredPopover>
      )}
    </div>
  );
}

function EventRow({ event, onClick }: { event: InboundEvent; onClick: () => void }) {
  const ui = CHANNEL_UI[event.channel] ?? CHANNEL_UI.whatsapp;
  const preview =
    event.body?.trim() ||
    (event.channel === "voice" ? "Tap to view the call" : "Sent an attachment");

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition hover:bg-warm"
    >
      <span className="relative flex-shrink-0">
        <span
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-full text-[11px] font-bold text-white",
            avatarGradClass[gradFor(event.conversationId)],
          )}
        >
          {initialsOf(event.partyName)}
        </span>
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 flex h-[15px] w-[15px] items-center justify-center rounded-full text-white ring-2 ring-paper",
            ui.dot,
          )}
        >
          <Icon name={ui.icon} size={8} strokeWidth={2.6} />
        </span>
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn("mono-cap text-[8.5px] font-semibold tracking-[.1em]", ui.text)}>{ui.label}</span>
          <span className="ml-auto flex-shrink-0 text-[10px] text-hint">{fmtTime(event.sentAt)}</span>
        </div>
        <div className="mt-0.5 truncate text-[12.5px] font-semibold text-ink">{event.partyName}</div>
        <div className="mt-0.5 truncate text-[11.5px] text-mute">{preview}</div>
      </div>
    </button>
  );
}

// IST time, same reasoning as the rest of the app.
const istTimeFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true,
});
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = istTimeFmt.formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("dayPeriod").toLowerCase()}`;
}
