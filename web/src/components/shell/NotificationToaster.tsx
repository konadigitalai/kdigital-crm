"use client";

// Transient bottom-right toasts for inbound notifications. Sits alongside the
// bell: each new event pops a toast for 5s, stacking below any already showing,
// then disappears. The bell's count is entirely separate — a dismissed toast
// does NOT lower it; the count clears only when the bell is opened.
//
// Reads from NotificationProvider and toasts each event once (tracked by id),
// so a re-render or a poll that re-returns a row can't double-toast.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { useNotifications } from "./NotificationProvider";
import { channelUi, notifHref, notifPreview, notifTitle } from "./notificationUi";
import type { InboundEvent } from "@/lib/types";

const VISIBLE_MS = 5_000;
// A burst shouldn't wall off the screen — keep only the most recent few.
const MAX_TOASTS = 4;

interface Toast {
  event: InboundEvent;
  leaving?: boolean;
}

export function NotificationToaster() {
  const { enabled, events } = useNotifications();
  const router = useRouter();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastedRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.map((t) => (t.event.id === id ? { ...t, leaving: true } : t)));
    const t = timersRef.current.get(id);
    if (t) clearTimeout(t);
    timersRef.current.set(id, setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.event.id !== id));
      timersRef.current.delete(id);
    }, 200));
  }, []);

  // Watch the provider's event list; toast anything we haven't shown yet.
  // `events` is newest-first; prepend so the newest sits at the top of the
  // top-anchored stack, and keep only the most recent MAX_TOASTS.
  useEffect(() => {
    const fresh = events.filter((e) => !toastedRef.current.has(e.id));
    if (fresh.length === 0) return;
    for (const e of fresh) toastedRef.current.add(e.id);
    setToasts((prev) => [...fresh.map((event) => ({ event })), ...prev].slice(0, MAX_TOASTS));
    for (const e of fresh) {
      timersRef.current.set(e.id, setTimeout(() => dismiss(e.id), VISIBLE_MS));
    }
  }, [events, dismiss]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); };
  }, []);

  if (!enabled || toasts.length === 0 || typeof document === "undefined") return null;

  function open(event: InboundEvent) {
    dismiss(event.id);
    router.push(notifHref(event));
  }

  return createPortal(
    // Top-right, below the topbar (which is ~58px tall). Newest ends up at the
    // top of the stack so the freshest is nearest the bell it corresponds to.
    <div className="pointer-events-none fixed right-6 top-[76px] z-[100] flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2.5">
      {toasts.map((t) => (
        <ToastCard
          key={t.event.id}
          toast={t}
          onOpen={() => open(t.event)}
          onClose={() => dismiss(t.event.id)}
        />
      ))}
    </div>,
    document.body,
  );
}

function ToastCard({ toast, onOpen, onClose }: { toast: Toast; onOpen: () => void; onClose: () => void }) {
  const { event, leaving } = toast;
  const ui = channelUi(event.channel);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
      className={cn(
        "pointer-events-auto flex cursor-pointer items-start gap-3 rounded-2xl border border-rule bg-paper p-3.5 shadow-card transition hover:-translate-y-0.5 hover:shadow-glow",
        leaving ? "toast-leave" : "toast-enter",
      )}
    >
      <span className={cn("flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-white", ui.bg)}>
        <Icon name={ui.icon} size={16} strokeWidth={2.2} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-bold text-ink">{notifTitle(event)}</div>
        <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-mute">{notifPreview(event)}</div>
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Dismiss"
        className="-mr-1 -mt-1 flex-shrink-0 rounded-md p-1 text-hint transition hover:bg-warm hover:text-ink"
      >
        <Icon name="plus" size={13} strokeWidth={2.4} className="rotate-45" />
      </button>
    </div>
  );
}
