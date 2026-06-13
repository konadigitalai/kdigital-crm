"use client";

// Interactive home-page command box. Persists the current session id in
// localStorage so refreshes keep the conversation alive. A small "New chat"
// button starts a fresh session.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { askEdify, getEdifySession } from "@/lib/api";
import { EdifyAnswer as EdifyAnswerCard } from "@/components/agents/EdifyAnswer";
import type { EdifyAnswer } from "@/lib/types";

const SESSION_KEY = "edify:home:sessionId";

const QUICK_PROMPTS: { icon: "send" | "clock" | "chart" | "star"; label: string }[] = [
  { icon: "send",  label: "Draft follow-ups for hot leads" },
  { icon: "clock", label: "Book demos for this week" },
  { icon: "chart", label: "Forecast May enrolments" },
  { icon: "star",  label: "Find leads at risk of churn" },
];

export function EdifyCommandBox() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Conversation in chronological order (oldest → newest), inverted on render.
  const [messages, setMessages] = useState<EdifyAnswer[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [hydrating, setHydrating] = useState(true);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [editingLatest, setEditingLatest] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // On mount: load the cached session id and rehydrate its messages.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = typeof window !== "undefined" ? window.localStorage.getItem(SESSION_KEY) : null;
      if (!cached) {
        setHydrating(false);
        return;
      }
      try {
        const data = await getEdifySession(cached);
        if (cancelled) return;
        if (data) {
          setSessionId(data.session.id);
          setMessages(data.messages);
        } else {
          // Session was deleted server-side; clear the stale id.
          window.localStorage.removeItem(SESSION_KEY);
        }
      } catch {
        // Ignore — fall back to a fresh chat.
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function submit(question: string, opts: { dropLast?: boolean } = {}) {
    const text = question.trim();
    if (!text || busy) return;
    setError(null);
    setQ("");
    setEditingLatest(null);
    if (opts.dropLast) setMessages((m) => m.slice(0, -1));
    setPendingQuestion(text);
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const out = await askEdify(text, sessionId, ctrl.signal);
      if (abortRef.current !== ctrl) return;
      setMessages((m) => [...m, out]);
      setPendingQuestion(null);
      if (!sessionId) {
        setSessionId(out.sessionId);
        window.localStorage.setItem(SESSION_KEY, out.sessionId);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
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

  function cancelPending() {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setPendingQuestion(null);
    setBusy(false);
  }

  function onEditAndResend(next: string) {
    if (!next.trim()) return;
    submit(next, { dropLast: true });
  }

  function newChat() {
    cancelPending();
    setMessages([]);
    setSessionId(null);
    setError(null);
    setEditingLatest(null);
    window.localStorage.removeItem(SESSION_KEY);
  }

  const hasMessages = messages.length > 0;

  return (
    <>
      <div className="mb-[18px] rounded-[22px] border border-rule2 bg-paper px-6 pb-4 pt-[22px] shadow-soft">
        {/* Session control strip */}
        {hasMessages && (
          <div className="mb-3 flex items-center gap-2 text-[11.5px]">
            <span className="mono-cap text-[9.5px] font-semibold tracking-[.12em] text-mute">
              Continuing chat · {messages.length} message{messages.length === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              onClick={newChat}
              disabled={busy}
              className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-rule bg-paper px-2.5 py-1 text-[11px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet disabled:opacity-50"
              title="Start a new chat"
            >
              <Icon name="plus" size={11} strokeWidth={2.4} />
              New chat
            </button>
            <Link
              href="/agents/edify"
              className="rounded-full border border-rule bg-paper px-2.5 py-1 text-[11px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
              title="Open full Edify chat"
            >
              All chats →
            </Link>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(q);
          }}
        >
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={hasMessages ? "Ask a follow-up…" : "What should your CRM do today?"}
            disabled={busy || hydrating}
            className={cn(
              "mb-9 w-full bg-transparent font-serif text-[19px] font-normal tracking-[.005em] text-ink placeholder:text-hint outline-none",
              (busy || hydrating) && "opacity-60",
            )}
            autoFocus
          />
          <div className="flex items-center gap-2.5">
            {!hasMessages && (
              <button
                type="button"
                onClick={newChat}
                disabled={busy || hydrating}
                title="Clear input"
                className="grid h-[34px] w-[34px] place-items-center rounded-full border border-rule bg-warm text-[18px] text-ink"
              >
                +
              </button>
            )}
            <div className="flex-1" />
            <div className="flex items-center gap-2 text-[13px] font-medium text-mute">
              Edify Agent
            </div>
            {busy ? (
              <button
                type="button"
                onClick={cancelPending}
                title="Stop generating"
                className="inline-flex h-[38px] items-center gap-1.5 rounded-full border border-state-warn/40 bg-state-warn/10 px-3 text-[12.5px] font-semibold text-state-warn hover:bg-state-warn/15"
              >
                <span className="grid h-3 w-3 place-items-center"><span className="block h-2.5 w-2.5 rounded-[2px] bg-state-warn" /></span>
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={hydrating || !q.trim()}
                className="grid h-[38px] w-[38px] place-items-center rounded-full bg-grad text-white shadow-glow disabled:opacity-50"
                title="Ask"
              >
                <Icon name="arrow-right" size={16} strokeWidth={2} />
              </button>
            )}
          </div>
        </form>

        {error && (
          <div className="mt-3 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
            {error}
          </div>
        )}
      </div>

      {/* Quick prompt chips — only shown when the chat is empty. */}
      {!hasMessages && (
        <div className="mb-12 flex flex-wrap gap-2 pl-0.5">
          {QUICK_PROMPTS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => submit(p.label)}
              disabled={busy || hydrating}
              className="group inline-flex items-center gap-2 rounded-full border border-rule bg-paper px-[14px] py-2 text-[13px] font-medium text-ink2 transition hover:-translate-y-px hover:border-brand-violet hover:text-brand-violet disabled:opacity-50"
            >
              <span className="flex h-[18px] w-[18px] items-center justify-center rounded-md bg-grad-soft">
                <Icon name={p.icon} size={11} strokeWidth={2} className="text-brand-violet" />
              </span>
              {p.label}
            </button>
          ))}
        </div>
      )}

      {/* Conversation — newest at bottom (chronological). */}
      {(hasMessages || pendingQuestion) && (
        <div className="mb-12 space-y-3">
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
    </>
  );
}

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" strokeOpacity=".3" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}

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
