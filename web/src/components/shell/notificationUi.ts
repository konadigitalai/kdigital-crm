// Shared presentation for inbound notifications, used by both the toast and the
// bell dropdown so their labels, icons and colours can't drift apart.

import type { IconName } from "@/components/ui/Icon";
import type { InboundEvent, TwChannel } from "@/lib/types";

export const CHANNEL_UI: Record<
  TwChannel,
  { label: string; icon: IconName; bg: string; text: string }
> = {
  voice:    { label: "Call",     icon: "phone",          bg: "bg-brand-magenta", text: "text-brand-magenta" },
  whatsapp: { label: "WhatsApp", icon: "chat",           bg: "bg-state-ok",      text: "text-state-ok" },
  email:    { label: "Email",    icon: "mail",           bg: "bg-brand-blue",    text: "text-brand-blue" },
  sms:      { label: "SMS",      icon: "message-square", bg: "bg-mute",          text: "text-mute" },
};

export function channelUi(channel: TwChannel) {
  return CHANNEL_UI[channel] ?? CHANNEL_UI.whatsapp;
}

/** The bold title line. Calls lead with the event ("Incoming call · Mohd Suhail")
 *  because the call itself is the news; messages lead with the person. */
export function notifTitle(e: InboundEvent): string {
  if (e.channel === "voice") return `Incoming call · ${e.partyName}`;
  return `${e.partyName} · ${channelUi(e.channel).label}`;
}

export function notifPreview(e: InboundEvent): string {
  return (
    e.body?.trim() ||
    (e.channel === "voice" ? "Tap to view the call" : "Sent an attachment")
  );
}

// Short "time since" — "now" / "3m" / "2h", else the IST clock time. Note this
// reads the clock at render, so a re-render refreshes it.
const istTimeFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true,
});
export function notifTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 45) return "now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`;
  const parts = istTimeFmt.formatToParts(new Date(t));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("dayPeriod").toLowerCase()}`;
}

/** The inbox deep-link for a notification. */
export function notifHref(e: InboundEvent): string {
  return `/inbox?channel=${e.channel}&t=${encodeURIComponent(e.conversationId)}`;
}
