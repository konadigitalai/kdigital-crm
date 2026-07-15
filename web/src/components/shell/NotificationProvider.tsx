"use client";

// App-wide inbound-notification store. Lives in AppShellClient (which does NOT
// remount on client-side navigation), so the unread count survives moving
// between pages. Polls /twilio/inbound-events on a short interval and collects
// new inbound calls + WhatsApp messages; the bell in the Topbar reads from here.
//
// Count-only by design (per the current spec): no toast, no quick reply. The
// bell shows how many arrived, its dropdown lists them, clicking one opens the
// thread.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { getInboundEvents } from "@/lib/api";
import type { InboundEvent, TwChannel } from "@/lib/types";

const POLL_MS = 8_000;
// Every inbound channel raises a notification: Exotel calls, Twilio WhatsApp/SMS,
// and Gmail. The endpoint already returns them all; this is just the gate.
const NOTIFY_CHANNELS = new Set<TwChannel>(["voice", "whatsapp", "email", "sms"]);
// Keep the dropdown list bounded — it's a "recent", not an archive.
const MAX_KEPT = 30;

interface NotificationState {
  enabled: boolean;
  /** Events not yet seen — drives the bell's count badge. */
  unread: number;
  /** Recent inbound events, newest first, for the dropdown. */
  events: InboundEvent[];
  /** Zero the badge (called when the dropdown opens). */
  markAllSeen: () => void;
}

const Ctx = createContext<NotificationState>({
  enabled: false,
  unread: 0,
  events: [],
  markAllSeen: () => {},
});

export function useNotifications() {
  return useContext(Ctx);
}

export function NotificationProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  const [events, setEvents] = useState<InboundEvent[]>([]);
  const [unread, setUnread] = useState(0);

  // Only events strictly newer than this become notifications. Seeded to mount
  // time so the existing backlog doesn't count as "new" on first load.
  const sinceRef = useRef<string>(new Date().toISOString());
  const seenIdsRef = useRef<Set<string>>(new Set());

  const markAllSeen = useCallback(() => setUnread(0), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    async function tick() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const incoming = await getInboundEvents(sinceRef.current);
      if (cancelled || incoming.length === 0) return;

      // Advance the cursor past everything returned — including non-notifying
      // channels — so the same rows aren't re-fetched every poll.
      sinceRef.current = incoming.reduce(
        (max, e) => (e.sentAt > max ? e.sentAt : max),
        sinceRef.current,
      );

      const fresh = incoming.filter(
        (e) => NOTIFY_CHANNELS.has(e.channel) && !seenIdsRef.current.has(e.id),
      );
      if (fresh.length === 0) return;
      for (const e of fresh) seenIdsRef.current.add(e.id);

      setEvents((prev) => [...fresh.reverse(), ...prev].slice(0, MAX_KEPT));
      setUnread((n) => n + fresh.length);
    }

    const interval = setInterval(tick, POLL_MS);
    // Catch up the moment the tab is refocused after being hidden.
    function onVisible() { if (document.visibilityState === "visible") void tick(); }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);

  return (
    <Ctx.Provider value={{ enabled, unread, events, markAllSeen }}>
      {children}
    </Ctx.Provider>
  );
}
