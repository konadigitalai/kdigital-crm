"use client";

// Center-pane message timeline. Outbound bubbles right, inbound left.
// Status icons: ✓ sent, ✓✓ delivered, ✓✓ read (blue), ! failed.

import { useEffect, useRef } from "react";
import type { WaConversationDetail, WaMessage } from "@/lib/types";

export function ThreadView({ thread }: { thread: WaConversationDetail }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Auto-scroll to bottom when a new message lands. The detail endpoint
  // returns oldest-first so the last entry is the newest.
  const lastId = thread.messages[thread.messages.length - 1]?.id;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lastId]);

  return (
    <div ref={scrollRef} className="flex flex-1 flex-col gap-2 overflow-y-auto px-6 py-5">
      {thread.messages.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-mute">
          No messages yet. Send the first one below.
        </div>
      ) : (
        thread.messages.map((m) => <MessageBubble key={m.id} m={m} />)
      )}
    </div>
  );
}

function MessageBubble({ m }: { m: WaMessage }) {
  const inbound = m.direction === "inbound";
  const failed = m.status === "failed";
  return (
    <div
      className={
        "flex max-w-[78%] flex-col " +
        (inbound ? "self-start" : "self-end")
      }
    >
      <div
        className={
          "rounded-2xl px-3.5 py-2 text-[13px] leading-[1.45] " +
          (inbound
            ? "bg-paper text-ink shadow-[0_1px_2px_rgba(14,10,20,.05)]"
            : failed
              ? "bg-state-warn/10 text-state-warn"
              : "bg-brand-violet text-white")
        }
      >
        {m.contentType !== "text" && m.contentType !== "template" && (
          <div className={"mono-cap mb-1 text-[9px] font-semibold tracking-[.1em] " + (inbound || failed ? "text-mute" : "text-white/70")}>
            {m.contentType}
          </div>
        )}
        {m.templateName && (
          <div className={"mono-cap mb-1 text-[9px] font-semibold tracking-[.1em] " + (inbound || failed ? "text-mute" : "text-white/70")}>
            template · {m.templateName}
          </div>
        )}
        <div className="whitespace-pre-wrap break-words">{m.body ?? "(no body)"}</div>
        {m.errorMessage && failed && (
          <div className="mono-cap mt-1 text-[9px] tracking-[.04em] text-state-warn">
            {m.errorMessage}
          </div>
        )}
      </div>
      <div className={"mt-1 flex items-center gap-1.5 text-[10.5px] text-mute " + (inbound ? "" : "justify-end")}>
        <span>{formatClock(m.sentAt)}</span>
        {!inbound && <StatusGlyph status={m.status} />}
      </div>
    </div>
  );
}

function StatusGlyph({ status }: { status: WaMessage["status"] }) {
  if (status === "read") return <span className="text-brand-blue">✓✓</span>;
  if (status === "delivered") return <span>✓✓</span>;
  if (status === "sent") return <span>✓</span>;
  if (status === "queued") return <span className="text-hint">…</span>;
  return <span className="text-state-warn">!</span>;
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
}
