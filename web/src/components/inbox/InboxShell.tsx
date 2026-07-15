"use client";

// Unified inbox shell — 2-column layout: filterable thread list on the left,
// a tabbed thread pane on the right. Polls the thread list every 30s (paused
// when the tab is hidden). Open thread polls every 10s inside <ThreadView>.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/Icon";
import { AnchoredPopover } from "@/components/ui/AnchoredPopover";
import { cn } from "@/lib/cn";
import { getGmailStatus, getTwConversationCounts, getTwConversations } from "@/lib/api";
import { avatarGradClass, gradFor, initialsOf, ratingStyles } from "@/lib/ui";
import {
  LEAD_RATINGS,
  type GmailStatus,
  type LeadRating,
  type TwChannel,
  type TwConversationCounts,
  type TwConversationListItem,
  type TwInboxFilter,
} from "@/lib/types";
import { ThreadList } from "./ThreadList";
import { ThreadView } from "./ThreadView";
import { ComposeEmailDialog } from "./ComposeEmailDialog";
import { ConnectGmailPrompt } from "@/components/record/ConnectGmailPrompt";

const LIST_POLL_MS = 30_000;

/** How many conversations can be open as tabs at once. Past ~6 the strip stops
 *  fitting and the tabs stop being readable, so the oldest one gets evicted. */
const MAX_OPEN_TABS = 6;

/** "all" is the shell's own pseudo-channel — the API models it as "no channel
 *  filter", so it never reaches TwInboxFilter. */
type InboxChannel = TwChannel | "all";

/** Who the list is narrowed to. `mine` maps to assignee="me"; `unread` and
 *  `all` don't touch assignee at all. */
type Scope = "unread" | "mine" | "all";

type Sort = NonNullable<TwInboxFilter["sort"]>;

export interface InboxAdvisor {
  id: string;
  name: string;
}

function channelFromParam(v: string | null): InboxChannel {
  if (v === "voice" || v === "email" || v === "whatsapp" || v === "sms") return v;
  return "all";
}

const SEARCH_PLACEHOLDER: Record<InboxChannel, string> = {
  all:      "Search conversations…",
  whatsapp: "Search WhatsApp threads…",
  voice:    "Search call threads…",
  email:    "Search email threads…",
  sms:      "Search SMS threads…",
};

const SORT_OPTIONS: ReadonlyArray<{ value: Sort; label: string }> = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "unread", label: "Unread first" },
];

export function InboxShell({
  initialConversations,
  advisors,
  canSend,
  canPromote,
  canUpload = false,
  canAddToLibrary = false,
}: {
  initialConversations: TwConversationListItem[];
  advisors: InboxAdvisor[];
  canSend: boolean;
  canPromote: boolean;
  canUpload?: boolean;
  canAddToLibrary?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [threads, setThreads] = useState(initialConversations);

  // Filters. `channel` and the open tabs are seeded from the URL so a hard
  // refresh comes back to what the user was looking at.
  const [channel, setChannel] = useState<InboxChannel>(() =>
    channelFromParam(searchParams.get("channel")),
  );
  const [scope, setScope]     = useState<Scope>("all");
  const [advisor, setAdvisor] = useState<string>("all");
  const [rating, setRating]   = useState<LeadRating | "all">("all");
  const [sort, setSort]       = useState<Sort>("newest");
  const [q, setQ]             = useState("");

  const [openIds, setOpenIds] = useState<string[]>(() => {
    const raw = searchParams.get("open");
    const ids = raw ? raw.split(",").filter(Boolean) : [];
    const t = searchParams.get("t");
    if (t && !ids.includes(t)) ids.unshift(t);
    if (ids.length > 0) return ids.slice(0, MAX_OPEN_TABS);
    const first = initialConversations[0]?.id;
    return first ? [first] : [];
  });
  const [activeId, setActiveId] = useState<string | null>(() => {
    const t = searchParams.get("t");
    if (t) return t;
    const raw = searchParams.get("open");
    const first = raw?.split(",").filter(Boolean)[0];
    return first ?? initialConversations[0]?.id ?? null;
  });

  // Open tabs outlive the filter that surfaced them: switching to the Email
  // tab must not blank a WhatsApp thread the user still has open. So every
  // conversation the list has ever handed us is kept here, and the tab strip
  // and <ThreadView> read summaries from this cache, not from `threads`.
  const summariesRef = useRef<Map<string, TwConversationListItem>>(
    new Map(initialConversations.map((c) => [c.id, c])),
  );
  const [summaryVersion, setSummaryVersion] = useState(0);
  const rememberSummaries = useCallback((rows: TwConversationListItem[]) => {
    for (const r of rows) summariesRef.current.set(r.id, r);
    setSummaryVersion((v) => v + 1);
  }, []);

  const [counts, setCounts] = useState<TwConversationCounts>({ all: 0, allUnread: 0, byChannel: {} });

  // Gmail connection state — only needed for the Email tab, so we fetch it
  // lazily the first time someone opens it. Without a connected mailbox the
  // Email tab is permanently empty, so we surface a Connect prompt rather than
  // leaving the user staring at a blank list with no explanation.
  const [gmail, setGmail] = useState<GmailStatus | null>(null);
  const loadGmail = useCallback(() => {
    void getGmailStatus().then(setGmail).catch(() => {});
  }, []);
  useEffect(() => {
    if (channel === "email" && !gmail) loadGmail();
  }, [channel, gmail, loadGmail]);
  const noMailbox = channel === "email" && gmail !== null && !gmail.connected && !gmail.shared;
  // Which mailbox a send leaves from — mirrors the API's resolution order in
  // routes/gmail.ts: the user's own connected account, else the shared one.
  const senderEmail = gmail?.account?.email ?? gmail?.shared ?? null;
  const canCompose = channel === "email" && canSend && !!senderEmail;
  const [composeOpen, setComposeOpen] = useState(false);

  // Everything except the channel. The tab counts are fetched with exactly
  // this, so each tab's number is what clicking it would actually show.
  const baseFilter = useMemo<TwInboxFilter>(() => {
    const f: TwInboxFilter = { sort };
    // An explicit advisor beats the "Assigned to me" segment — picking a name
    // from the dropdown is the more specific intent of the two.
    if (advisor !== "all") f.assignee = advisor;
    else if (scope === "mine") f.assignee = "me";
    if (scope === "unread") f.unread = true;
    if (rating !== "all") f.rating = rating;
    if (q.trim()) f.q = q.trim();
    return f;
  }, [scope, advisor, rating, sort, q]);

  // Keep the channel + active thread + open tabs in the URL. "all" is the
  // default channel so it's omitted. `replace` so tab clicks don't fill the
  // browser history with junk entries.
  useEffect(() => {
    const desiredChannel = channel === "all" ? null : channel;
    const desiredOpen    = openIds.length > 0 ? openIds.join(",") : null;
    if (
      searchParams.get("channel") === desiredChannel &&
      searchParams.get("t") === activeId &&
      searchParams.get("open") === desiredOpen
    ) return;
    const next = new URLSearchParams(searchParams.toString());
    if (desiredChannel) next.set("channel", desiredChannel); else next.delete("channel");
    if (activeId)       next.set("t", activeId);             else next.delete("t");
    if (desiredOpen)    next.set("open", desiredOpen);       else next.delete("open");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [channel, activeId, openIds, pathname, router, searchParams]);

  const refresh = useCallback(async () => {
    const filter: TwInboxFilter = { ...baseFilter };
    if (channel !== "all") filter.channel = channel;
    const rows = await getTwConversations(filter).catch(() => null);
    if (!rows) return;
    setThreads(rows);
    rememberSummaries(rows);
  }, [baseFilter, channel, rememberSummaries]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    void getTwConversationCounts(baseFilter).then(setCounts);
  }, [baseFilter]);

  // Poll every 30s, paused on hidden tab.
  useEffect(() => {
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh();
    }, LIST_POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const openThread = useCallback((id: string) => {
    setActiveId(id);
    setOpenIds((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      // Evict from the front, but never the tab the user is looking at.
      while (next.length > MAX_OPEN_TABS) {
        const victim = next.find((x) => x !== id);
        if (!victim) break;
        next.splice(next.indexOf(victim), 1);
      }
      return next;
    });
  }, []);

  const closeThread = useCallback((id: string) => {
    setOpenIds((prev) => {
      const idx = prev.indexOf(id);
      if (idx < 0) return prev;
      const next = prev.filter((x) => x !== id);
      setActiveId((cur) => {
        if (cur !== id) return cur;
        // Prefer the neighbour to the left, so closing a run of tabs walks
        // backwards instead of jumping to the far end each time.
        return next[idx - 1] ?? next[idx] ?? null;
      });
      return next;
    });
  }, []);

  const summaries = summariesRef.current;
  const activeThread = useMemo(
    () => (activeId ? summaries.get(activeId) ?? null : null),
    // summaryVersion is the invalidation signal for the mutable ref above.
    [activeId, summaries, summaryVersion],
  );
  const openTabs = useMemo(
    () => openIds.map((id) => summaries.get(id)).filter((t): t is TwConversationListItem => !!t),
    [openIds, summaries, summaryVersion],
  );

  const advisorLabel = advisor === "all"
    ? "All"
    : advisors.find((a) => a.id === advisor)?.name ?? "All";

  return (
    <div className="flex h-[calc(100vh-140px)] flex-col gap-4">
      {/* Full-width flat header — channel tabs + filters span the whole inbox,
          not the 380px list column, so switching channel/filter reads as a page
          control rather than a list widget. */}
      <div className="flex-shrink-0">
        <div className="flex items-center gap-1 border-b border-rule">
          <ChannelTab
            active={channel === "all"} onClick={() => setChannel("all")}
            label="All" count={counts.all}
          />
          <ChannelTab
            active={channel === "whatsapp"} onClick={() => setChannel("whatsapp")}
            icon="chat" label="WhatsApp" count={counts.byChannel.whatsapp?.total ?? 0}
          />
          <ChannelTab
            active={channel === "email"} onClick={() => setChannel("email")}
            icon="mail" label="Email" count={counts.byChannel.email?.total ?? 0}
          />
          <ChannelTab
            active={channel === "voice"} onClick={() => setChannel("voice")}
            icon="phone" label="Calls" count={counts.byChannel.voice?.total ?? 0}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center rounded-full border border-rule bg-warm/40 p-0.5">
            <ScopeSegment active={scope === "unread"} onClick={() => setScope("unread")} label="Unread" />
            <ScopeSegment active={scope === "mine"}   onClick={() => setScope("mine")}   label="Assigned to me" />
            <ScopeSegment active={scope === "all"}    onClick={() => setScope("all")}    label="All" />
          </div>
          <SelectPill
            label="Advisor"
            current={advisorLabel}
            active={advisor !== "all"}
            choices={[
              { value: "all", label: "All" },
              ...advisors.map((a) => ({ value: a.id, label: a.name })),
            ]}
            value={advisor}
            onChange={setAdvisor}
          />
          <SelectPill
            label="Rating"
            current={rating === "all" ? "Any" : ratingStyles[rating].label}
            active={rating !== "all"}
            choices={[
              { value: "all", label: "Any" },
              ...LEAD_RATINGS.map((r) => ({ value: r, label: ratingStyles[r].label })),
            ]}
            value={rating}
            onChange={(v) => setRating(v === "all" ? "all" : (v as LeadRating))}
          />
          <SelectPill
            label="Sort"
            current={SORT_OPTIONS.find((o) => o.value === sort)?.label ?? "Newest"}
            active={sort !== "newest"}
            choices={SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            value={sort}
            onChange={(v) => setSort(v as Sort)}
          />
        </div>
      </div>

      {/* Body — list + thread, below the shared header. */}
      <div className="grid min-h-0 flex-1 grid-cols-[380px_1fr] gap-4">
      <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-rule bg-paper">
        <div className="flex-shrink-0 border-b border-rule p-3">
          {/* Compose — the only way to email an address that has no thread and
              no lead record yet. Email-only: SMS/WhatsApp/voice all require an
              existing contact to send to. */}
          {canCompose && (
            <button
              type="button"
              onClick={() => setComposeOpen(true)}
              className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-[10px] bg-brand-blue px-3 py-2 text-[12.5px] font-semibold text-white transition hover:bg-brand-blue/90"
            >
              <Icon name="plus" size={12} strokeWidth={2.4} />
              New email
            </button>
          )}
          <div className="flex items-center gap-2 rounded-[10px] border border-rule bg-warm/40 px-2.5 py-1.5">
            <Icon name="search" size={12} strokeWidth={2} className="text-mute" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={SEARCH_PLACEHOLDER[channel]}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink placeholder:text-hint outline-none"
            />
          </div>
        </div>

        <ThreadList threads={threads} activeId={activeId} onSelect={openThread} />
      </div>

      <div className="flex min-h-0 flex-col">
        {openTabs.length > 0 && (
          <div className="flex items-end gap-1 overflow-x-auto pb-0">
            {openTabs.map((t) => (
              <ThreadTab
                key={t.id}
                thread={t}
                active={t.id === activeId}
                onClick={() => setActiveId(t.id)}
                onClose={() => closeThread(t.id)}
              />
            ))}
          </div>
        )}

        <div
          className={cn(
            "min-h-0 flex-1 overflow-hidden border border-rule bg-paper",
            openTabs.length > 0 ? "rounded-b-2xl rounded-tr-2xl" : "rounded-2xl",
          )}
        >
          {noMailbox ? (
            <div className="flex h-full items-center justify-center p-10">
              <div className="w-full max-w-[460px]">
                <ConnectGmailPrompt status={gmail} onChanged={loadGmail} />
              </div>
            </div>
          ) : activeThread ? (
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
                <Icon
                  name={channel === "email" ? "mail" : "message-square"}
                  size={28}
                  strokeWidth={1.5}
                  className="mx-auto mb-3 text-hint"
                />
                <div className="font-serif text-[20px] text-ink">No thread selected</div>
                <div className="mt-1 text-[12.5px]">
                  Pick a conversation from the list, or wait for a new message to arrive.
                </div>
                {canCompose && (
                  <button
                    type="button"
                    onClick={() => setComposeOpen(true)}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-brand-blue px-3 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-brand-blue/90"
                  >
                    <Icon name="plus" size={12} strokeWidth={2.4} />
                    New email
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      </div>

      {composeOpen && (
        <ComposeEmailDialog
          senderEmail={senderEmail}
          onClose={() => setComposeOpen(false)}
          onSent={async (conversationId) => {
            setComposeOpen(false);
            // The send created (or reused) a conversation. Clear the search box
            // first — an active query would filter the new thread straight back
            // out on the next poll — then refresh and open it, so the mail
            // doesn't vanish into a thread the user has to go hunting for.
            setQ("");
            const rows = await getTwConversations({ channel: "email" }).catch(() => null);
            if (rows) {
              setThreads(rows);
              rememberSummaries(rows);
            }
            openThread(conversationId);
          }}
        />
      )}
    </div>
  );
}

/** Underline channel tab with a count, matching the leads ViewTabs strip. */
function ChannelTab({
  active, onClick, icon, label, count,
}: {
  active: boolean;
  onClick: () => void;
  icon?: IconName;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-[12.5px] font-semibold transition",
        active ? "border-brand-violet text-brand-violet" : "border-transparent text-ink2 hover:text-ink",
      )}
    >
      {icon && <Icon name={icon} size={12} strokeWidth={2.2} />}
      <span>{label}</span>
      <span className={cn("mono-cap text-[10px] tracking-[.04em]", active ? "text-brand-violet/80" : "text-mute")}>
        {count}
      </span>
    </button>
  );
}

function ScopeSegment({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition",
        active ? "bg-ink text-white" : "text-mute hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}

/** Toolbar dropdown pill — same shape as the leads toolbar's SelectPill, but
 *  driven by a flat choice list because the inbox's filters aren't a FilterState. */
function SelectPill({
  label, current, active, choices, value, onChange,
}: {
  label: string;
  current: string;
  active: boolean;
  choices: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition",
          active
            ? "border-brand-violet bg-brand-violet/10 text-brand-violet"
            : "border-rule bg-paper text-ink2 hover:border-rule2 hover:text-ink",
        )}
      >
        <span className="mono-cap text-[9.5px] tracking-[.08em] text-mute">{label}:</span>
        <span>{current}</span>
        <span className="text-[9px] text-mute">▾</span>
      </button>
      {open && (
        <AnchoredPopover anchor={ref.current} className="max-h-[320px] min-w-[180px] overflow-y-auto">
          {choices.map((c, i) => (
            <div key={c.value}>
              {i === 1 && <div className="my-1 border-t border-rule" />}
              <button
                type="button"
                onClick={() => { onChange(c.value); setOpen(false); }}
                className={cn(
                  "block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-warm",
                  value === c.value && "bg-warm font-semibold",
                )}
              >
                {c.label}
              </button>
            </div>
          ))}
        </AnchoredPopover>
      )}
    </div>
  );
}

/** One open conversation in the strip above the thread pane. */
function ThreadTab({
  thread, active, onClick, onClose,
}: {
  thread: TwConversationListItem;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  const firstName = (thread.partyName ?? "").trim().split(/\s+/)[0] || "Thread";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick(); }}
      className={cn(
        "group inline-flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-semibold transition",
        active
          ? "rounded-t-[10px] border border-b-0 border-rule bg-paper text-ink"
          : "text-mute hover:text-ink",
      )}
      title={thread.partyName}
    >
      <span
        className={cn(
          "flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[8px] font-bold text-white",
          avatarGradClass[gradFor(thread.partyId)],
        )}
      >
        {initialsOf(thread.partyName)}
      </span>
      <span className="max-w-[90px] truncate">{firstName}</span>
      {thread.unreadCount > 0 && (
        <span className="rounded-full bg-brand-magenta px-1.5 py-px font-mono text-[9px] font-bold text-white">
          {thread.unreadCount}
        </span>
      )}
      <span
        role="button"
        tabIndex={-1}
        aria-label={`Close ${firstName}`}
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="ml-0.5 rounded p-0.5 text-hint hover:bg-warm2 hover:text-ink"
      >
        <Icon name="plus" size={10} strokeWidth={2.6} className="rotate-45" />
      </span>
    </div>
  );
}
