"use client";

// Full Edify chat page — Claude-like layout: sidebar of past sessions on the
// left, current conversation on the right. Sessions persist in the DB.

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  askEdify,
  deleteEdifySession,
  getEdifySession,
  getEdifySessions,
  renameEdifySession,
} from "@/lib/api";
import { EdifyAnswer as EdifyAnswerCard } from "@/components/agents/EdifyAnswer";
import type { EdifyAnswer, EdifySessionSummary } from "@/lib/types";

const QUICK_PROMPTS = [
  "How many hot leads do we have?",
  "Which leads should I prioritise today?",
  "Summarise the latest forecast",
  "Show me open tickets by category",
  "Who hasn't been touched in 7 days?",
];

interface Props {
  initialSessions: EdifySessionSummary[];
  initialActiveId: string | null;
  initialMessages: EdifyAnswer[];
}

export function EdifyPanel({ initialSessions, initialActiveId, initialMessages }: Props) {
  const [sessions, setSessions] = useState<EdifySessionSummary[]>(initialSessions);
  const [activeId, setActiveId] = useState<string | null>(initialActiveId);
  const [messages, setMessages] = useState<EdifyAnswer[]>(initialMessages);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  // The user's just-asked question, shown as a pending bubble while we wait
  // for the assistant. Kept separate from `messages` so we don't have to fake
  // an EdifyAnswer with empty fields in the list.
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [editingLatest, setEditingLatest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Whenever the conversation changes, scroll the input into focus so the
  // user can keep typing without having to click.
  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy, activeId]);

  // Auto-scroll to the bottom whenever the conversation grows or a request
  // starts/finishes — keeps the latest exchange in view.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, pendingQuestion, busy]);

  async function selectSession(id: string) {
    if (id === activeId) return;
    cancelPending();
    setError(null);
    try {
      const data = await getEdifySession(id);
      if (!data) {
        // Session missing on server — drop from list.
        setSessions((s) => s.filter((x) => x.id !== id));
        if (activeId === id) startNewChat();
        return;
      }
      setActiveId(id);
      setMessages(data.messages);
      setEditingLatest(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function startNewChat() {
    cancelPending();
    setActiveId(null);
    setMessages([]);
    setError(null);
    setQ("");
    setEditingLatest(null);
  }

  function cancelPending() {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setPendingQuestion(null);
    setBusy(false);
  }

  // Core ask-Edify flow. `dropLast` is set by the edit-and-resend path so the
  // previous Q+A is replaced rather than appended-to.
  async function submit(question: string, opts: { dropLast?: boolean } = {}) {
    const text = question.trim();
    if (!text || busy) return;
    setError(null);
    setQ("");
    setEditingLatest(null);
    if (opts.dropLast) {
      setMessages((m) => m.slice(0, -1));
    }
    setPendingQuestion(text);
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const out = await askEdify(text, activeId, ctrl.signal);
      // If a different request landed first, ignore late results.
      if (abortRef.current !== ctrl) return;
      setMessages((m) => [...m, out]);
      setPendingQuestion(null);
      if (!activeId || out.sessionId !== activeId) {
        setActiveId(out.sessionId);
        // Refresh the sidebar list so the new (or freshly-touched) session
        // bubbles to the top.
        const list = await getEdifySessions(50);
        setSessions(list);
      } else {
        // Touch last_at locally for instant ordering.
        setSessions((s) => {
          const idx = s.findIndex((x) => x.id === activeId);
          if (idx === -1) return s;
          const updated = { ...s[idx]!, lastAt: new Date().toISOString(), messageCount: s[idx]!.messageCount + 1, preview: text.slice(0, 80) };
          return [updated, ...s.filter((_, i) => i !== idx)];
        });
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // Stop generating — drop the pending bubble silently.
        setPendingQuestion(null);
      } else if (abortRef.current === ctrl) {
        setError((err as Error).message);
        setPendingQuestion(null);
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setBusy(false);
    }
  }

  function onEditAndResend(newText: string) {
    const text = newText.trim();
    if (!text) return;
    submit(text, { dropLast: true });
  }

  async function onRename(id: string) {
    const current = sessions.find((s) => s.id === id);
    const next = window.prompt("Rename this chat:", current?.title ?? "");
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    try {
      await renameEdifySession(id, trimmed);
      setSessions((s) => s.map((x) => (x.id === id ? { ...x, title: trimmed } : x)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this chat? This can't be undone.")) return;
    try {
      await deleteEdifySession(id);
      setSessions((s) => s.filter((x) => x.id !== id));
      if (activeId === id) startNewChat();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: "260px 1fr" }}>
      {/* SIDEBAR */}
      <aside className="flex max-h-[calc(100vh-180px)] flex-col rounded-2xl border border-rule bg-paper">
        <button
          type="button"
          onClick={startNewChat}
          className="m-2.5 flex items-center justify-center gap-2 rounded-[10px] bg-grad px-3 py-2 text-[12.5px] font-semibold text-white shadow-glow"
        >
          <Icon name="plus" size={12} strokeWidth={2.4} />
          New chat
        </button>
        <div className="mono-cap mx-3 mb-1.5 text-[9.5px] font-semibold tracking-[.12em] text-hint">
          Recent chats
        </div>
        <div className="flex-1 overflow-y-auto px-1.5 pb-2">
          {sessions.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-mute">No chats yet.</div>
          ) : (
            sessions.map((s) => {
              const active = s.id === activeId;
              return (
                <div
                  key={s.id}
                  className={cn(
                    "group mb-0.5 rounded-md p-2 transition",
                    active ? "bg-warm2" : "hover:bg-warm",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => selectSession(s.id)}
                    className="block w-full text-left"
                  >
                    <div className={cn("truncate text-[12.5px] font-semibold", active ? "text-ink" : "text-ink2")}>
                      {s.title ?? s.preview ?? "Untitled chat"}
                    </div>
                    <div className="mono-cap mt-0.5 truncate text-[9.5px] tracking-[.04em] text-mute">
                      {timeAgo(s.lastAt)} · {s.messageCount} msg{s.messageCount === 1 ? "" : "s"}
                    </div>
                  </button>
                  <div className="mt-1 flex gap-1 opacity-0 transition group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => onRename(s.id)}
                      className="rounded text-[10px] font-semibold text-mute hover:text-brand-violet"
                      title="Rename"
                    >
                      Rename
                    </button>
                    <span className="text-[10px] text-rule2">·</span>
                    <button
                      type="button"
                      onClick={() => onDelete(s.id)}
                      className="rounded text-[10px] font-semibold text-mute hover:text-state-warn"
                      title="Delete"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* MAIN */}
      <section className="flex max-h-[calc(100vh-180px)] flex-col rounded-2xl border border-rule bg-paper">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-rule px-5 py-3">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-grad text-white">
            <Icon name="spark" size={13} strokeWidth={2} />
          </span>
          <div className="text-[13.5px] font-bold tracking-tight">
            {activeId ? (sessions.find((s) => s.id === activeId)?.title ?? "Chat") : "New chat"}
          </div>
          {activeId && (
            <span className="mono-cap ml-auto text-[9.5px] tracking-[.04em] text-mute">
              {messages.length} message{messages.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {/* Conversation */}
        <div ref={scrollerRef} className="flex-1 overflow-y-auto px-5 py-4">
          {messages.length === 0 && !pendingQuestion ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="font-serif text-[26px] leading-tight tracking-[-.01em]">
                Ask Edify anything about your CRM.
              </div>
              <p className="mt-2 max-w-[460px] text-[13px] text-mute">
                Reads leads, learners, tickets, batches, programs, users, agents — everything in your tenant.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-1.5">
                {QUICK_PROMPTS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => submit(p)}
                    disabled={busy}
                    className="rounded-full border border-rule bg-paper px-3 py-1.5 text-[11.5px] font-medium text-ink2 transition hover:border-brand-violet hover:text-brand-violet disabled:opacity-50"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map((entry, i) => {
                const isLatest = i === messages.length - 1;
                const editable = isLatest && !busy && !pendingQuestion;
                return (
                  <EdifyMessageCard
                    key={entry.messageId}
                    entry={entry}
                    editable={editable}
                    isEditing={editingLatest === entry.messageId}
                    onStartEdit={() => setEditingLatest(entry.messageId)}
                    onCancelEdit={() => setEditingLatest(null)}
                    onSubmitEdit={onEditAndResend}
                  />
                );
              })}
              {pendingQuestion && <PendingTurn question={pendingQuestion} />}
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-rule p-3">
          {error && (
            <div className="mb-2 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
              {error}
            </div>
          )}
          <form
            onSubmit={(e) => { e.preventDefault(); submit(q); }}
            className="flex items-center gap-2"
          >
            <input
              ref={inputRef}
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={messages.length === 0 ? "Ask Edify anything…" : "Ask a follow-up…"}
              disabled={busy}
              className="flex-1 rounded-[12px] border border-rule bg-paper px-4 py-2.5 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20 disabled:opacity-60"
            />
            {busy ? (
              <button
                type="button"
                onClick={cancelPending}
                className="inline-flex h-[42px] items-center gap-1.5 rounded-full border border-state-warn/40 bg-state-warn/10 px-3.5 text-[12.5px] font-semibold text-state-warn hover:bg-state-warn/15"
                title="Stop generating"
              >
                <span className="grid h-3 w-3 place-items-center"><span className="block h-2.5 w-2.5 rounded-[2px] bg-state-warn" /></span>
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!q.trim()}
                className="grid h-[42px] w-[42px] place-items-center rounded-full bg-grad text-white shadow-glow disabled:opacity-50"
                title="Send"
              >
                <Icon name="arrow-right" size={16} strokeWidth={2} />
              </button>
            )}
          </form>
        </div>
      </section>
    </div>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" strokeOpacity=".3" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}

// Wrapper around EdifyAnswerCard that lets the user edit + resend the LATEST
// question. We render either the card or an in-place editor for the question.
function EdifyMessageCard({
  entry, editable, isEditing, onStartEdit, onCancelEdit, onSubmitEdit,
}: {
  entry: EdifyAnswer;
  editable: boolean;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(entry.question);
  // Reset the draft if the user hops between edit / cancel.
  useEffect(() => { setDraft(entry.question); }, [entry.question, isEditing]);

  if (isEditing) {
    return (
      <div className="rounded-2xl border border-brand-violet/40 bg-paper p-4 shadow-card ring-1 ring-brand-violet/20">
        <div className="mono-cap mb-2 text-[9.5px] font-semibold tracking-[.12em] text-brand-violet">Editing prompt</div>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-[64px] w-full resize-y rounded-[10px] border border-rule bg-paper px-3 py-2 text-[13.5px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
        />
        <div className="mt-2.5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancelEdit}
            className="rounded-md border border-rule bg-paper px-3 py-1.5 text-[12px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmitEdit(draft)}
            disabled={!draft.trim() || draft.trim() === entry.question}
            className="rounded-md bg-grad px-3 py-1.5 text-[12px] font-semibold text-white shadow-glow disabled:opacity-50"
          >
            Resend
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group/edify relative">
      <EdifyAnswerCard entry={entry} />
      {editable && (
        <button
          type="button"
          onClick={onStartEdit}
          title="Edit & resend"
          className="absolute right-3 top-3 rounded-md border border-rule bg-paper px-2 py-0.5 text-[10.5px] font-semibold text-mute opacity-0 transition hover:border-brand-violet hover:text-brand-violet group-hover/edify:opacity-100"
        >
          Edit
        </button>
      )}
    </div>
  );
}

// In-flight Q+A while the assistant is generating: question echoed at the top,
// shimmery placeholder bars below it.
function PendingTurn({ question }: { question: string }) {
  return (
    <div className="rounded-2xl border border-rule bg-paper p-5 shadow-card">
      <div className="mb-3 flex items-start gap-2.5">
        <span className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-full bg-warm2 text-[11px] font-bold text-ink2">You</span>
        <div className="flex-1 text-[13.5px] font-semibold leading-snug text-ink">{question}</div>
      </div>
      <div className="flex items-start gap-2.5">
        <span className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-full bg-grad text-[11px] font-bold text-white">E</span>
        <div className="flex-1 space-y-2 pt-0.5">
          <div className="flex items-center gap-2 text-[12.5px] text-mute">
            <Spinner />
            <span>Edify is thinking…</span>
          </div>
          <div className="h-2.5 w-[78%] animate-pulse rounded bg-warm2" />
          <div className="h-2.5 w-[64%] animate-pulse rounded bg-warm2" />
          <div className="h-2.5 w-[42%] animate-pulse rounded bg-warm2" />
        </div>
      </div>
    </div>
  );
}
