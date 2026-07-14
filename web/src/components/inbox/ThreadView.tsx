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
import { EmailComposer } from "./EmailComposer";
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
  // The newest email in the thread — the default reply target, since replying
  // to it is what keeps our reply inside the same Gmail thread AND inside the
  // recipient's mail-client thread.
  const lastEmail = [...messages].reverse().find((m) => m.channel === "email") ?? null;

  // Composer target. `composeNew` means "start a fresh thread with a new
  // subject"; otherwise we reply to `replyToId`, defaulting to the newest mail.
  // Held here rather than in the composer so the per-message Reply buttons in
  // the transcript can drive it.
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [composeNew, setComposeNew] = useState(false);
  const replyTarget = composeNew
    ? null
    : (messages.find((m) => m.id === replyToId && m.channel === "email") ?? lastEmail);

  // A thread the user switched away from shouldn't keep a stale reply target.
  useEffect(() => {
    setReplyToId(null);
    setComposeNew(false);
  }, [threadId]);

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
                : summary.channel === "email"    ? "Email"
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
          <div className="mt-0.5 text-[12px] text-mute">
            {summary.channel === "email"
              ? summary.partyEmail ?? "—"
              : summary.partyPhone ?? "—"}
          </div>
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
        <MessageList
          messages={messages}
          replyingToId={replyTarget?.id ?? null}
          onReplyTo={canSend ? (id) => { setComposeNew(false); setReplyToId(id); } : undefined}
        />
      </div>

      {/* Reply — text on SMS/WA, Call button on voice, composer on email. */}
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
        ) : summary.channel === "email" ? (
          // `to` prefers the party's address over the lead number — an unlinked
          // thread has no lead number at all.
          <EmailComposer
            to={summary.partyEmail ?? summary.leadNumber ?? ""}
            replyTo={replyTarget ? { id: replyTarget.id, subject: replyTarget.subject ?? null } : null}
            hasThread={!!lastEmail}
            onStartNew={() => { setComposeNew(true); setReplyToId(null); }}
            onReplyToLatest={() => { setComposeNew(false); setReplyToId(null); }}
            onSent={() => {
              setComposeNew(false);
              setReplyToId(null);
              void fetchDetail();
              onRefreshList();
            }}
          />
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

function MessageList({
  messages, replyingToId, onReplyTo,
}: {
  messages: TwMessage[];
  /** Highlights whichever message the composer is currently aimed at. */
  replyingToId?: string | null;
  /** Undefined when the user can't send — the Reply buttons then don't render. */
  onReplyTo?: (messageId: string) => void;
}) {
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
            return (
              <MessageBubble
                key={m.id}
                msg={m}
                attachTail={!nextSameSender}
                isReplyTarget={m.id === replyingToId}
                onReplyTo={onReplyTo}
              />
            );
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

function MessageBubble({
  msg, attachTail, isReplyTarget = false, onReplyTo,
}: {
  msg: TwMessage;
  attachTail: boolean;
  isReplyTarget?: boolean;
  onReplyTo?: (messageId: string) => void;
}) {
  const outbound = msg.direction === "outbound";
  const failed   = msg.status === "failed";
  const hasMedia = !!msg.media && msg.media.length > 0;
  const isEmail  = msg.channel === "email";
  return (
    <div className={cn("group/bubble flex items-center gap-1.5", outbound ? "justify-end" : "justify-start")}>
      {/* Reply-to-this-message, on the outside of the bubble. Lets you answer an
          OLD mail in the thread, not just the newest one — the composer would
          otherwise always target the last message. Left of outbound bubbles,
          right of inbound ones, so it never covers the text. */}
      {isEmail && onReplyTo && outbound && (
        <ReplyToButton active={isReplyTarget} onClick={() => onReplyTo(msg.id)} />
      )}
      <div
        className={cn(
          "relative min-w-[80px] px-2.5 py-[6px] text-[13.5px] leading-[1.35] shadow-sm",
          // Email carries subject lines, signatures and quoted history, so a
          // 70% chat bubble squeezes it into a column. Give it more room.
          isEmail ? "max-w-[88%]" : "max-w-[70%]",
          outbound
            ? attachTail ? "rounded-[10px] rounded-tr-[4px]" : "rounded-[10px]"
            : attachTail ? "rounded-[10px] rounded-tl-[4px]" : "rounded-[10px]",
          outbound
            ? failed
              ? "bg-[#fde7e7] text-ink ring-1 ring-state-warn/40"
              : isEmail ? "bg-[#e8eefc] text-ink" : "bg-[#dcf8c6] text-ink"
            : "bg-white text-ink",
          isReplyTarget && "ring-2 ring-brand-blue/45",
        )}
      >
        {isEmail ? (
          <EmailBubbleBody msg={msg} outbound={outbound} />
        ) : msg.channel === "voice" ? (
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
      {isEmail && onReplyTo && !outbound && (
        <ReplyToButton active={isReplyTarget} onClick={() => onReplyTo(msg.id)} />
      )}
    </div>
  );
}

/** Aim the composer at one specific message. Stays hidden until you hover the
 *  bubble (or it's the active target) so the transcript doesn't turn into a
 *  wall of buttons. */
function ReplyToButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Reply to this email"
      aria-label="Reply to this email"
      className={cn(
        "flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border transition",
        active
          ? "border-brand-blue bg-brand-blue text-white opacity-100"
          : "border-rule bg-white/80 text-mute opacity-0 hover:text-ink group-hover/bubble:opacity-100 focus-visible:opacity-100",
      )}
    >
      <Icon name="reply" size={12} strokeWidth={2.2} />
    </button>
  );
}

/** Email bubble — subject line, the sender's actual address, the message, and
 *  the quoted history folded away behind a toggle.
 *
 *  We render the PLAIN-TEXT body, never `bodyHtml`. Dropping arbitrary sender
 *  HTML into the page would be a stored-XSS hole (and would let a sender
 *  restyle the CRM), and sanitizing it properly needs a real sanitizer.
 *  bodyHtml is stored so we can render it safely in an iframe sandbox later. */
function EmailBubbleBody({ msg, outbound }: { msg: TwMessage; outbound: boolean }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const { visible, quoted } = splitQuoted(msg.body ?? "");
  const recipients = (msg.toAddrs ?? []).join(", ");

  return (
    <div className="px-1">
      <div className="mb-1.5 border-b border-black/[.06] pb-1.5">
        <div className="flex items-start gap-1.5">
          <Icon
            name="mail"
            size={12}
            strokeWidth={2.2}
            className={cn("mt-[3px] flex-shrink-0", outbound ? "text-brand-blue" : "text-mute")}
          />
          <span className="break-words text-[13px] font-semibold leading-[1.3]">
            {msg.subject?.trim() || "(no subject)"}
          </span>
        </div>
        <div className="mt-1 break-all font-mono text-[10px] leading-[1.4] text-mute">
          {msg.fromNumber}
          {recipients && <> → {recipients}</>}
          {msg.ccAddrs && msg.ccAddrs.length > 0 && (
            <> · cc {msg.ccAddrs.join(", ")}</>
          )}
        </div>
      </div>

      {visible ? (
        <p className="whitespace-pre-wrap break-words">{linkify(visible, outbound)}</p>
      ) : (
        !quoted && <p className="italic text-mute">(no message body)</p>
      )}

      {quoted && (
        <>
          <button
            type="button"
            onClick={() => setShowQuoted((v) => !v)}
            className="mt-1.5 rounded border border-black/10 bg-black/[.04] px-1.5 py-0.5 text-[11px] leading-none text-mute transition hover:bg-black/[.07]"
            title={showQuoted ? "Hide quoted text" : "Show quoted text"}
          >
            {showQuoted ? "Hide quoted text" : "··· Show quoted text"}
          </button>
          {showQuoted && (
            <p className="mt-1.5 whitespace-pre-wrap break-words border-l-2 border-black/10 pl-2 text-[12.5px] text-mute">
              {quoted}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Split a reply into what the person actually wrote and the thread they wrote
 * it on top of. Mirrors stripQuotedReply() on the API side (api/src/lib/gmail/parse.ts).
 *
 * There's no standard for reply quoting, so this is heuristic: cut at the first
 * "On <date>, <someone> wrote:" attribution, `>` quote block, or common client
 * separator. When nothing matches, everything stays visible — failing open is
 * right here, since hiding real content is worse than showing quoted content.
 */
function splitQuoted(text: string): { visible: string; quoted: string } {
  if (!text) return { visible: "", quoted: "" };
  const lines = text.split(/\r?\n/);
  const cutPatterns = [
    /^On .+ wrote:\s*$/i,
    /^-{2,}\s*Original Message\s*-{2,}/i,
    /^-{2,}\s*Forwarded message\s*-{2,}/i,
    /^_{10,}\s*$/,
    /^From:\s.+/i,
  ];
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith(">") || cutPatterns.some((re) => re.test(line.trim()))) {
      cut = i;
      break;
    }
  }
  if (cut === -1) return { visible: text.trim(), quoted: "" };
  return {
    visible: lines.slice(0, cut).join("\n").trim(),
    quoted:  lines.slice(cut).join("\n").trim(),
  };
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
