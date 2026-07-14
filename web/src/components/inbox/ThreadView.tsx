"use client";

// Thread pane: header + transcript + composer.
// Polls thread detail every 10s while active + tab visible.
//
// The transcript holds three kinds of entry (tw_message.kind):
//   'message'  — actually transmitted, rendered as a chat bubble
//   'note'     — staff-only annotation, rendered as a centered callout
//   'call_log' — a call that happened off-platform, also a callout
// Rows written before post-0074 have no `kind` at all, so every read of it goes
// through `kindOf()` and defaults to 'message'.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  assignTwConversation,
  getCatalog,
  getTwConversation,
  markTwConversationRead,
  promoteTwConversationToLead,
} from "@/lib/api";
import type {
  CallLogMeta,
  CatalogResponse,
  TwConversationDetail,
  TwConversationListItem,
  TwMessage,
  TwMessageKind,
} from "@/lib/types";
import { avatarGradClass, gradFor, initialsOf } from "@/lib/ui";
import { MessageMediaGallery } from "@/components/media/MessageMediaGallery";
import { linkify } from "./linkify";
import { CALL_OUTCOME_LABELS, InboxComposer, formatCallDuration } from "./InboxComposer";
import { NewLeadDialog } from "@/components/leads/NewLeadDialog";
import { CallButton } from "@/components/record/CallButton";

const DETAIL_POLL_MS = 10_000;

// Everyone is in India, and this component server-renders then hydrates, so the
// clock must not depend on the runtime's zone — see the same reasoning in lib/ui.ts.
const IST = "Asia/Kolkata";
const istDayKeyFmt   = new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" });
const istDayFmt      = new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "2-digit", month: "short" });
const istDayYearFmt  = new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "2-digit", month: "short", year: "numeric" });
const istClockFmt    = new Intl.DateTimeFormat("en-IN", { timeZone: IST, hour: "numeric", minute: "2-digit", hour12: true });

/** "10:47 am" — assembled from parts so an ICU version difference between the
 *  server and the browser (U+202F vs a plain space before the day period)
 *  can't produce a hydration mismatch. */
function istClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = istClockFmt.formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("dayPeriod").toLowerCase()}`;
}

/** Pre-migration rows carry no `kind`. Everything that branches on it comes
 *  through here so those rows keep rendering as ordinary messages. */
function kindOf(m: TwMessage): TwMessageKind {
  return m.kind ?? "message";
}

/** Only kind='call_log' rows carry a populated meta block; `{}` otherwise.
 *  `Record<string, never>` has an index signature, so an `in` check can't
 *  narrow the union — the cast is checked by the `outcome` guard below it. */
function callMeta(m: TwMessage): CallLogMeta | null {
  const meta = m.meta as Partial<CallLogMeta> | undefined;
  if (!meta?.outcome) return null;
  return {
    outcome: meta.outcome,
    durationSec: meta.durationSec ?? null,
    direction: meta.direction ?? m.direction,
  };
}

// The staff list is the same for every thread and changes about once a month,
// so it's fetched once per page load rather than on every thread open. It backs
// both the assign menu and the author names on notes/call logs.
let catalogOnce: Promise<CatalogResponse> | null = null;
function staffCatalog(): Promise<CatalogResponse> {
  catalogOnce ??= getCatalog();
  return catalogOnce;
}

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
  const [staff, setStaff] = useState<CatalogResponse["staff"]>([]);
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

  useEffect(() => {
    let alive = true;
    staffCatalog()
      .then((c) => { if (alive) setStaff(c.staff); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

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
  const lastEmail = [...messages].reverse().find(
    (m) => m.channel === "email" && kindOf(m) === "message",
  ) ?? null;

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

  const authorName = useCallback(
    (userId: string | null) => staff.find((s) => s.id === userId)?.name ?? null,
    [staff],
  );

  const contactLine = summary.channel === "email"
    ? summary.partyEmail ?? summary.partyPhone
    : summary.partyPhone ?? summary.partyEmail;

  // A thread is dialable when we know who to call and where — the CallButton
  // resolves the number server-side from the lead.
  const canCall = canSend && !!summary.leadNumber && !!summary.partyPhone;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-rule bg-paper px-5 py-3.5">
        <span
          className={cn(
            "flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white",
            avatarGradClass[gradFor(summary.partyName || summary.partyId)],
          )}
        >
          {initialsOf(summary.partyName)}
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[16px] font-bold tracking-[-.005em]">{summary.partyName}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-mute">
            <span className={cn("h-1.5 w-1.5 flex-shrink-0 rounded-full", CHANNEL_DOT[summary.channel])} />
            <span>{CHANNEL_LABEL[summary.channel]}</span>
            {contactLine && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{contactLine}</span>
              </>
            )}
            {summary.leadNumber && (
              <>
                <span aria-hidden>·</span>
                <Link
                  href={`/records/${summary.leadNumber}`}
                  className="font-mono text-[10.5px] font-semibold text-brand-violet hover:underline"
                >
                  {summary.leadNumber}
                </Link>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-1.5">
          {canCall && (
            <CallButton
              leadNumber={summary.leadNumber!}
              leadPhone={summary.partyPhone}
              className="!px-2 !py-2"
            />
          )}
          <AssignMenu
            conversationId={threadId}
            staff={staff}
            assignedUserId={summary.assignedUserId}
            assignedName={summary.advisorName}
            onAssigned={() => { void fetchDetail(); onRefreshList(); }}
          />
          {summary.leadNumber ? (
            <Link href={`/records/${summary.leadNumber}`} className="btn-primary !px-3 !py-2 !text-[12px]">
              Open lead
              <Icon name="arrow-right" size={12} strokeWidth={2.2} />
            </Link>
          ) : canPromote ? (
            <button type="button" onClick={() => setPromoteOpen(true)} className="btn-primary !px-3 !py-2 !text-[12px]">
              Promote to lead
            </button>
          ) : null}
        </div>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-warm px-6 py-5">
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
          authorName={authorName}
        />
      </div>

      <InboxComposer
        conversationId={threadId}
        channel={summary.channel}
        canSend={canSend}
        canUpload={canUpload}
        canAddToLibrary={canAddToLibrary}
        // `to` prefers the party's address over the lead number — an unlinked
        // thread has no lead number at all.
        emailTo={summary.partyEmail ?? summary.leadNumber ?? ""}
        emailReplyTo={replyTarget ? { id: replyTarget.id, subject: replyTarget.subject ?? null } : null}
        hasEmailThread={!!lastEmail}
        onStartNewEmail={() => { setComposeNew(true); setReplyToId(null); }}
        onReplyToLatestEmail={() => { setComposeNew(false); setReplyToId(null); }}
        onSent={() => {
          setComposeNew(false);
          setReplyToId(null);
          void fetchDetail();
          onRefreshList();
        }}
        onRefresh={() => { void fetchDetail(); }}
      />

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

const CHANNEL_LABEL: Record<TwConversationListItem["channel"], string> = {
  whatsapp: "WhatsApp",
  sms: "SMS",
  voice: "Voice",
  email: "Email",
};

const CHANNEL_DOT: Record<TwConversationListItem["channel"], string> = {
  whatsapp: "bg-state-ok",
  sms: "bg-brand-magenta",
  voice: "bg-brand-violet",
  email: "bg-brand-blue",
};

// ─── Assign ──────────────────────────────────────────────────────────────

/** Reassign the thread's owner. Renders nothing until the staff list has
 *  loaded — an assign button with no one to assign to is a dead button. */
function AssignMenu({
  conversationId, staff, assignedUserId, assignedName, onAssigned,
}: {
  conversationId: string;
  staff: CatalogResponse["staff"];
  assignedUserId: string | null;
  assignedName: string | null;
  onAssigned: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (staff.length === 0) return null;

  async function assign(userId: string | null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await assignTwConversation(conversationId, userId);
      setOpen(false);
      onAssigned();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={assignedName ? `Assigned to ${assignedName}` : "Unassigned — click to assign"}
        aria-label="Assign conversation"
        className={cn(
          "inline-flex h-[34px] w-[34px] items-center justify-center rounded-[9px] border border-rule bg-paper transition hover:border-brand-violet hover:text-brand-violet",
          assignedUserId ? "text-brand-violet" : "text-ink-2",
        )}
      >
        <Icon name="user-plus" size={14} strokeWidth={2} />
      </button>

      {open && (
        <>
          {/* Click-away layer — keeps the menu from needing a document listener. */}
          <button
            type="button"
            aria-label="Close assign menu"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[220px] overflow-hidden rounded-[10px] border border-rule bg-paper py-1 shadow-card">
            <div className="mono-cap px-3 py-1.5 text-[9px] tracking-[.12em] text-hint">Assign to</div>
            <AssignRow label="Unassigned" active={!assignedUserId} disabled={busy} onClick={() => void assign(null)} />
            {staff.map((s) => (
              <AssignRow
                key={s.id}
                label={s.name || s.email}
                active={s.id === assignedUserId}
                disabled={busy}
                onClick={() => void assign(s.id)}
              />
            ))}
            {error && <div className="px-3 py-1.5 text-[11px] text-state-warn">{error}</div>}
          </div>
        </>
      )}
    </div>
  );
}

function AssignRow({
  label, active, disabled, onClick,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12.5px] transition hover:bg-warm disabled:opacity-50",
        active ? "font-semibold text-brand-violet" : "text-ink-2",
      )}
    >
      <span className="truncate">{label}</span>
      {active && <Icon name="check" size={12} strokeWidth={2.4} className="flex-shrink-0" />}
    </button>
  );
}

// ─── Message list with date separators + consecutive-bubble grouping ─────

function MessageList({
  messages, replyingToId, onReplyTo, authorName,
}: {
  messages: TwMessage[];
  /** Highlights whichever message the composer is currently aimed at. */
  replyingToId?: string | null;
  /** Undefined when the user can't send — the Reply buttons then don't render. */
  onReplyTo?: (messageId: string) => void;
  authorName: (userId: string | null) => string | null;
}) {
  const groups = useMemo(() => groupByDay(messages), [messages]);
  return (
    <div className="flex flex-col gap-1">
      {groups.map((g) => (
        <div key={g.key} className="flex flex-col gap-0.5">
          <DateSeparator label={g.label} />
          {g.items.map((m, i) => {
            const kind = kindOf(m);
            if (kind === "note") {
              return <NoteCallout key={m.id} msg={m} authorName={authorName} />;
            }
            if (kind === "call_log") {
              return <CallLogCallout key={m.id} msg={m} authorName={authorName} />;
            }

            const prev = i > 0 ? g.items[i - 1]! : null;
            // A note or call log between two messages breaks the burst — the
            // second one starts a fresh bubble with its own tail.
            const sameBurst =
              !!prev &&
              kindOf(prev) === "message" &&
              prev.direction === m.direction &&
              (new Date(m.sentAt).getTime() - new Date(prev.sentAt).getTime()) < 60_000;
            return (
              <MessageBubble
                key={m.id}
                msg={m}
                attachTail={!sameBurst}
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
  const todayKey = istDayKeyFmt.format(now);
  const yesterdayKey = istDayKeyFmt.format(new Date(now.getTime() - 86_400_000));
  const thisYear = todayKey.slice(0, 4);

  const groups = new Map<string, DayGroup>();
  for (const m of messages) {
    const d = new Date(m.sentAt);
    if (Number.isNaN(d.getTime())) continue;
    const key = istDayKeyFmt.format(d);
    let label: string;
    if (key === todayKey) label = `Today · ${istDayFmt.format(d)}`;
    else if (key === yesterdayKey) label = `Yesterday · ${istDayFmt.format(d)}`;
    else if (key.slice(0, 4) === thisYear) label = istDayFmt.format(d);
    else label = istDayYearFmt.format(d);

    if (!groups.has(key)) groups.set(key, { key, label, items: [] });
    groups.get(key)!.items.push(m);
  }
  return [...groups.values()];
}

function DateSeparator({ label }: { label: string }) {
  return (
    <div className="my-3 flex justify-center">
      <span className="mono-cap rounded-full border border-rule bg-paper px-3 py-1 text-[9.5px] tracking-[.1em] text-mute">
        {label}
      </span>
    </div>
  );
}

// ─── Non-transmitted entries: internal notes + logged calls ──────────────

/** A note never left the building. It's deliberately NOT a bubble — a bubble
 *  reads as "someone said this to someone", which is exactly the wrong thing
 *  to imply about a staff-only annotation. */
function NoteCallout({
  msg, authorName,
}: {
  msg: TwMessage;
  authorName: (userId: string | null) => string | null;
}) {
  const who = authorName(msg.senderUserId);
  return (
    <div className="my-1.5 flex justify-center">
      <div className="w-full max-w-[88%] rounded-[10px] border border-state-amber/40 bg-[rgba(224,138,30,.07)] px-3.5 py-2.5">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="mono-cap text-[9px] tracking-[.12em] text-state-amber">Internal note</span>
          <span className="text-[9px] font-semibold uppercase tracking-[.08em] text-state-amber/80">
            Staff only
          </span>
        </div>
        <p className="whitespace-pre-wrap break-words text-[12.5px] leading-[1.45] text-ink-2">
          {msg.body}
        </p>
        <div className="mt-1.5 text-[10px] text-hint">
          {who ? `${who} · ` : ""}{istClock(msg.sentAt)} · never sent to the lead
        </div>
      </div>
    </div>
  );
}

/** A call that happened on a phone, not in the CRM. Violet-toned so it reads as
 *  "system record" rather than "conversation". */
function CallLogCallout({
  msg, authorName,
}: {
  msg: TwMessage;
  authorName: (userId: string | null) => string | null;
}) {
  const meta = callMeta(msg);
  const who = authorName(msg.senderUserId);
  const inbound = (meta?.direction ?? msg.direction) === "inbound";
  const label = meta ? CALL_OUTCOME_LABELS[meta.outcome] : "Call logged";
  const duration = formatCallDuration(meta?.durationSec);
  // The API stores the free-text notes in `body`; meta carries only the
  // structured fields.
  const notes = msg.body?.trim();

  return (
    <div className="my-1.5 flex justify-center">
      <div className="w-full max-w-[88%] rounded-[10px] border border-brand-violet/25 bg-[rgba(107,31,184,.05)] px-3.5 py-2.5">
        <div className="mono-cap mb-1 text-[9px] tracking-[.12em] text-brand-violet">Call logged</div>
        <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-2">
          <Icon
            name="arrow-right"
            size={12}
            strokeWidth={2.2}
            className={cn("flex-shrink-0 text-brand-violet", inbound && "rotate-180")}
            aria-hidden
          />
          <span>{inbound ? "Inbound" : "Outbound"} · {label}</span>
          {duration && <span className="font-normal text-mute">· {duration}</span>}
        </div>
        {notes && (
          <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-[1.45] text-ink-2">
            {notes}
          </p>
        )}
        <div className="mt-1.5 text-[10px] text-hint">
          {who ? `${who} · ` : ""}{istClock(msg.sentAt)}
        </div>
      </div>
    </div>
  );
}

// ─── Transmitted messages ────────────────────────────────────────────────

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
          "relative min-w-[80px] rounded-[12px] px-2.5 py-[6px] text-[13.5px] leading-[1.35]",
          // Email carries subject lines, signatures and quoted history, so a
          // 70% chat bubble squeezes it into a column. Give it more room.
          isEmail ? "max-w-[88%]" : "max-w-[70%]",
          // Square off the corner nearest the sender on the first bubble of a
          // burst, so a run of messages reads as one utterance.
          attachTail && (outbound ? "rounded-tr-[4px]" : "rounded-tl-[4px]"),
          outbound
            ? failed
              ? "bg-[#FDE7E7] text-ink ring-1 ring-state-warn/40"
              : isEmail ? "bg-[#E8EEFC] text-ink" : "bg-[#DCF3E4] text-ink"
            : "border border-rule bg-paper text-ink",
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
        <div
          className={cn(
            "mt-1 flex items-center justify-end gap-1 px-1 text-[10px] leading-none",
            failed ? "text-state-warn" : "text-mute",
          )}
          title={new Date(msg.sentAt).toLocaleString()}
        >
          <span>{istClock(msg.sentAt)}</span>
          {outbound && !failed && (
            <>
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
          : "border-rule bg-paper text-mute opacity-0 hover:text-ink group-hover/bubble:opacity-100 focus-visible:opacity-100",
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
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d={doubleCheck ? "M1 6l2 2 5-5M5 6l2 2 5-5" : "M1 6l3 3 7-7"} />
      </svg>
    </span>
  );
}
