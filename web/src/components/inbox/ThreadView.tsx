"use client";

// Thread pane: header + message bubbles + reply box.
// Polls thread detail every 10s while active + tab visible.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  getTwConversation,
  markTwConversationRead,
  promoteTwConversationToLead,
} from "@/lib/api";
import type { TwConversationDetail, TwConversationListItem, TwMessage } from "@/lib/types";
import { ReplyBox } from "./ReplyBox";
import { MessageMediaGallery } from "@/components/media/MessageMediaGallery";
import { linkify } from "./linkify";
import { CHAT_BG_DATA_URL } from "./chatBg";
import { NewLeadDialog } from "@/components/leads/NewLeadDialog";
import { CallButton } from "@/components/record/CallButton";

const DETAIL_POLL_MS = 10_000;

export function ThreadView({
  threadId, summary, canSend, canPromote, canUpload = false, canAddToLibrary = false, onRefreshList,
}: {
  threadId: string;
  summary: TwConversationListItem;
  canSend: boolean;
  canPromote: boolean;
  canUpload?: boolean;
  canAddToLibrary?: boolean;
  onRefreshList: () => void;
}) {
  const [detail, setDetail] = useState<TwConversationDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchDetail = useCallback(async () => {
    try {
      const d = await getTwConversation(threadId);
      setDetail(d);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [threadId]);

  // Initial load + mark-read on open.
  useEffect(() => {
    void fetchDetail();
    void markTwConversationRead(threadId).catch(() => {});
  }, [fetchDetail, threadId]);

  // Poll every 10s while tab is visible.
  useEffect(() => {
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void fetchDetail();
    }, DETAIL_POLL_MS);
    return () => clearInterval(t);
  }, [fetchDetail]);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [detail?.messages.length]);

  // Split the summary's E.164 partyPhone into (cc, local) so we can seed
  // the New Lead dialog's split inputs. Falls back to sensible defaults
  // if the phone shape is unexpected.
  function splitPhone(e164: string | null | undefined): { cc: string; local: string } {
    const s = (e164 ?? "").trim();
    if (!s.startsWith("+")) return { cc: "+91", local: s.replace(/\D/g, "") };
    // Longest-match against the country codes the form knows about.
    const KNOWN = ["+971","+974","+966","+91","+65","+61","+49","+44","+33","+1"];
    for (const cc of KNOWN) {
      if (s.startsWith(cc)) return { cc, local: s.slice(cc.length).replace(/\D/g, "") };
    }
    // Unknown country: assume 1–3 digit code, take digits after "+".
    const digits = s.slice(1).replace(/\D/g, "");
    return { cc: `+${digits.slice(0, 2)}`, local: digits.slice(2) };
  }

  const messages = detail?.messages ?? [];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-rule px-5 py-4">
        <span
          className={cn(
            "flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white",
            summary.channel === "whatsapp" ? "bg-state-ok" :
            summary.channel === "voice"    ? "bg-brand-violet" :
            "bg-brand-blue",
          )}
        >
          {initials(summary.partyName)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[16px] font-bold tracking-[-.005em]">{summary.partyName}</h2>
            <span className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[9px] font-semibold tracking-[.08em] text-mute">
              {summary.channel === "whatsapp" ? "WhatsApp"
                : summary.channel === "voice"    ? "Voice"
                : "SMS"}
            </span>
            {summary.leadNumber && (
              <Link
                href={`/records/${summary.leadNumber}`}
                className="mono-cap rounded-full bg-brand-violet/10 px-2 py-0.5 text-[9px] font-semibold tracking-[.08em] text-brand-violet hover:underline"
              >
                {summary.leadNumber}
              </Link>
            )}
          </div>
          <div className="mt-0.5 text-[12px] text-mute">{summary.partyPhone ?? "—"}</div>
        </div>
        {summary.isUnlinked && canPromote && (
          <button
            type="button"
            onClick={() => setPromoteOpen(true)}
            className="rounded-md border border-brand-violet bg-brand-violet px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-brand-violet/90"
          >
            Promote to lead
          </button>
        )}
        {/* Voice threads get a "Call again" affordance in the header so
            you don't need to bounce to the record page to redial. */}
        {summary.channel === "voice" && canSend && summary.leadNumber && summary.partyPhone && (
          <CallButton leadNumber={summary.leadNumber} leadPhone={summary.partyPhone} />
        )}
      </div>

      {/* Messages — WhatsApp-style chat scroll. Light theme + subtle
          doodle tile. Content is inset via px-6 so bubbles don't crowd
          the edges even on narrow columns. */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-[#f7f4ef] px-6 py-5"
        style={{ backgroundImage: CHAT_BG_DATA_URL, backgroundRepeat: "repeat" }}
      >
        {loadError && (
          <div className="mb-3 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
            {loadError}
          </div>
        )}
        {messages.length === 0 && !loadError && (
          <div className="text-center text-[12.5px] text-mute">Loading…</div>
        )}
        <MessageList messages={messages} />
      </div>

      {/* Reply — text on SMS/WA, Call button on voice. */}
      <div className="border-t border-rule bg-[#f0ece5] p-2.5">
        {!canSend ? (
          <div className="rounded-md border border-dashed border-rule px-3 py-2 text-center text-[12px] text-mute">
            Read-only — you don&apos;t have the <code>messaging.send</code> permission.
          </div>
        ) : summary.channel === "voice" ? (
          <div className="flex items-center justify-center gap-2 py-2 text-[12.5px] text-mute">
            <span>Voice thread — no text replies.</span>
            {summary.leadNumber && summary.partyPhone && (
              <CallButton leadNumber={summary.leadNumber} leadPhone={summary.partyPhone} />
            )}
          </div>
        ) : (
          <ReplyBox
            conversationId={threadId}
            channel={summary.channel}
            canUpload={canUpload}
            canAddToLibrary={canAddToLibrary}
            onSent={() => { void fetchDetail(); onRefreshList(); }}
          />
        )}
      </div>

      {promoteOpen && (() => {
        const split = splitPhone(summary.partyPhone);
        // Party names created by the webhook start with "Unknown " — don't
        // pre-fill that; make the operator type a real name.
        const seedName = summary.partyName?.startsWith("Unknown") ? "" : summary.partyName ?? "";
        return (
          <NewLeadDialog
            title="Promote to lead"
            subtitle="Fill in the details — we'll link this conversation to the new lead."
            submitLabel="Promote"
            defaults={{
              name: seedName,
              phoneCountryCode: split.cc,
              phone: split.local,
              source: "inbound_message",
            }}
            onClose={() => setPromoteOpen(false)}
            submit={async (payload) => {
              const r = await promoteTwConversationToLead(threadId, payload);
              await fetchDetail();
              onRefreshList();
              return { number: r.number };
            }}
          />
        );
      })()}
    </div>
  );
}

// ─── Message list with date separators + consecutive-bubble grouping ─────

function MessageList({ messages }: { messages: TwMessage[] }) {
  // Group by day (Today / Yesterday / dd MMM) with a subtle pill separator
  // between groups, matching WhatsApp's chat rhythm.
  const groups = groupByDay(messages);
  return (
    <div className="flex flex-col gap-1">
      {groups.map((g) => (
        <div key={g.key} className="flex flex-col gap-0.5">
          <DateSeparator label={g.label} />
          {g.items.map((m, i) => {
            const prev = i > 0 ? g.items[i - 1]! : null;
            const nextSameSender =
              prev && prev.direction === m.direction &&
              // If < 1 minute since previous, treat as same "burst" — no tail.
              (new Date(m.sentAt).getTime() - new Date(prev.sentAt).getTime()) < 60_000;
            return <MessageBubble key={m.id} msg={m} attachTail={!nextSameSender} />;
          })}
        </div>
      ))}
    </div>
  );
}

interface DayGroup { key: string; label: string; items: TwMessage[]; }

function groupByDay(messages: TwMessage[]): DayGroup[] {
  const now = new Date();
  const groups = new Map<string, DayGroup>();
  for (const m of messages) {
    const d = new Date(m.sentAt);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    let label: string;
    if (isSameDay(d, now)) label = "Today";
    else if (isSameDay(d, addDays(now, -1))) label = "Yesterday";
    else if (d.getFullYear() === now.getFullYear()) {
      label = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    } else {
      label = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    }
    if (!groups.has(key)) groups.set(key, { key, label, items: [] });
    groups.get(key)!.items.push(m);
  }
  return [...groups.values()];
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

function DateSeparator({ label }: { label: string }) {
  return (
    <div className="my-3 flex justify-center">
      <span className="rounded-md bg-white/80 px-2.5 py-0.5 font-mono text-[10.5px] uppercase tracking-[.08em] text-mute shadow-sm">
        {label}
      </span>
    </div>
  );
}

function MessageBubble({ msg, attachTail }: { msg: TwMessage; attachTail: boolean }) {
  const outbound = msg.direction === "outbound";
  const failed   = msg.status === "failed";
  const hasMedia = !!msg.media && msg.media.length > 0;
  return (
    <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "relative max-w-[70%] min-w-[80px] px-2.5 py-[6px] text-[13.5px] leading-[1.35] shadow-sm",
          outbound
            ? attachTail ? "rounded-[10px] rounded-tr-[4px]" : "rounded-[10px]"
            : attachTail ? "rounded-[10px] rounded-tl-[4px]" : "rounded-[10px]",
          outbound
            ? failed
              ? "bg-[#fde7e7] text-ink ring-1 ring-state-warn/40"
              : "bg-[#dcf8c6] text-ink"
            : "bg-white text-ink",
        )}
      >
        {msg.channel === "voice" ? (
          // Voice bubble: verb line + optional inline recording player.
          <VoiceBubbleBody msg={msg} outbound={outbound} />
        ) : msg.body ? (
          <p className="whitespace-pre-wrap break-words px-1">
            {linkify(msg.body, outbound)}
          </p>
        ) : msg.contentSid ? (
          // Outbound template send — we didn't store the body; reconstruct
          // it from the cached template types + resolved variables.
          <TemplateBubbleBody msg={msg} outbound={outbound} />
        ) : null}
        {/* Non-voice media renders via the existing gallery. Voice recordings
            are handled inside VoiceBubbleBody so the audio player anchors
            correctly under the call-verb line. */}
        {hasMedia && msg.channel !== "voice" && (
          <div className={cn(msg.body ? "mt-1.5" : "")}>
            <MessageMediaGallery media={msg.media!} outbound={outbound} />
          </div>
        )}
        {/* Full date + time + status on its own line. Right-aligned so
            it visually anchors like a stamp under the message body. */}
        <div
          className={cn(
            "mt-1 flex items-center justify-end gap-1.5 px-1 font-mono text-[10px] leading-none",
            failed ? "text-state-warn" : outbound && !failed ? "text-[#6a6a6a]" : "text-mute",
          )}
          title={new Date(msg.sentAt).toLocaleString()}
        >
          <span>{formatFullStamp(msg.sentAt)}</span>
          {outbound && !failed && (
            <>
              <span aria-hidden>·</span>
              <span className="lowercase">{msg.status}</span>
              {msg.status === "read" && <ReadTicks doubleCheck read />}
              {msg.status === "delivered" && <ReadTicks doubleCheck />}
              {msg.status === "sent" && <ReadTicks />}
            </>
          )}
          {failed && (
            <>
              <span aria-hidden>·</span>
              <span
                title={msg.errorMessage ?? undefined}
                className={msg.errorMessage ? "cursor-help" : undefined}
              >
                failed{msg.errorCode ? ` · err ${msg.errorCode}` : ""}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Voice bubble body — inbound = "Call from customer", outbound = "You
 *  called". Duration comes from the `body` field (we stashed a compact
 *  "Call · 2m 34s" string there on activity insert; if the row was created
 *  before that convention we fall back to a plain label). Recording plays
 *  via the /media/proxy endpoint which handles Exotel Basic-auth for us. */
function VoiceBubbleBody({ msg, outbound }: { msg: TwMessage; outbound: boolean }) {
  const label = msg.body?.trim() || (outbound ? "Outbound call" : "Inbound call");
  const audio = (msg.media ?? []).find((m) => (m.contentType ?? "").startsWith("audio/"));
  return (
    <div className="px-1">
      <div className="flex items-center gap-2">
        <Icon name="phone" size={13} strokeWidth={2.2} className={outbound ? "text-brand-violet" : "text-mute"} />
        <span className="text-[13px] font-semibold">{label}</span>
      </div>
      {audio?.fetchUrl && (
        <audio
          controls
          preload="none"
          src={audio.fetchUrl}
          className="mt-2 w-full min-w-[240px]"
        />
      )}
    </div>
  );
}

/** Render an outbound template message when tw_message.body is empty.
 *  Reconstructs the text from wa_template.types (cached from Twilio Content
 *  Builder) with content_variables substituted. Falls back to a compact
 *  "[template]" label if we can't derive the body — that keeps the bubble
 *  from appearing empty in the WhatsApp-style thread. */
function TemplateBubbleBody({ msg, outbound }: { msg: TwMessage; outbound: boolean }) {
  const rendered = renderTemplateBody(msg.templateTypes, msg.contentVariables ?? {});
  return (
    <div className="px-1">
      <div className="mono-cap mb-1 text-[9.5px] tracking-[.06em] text-mute">
        Template{msg.templateName ? ` · ${msg.templateName}` : ""}
      </div>
      {rendered ? (
        <p className="whitespace-pre-wrap break-words">{linkify(rendered, outbound)}</p>
      ) : (
        <p className="italic text-mute">(template body unavailable — sync from Twilio to refresh)</p>
      )}
    </div>
  );
}

/** Walk the twilio/* type block to find the first string field that looks
 *  like a body, then substitute {{placeholder}} tokens using the resolved
 *  variables. Twilio stores placeholders as either {{name}} or {{1}}. */
function renderTemplateBody(
  types: Record<string, unknown> | null | undefined,
  vars: Record<string, string>,
): string {
  if (!types) return "";
  for (const block of Object.values(types)) {
    if (block && typeof block === "object" && "body" in block) {
      const raw = (block as { body?: unknown }).body;
      if (typeof raw === "string" && raw.trim()) {
        return raw.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, key) => {
          const v = vars[String(key).trim()];
          return v && v.length > 0 ? v : `{{${key}}}`;
        });
      }
    }
  }
  return "";
}

/** Simple WhatsApp-style check marks. `doubleCheck` = both ticks visible;
 *  `read` = blue tint. Kept tiny so it never dominates the bubble. */
function ReadTicks({ doubleCheck = false, read = false }: { doubleCheck?: boolean; read?: boolean }) {
  const cls = read ? "text-blue-500" : "text-mute";
  return (
    <span className={cn("inline-flex items-center", cls)}>
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d={doubleCheck ? "M1 6l2 2 5-5M5 6l2 2 5-5" : "M1 6l3 3 7-7"} />
      </svg>
    </span>
  );
}

function formatFullStamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  // Format: "7/10/2026, 10:43:39 AM"
  // Pinned to en-US so we get the M/D/YYYY, h:mm:ss AM/PM layout the
  // designs mocked — same shape on server and client so hydration matches.
  return d.toLocaleString("en-US", {
    month: "numeric", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit",
    hour12: true,
  });
}

function initials(name: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  return (parts[0]![0]! + (parts[1]?.[0] ?? "")).toUpperCase();
}
