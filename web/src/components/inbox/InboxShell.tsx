"use client";

// Unified inbox shell — 2-column layout: thread list on the left, thread
// view on the right. Polls the thread list every 30s (paused when the tab
// is hidden). Open thread polls every 10s inside <ThreadView>.

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { getTwConversations } from "@/lib/api";
import type { TwChannel, TwConversationListItem } from "@/lib/types";
import { ThreadList } from "./ThreadList";
import { ThreadView } from "./ThreadView";

const LIST_POLL_MS = 30_000;

// Persist the active channel tab in `?channel=voice` so a hard-refresh
// restores what the user was looking at. Same-origin `whatsapp` is the
// default and is omitted from the URL to keep it clean.
function channelFromParam(v: string | null): TwChannel {
  return v === "voice" ? "voice" : "whatsapp";
}

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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [threads, setThreads] = useState(initialConversations);
  // Seed the selected thread from `?t=<id>` when present; otherwise open
  // the first thread the list returns. If the URL id no longer exists in
  // the current channel's threads, `activeThread` below falls through to
  // "No thread selected" — better than silently opening the wrong one.
  const [activeId, setActiveId] = useState<string | null>(() => {
    const fromUrl = searchParams.get("t");
    if (fromUrl && initialConversations.some((t) => t.id === fromUrl)) return fromUrl;
    return initialConversations[0]?.id ?? null;
  });
  // Inbox is now a two-tab surface — WhatsApp OR Voice calls. SMS traffic is
  // still supported by the API but not surfaced here (the FE stopped showing
  // an SMS tab after Twilio SMS was deprioritised in favour of WA templates).
  // Assignee filtering is gone too — operators wanted a simpler view.
  //
  // Seed from `?channel=` so a hard-refresh on Calls comes back to Calls.
  const [channel, setChannel] = useState<TwChannel>(() =>
    channelFromParam(searchParams.get("channel")),
  );
  const [q, setQ] = useState("");

  // Push the current channel + active thread into the URL. `whatsapp` is
  // the default channel so it's omitted from the URL; `t` is omitted when
  // no thread is selected. Use `replace` so tab / thread clicks don't fill
  // the browser history with junk entries.
  useEffect(() => {
    const currentChannel = searchParams.get("channel");
    const currentT       = searchParams.get("t");
    const desiredChannel = channel === "whatsapp" ? null : channel;
    const desiredT       = activeId;
    if (currentChannel === desiredChannel && currentT === desiredT) return;
    const next = new URLSearchParams(searchParams.toString());
    if (desiredChannel) next.set("channel", desiredChannel); else next.delete("channel");
    if (desiredT)       next.set("t",       desiredT);       else next.delete("t");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [channel, activeId, pathname, router, searchParams]);

  const refresh = useCallback(async () => {
    const filter: Parameters<typeof getTwConversations>[0] = {};
    filter.channel = channel;
    if (q.trim()) filter.q = q.trim();
    const rows = await getTwConversations(filter).catch(() => null);
    if (!rows) return;
    setThreads(rows);
    // If the current selection isn't in the freshly-filtered list (e.g.
    // user switched channel, or the thread was deleted), fall back to the
    // top thread. Preserves selection whenever the id still shows up.
    setActiveId((prev) => (prev && rows.some((r) => r.id === prev) ? prev : rows[0]?.id ?? null));
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
