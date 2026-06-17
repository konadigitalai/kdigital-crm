"use client";

// Reply box. Two modes:
//   • Text — only valid inside the 24h service window. Disabled otherwise
//     with a banner pointing the user at templates.
//   • Template — picker + per-variable inputs, live preview, send.
//
// We compute "in window" client-side from conversation.lastInboundAt so
// the UI can hide the text input proactively. The server enforces the
// same rule so a stale client can't bypass it.

import { useMemo, useState } from "react";
import type { WaConversationDetail, WaTemplate } from "@/lib/types";
import { Icon } from "@/components/ui/Icon";

const WINDOW_MS = 24 * 60 * 60 * 1000;

export function ReplyBox({
  conversation,
  templates,
  canSend,
  onSend,
}: {
  conversation: WaConversationDetail["conversation"];
  templates: WaTemplate[];
  canSend: boolean;
  // Returns true on success so the box can clear its inputs. void allowed
  // for the early-return paths in the parent (e.g. no selection).
  onSend: (input: { body?: string; templateId?: string; variables?: Record<string, string> }) => Promise<boolean | void>;
}) {
  const inWindow = useMemo(() => {
    if (!conversation.lastInboundAt) return false;
    return Date.now() - new Date(conversation.lastInboundAt).getTime() < WINDOW_MS;
  }, [conversation.lastInboundAt]);

  const [mode, setMode] = useState<"text" | "template">(inWindow ? "text" : "template");
  const [text, setText] = useState("");
  const [templateId, setTemplateId] = useState<string>(
    templates.find((t) => t.status === "approved")?.id ?? "",
  );
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // Approved-only for the picker; show count of others as a hint.
  const approved = useMemo(() => templates.filter((t) => t.status === "approved"), [templates]);
  const tpl = approved.find((t) => t.id === templateId);

  const preview = useMemo(() => {
    if (!tpl) return "";
    return tpl.bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, idx) => variables[String(idx)] ?? "");
  }, [tpl, variables]);

  async function send() {
    if (!canSend) return;
    setBusy(true);
    let ok: boolean | void = false;
    try {
      if (mode === "text") {
        if (!text.trim()) return;
        ok = await onSend({ body: text.trim() });
      } else {
        if (!tpl) return;
        ok = await onSend({ templateId: tpl.id, variables });
      }
      if (ok === true) {
        setText("");
        setVariables({});
      }
    } finally {
      setBusy(false);
    }
  }

  if (!canSend) {
    return (
      <div className="px-4 py-3 text-[12.5px] text-mute">
        You don&apos;t have permission to send messages. Ask an admin for the <span className="font-mono">whatsapp.send</span> permission.
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      {/* Mode tabs + window indicator */}
      <div className="mb-2 flex items-center gap-1.5">
        {(["text", "template"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            disabled={m === "text" && !inWindow}
            title={m === "text" && !inWindow ? "Outside the 24h service window — use a template" : undefined}
            className={
              "rounded-md border px-2.5 py-1 text-[11.5px] font-semibold capitalize transition disabled:cursor-not-allowed disabled:opacity-50 " +
              (mode === m
                ? "border-brand-violet bg-brand-violet/10 text-brand-violet"
                : "border-rule bg-paper text-mute hover:border-rule2 hover:text-ink")
            }
          >
            {m}
          </button>
        ))}
        <span className="ml-auto text-[10.5px] text-mute">
          {inWindow ? (
            <span className="text-state-ok">✓ in 24h window</span>
          ) : (
            <span>Outside service window — template only</span>
          )}
        </span>
      </div>

      {mode === "text" ? (
        <div className="flex gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="Type a message — Shift+Enter for newline, Enter to send"
            className="min-h-[44px] flex-1 resize-none rounded-md border border-rule bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
          />
          <button
            type="button"
            onClick={send}
            disabled={busy || !text.trim()}
            className="self-end rounded-md bg-brand-violet px-4 py-2 text-[13px] font-semibold text-white shadow-[0_1px_3px_rgba(14,10,20,.08)] transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Sending…" : "Send"}
            <Icon name="send" size={12} strokeWidth={2.4} className="ml-1.5 inline-block" />
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {approved.length === 0 ? (
            <div className="rounded-md border border-state-amber/40 bg-state-amber/5 p-3 text-[12.5px] text-state-amber">
              No approved templates yet. An admin needs to sync from Meta — Admin → Integrations → WhatsApp → Sync.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={templateId}
                  onChange={(e) => { setTemplateId(e.target.value); setVariables({}); }}
                  className="flex-1 rounded-md border border-rule bg-paper px-3 py-1.5 text-[12.5px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
                >
                  {approved.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.templateName} · {t.language} · {t.category}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={send}
                  disabled={busy || !tpl}
                  className="rounded-md bg-brand-violet px-4 py-1.5 text-[12.5px] font-semibold text-white shadow-[0_1px_3px_rgba(14,10,20,.08)] transition hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? "Sending…" : "Send"}
                </button>
              </div>
              {tpl && tpl.variableCount > 0 && (
                <div className="grid grid-cols-2 gap-2">
                  {Array.from({ length: tpl.variableCount }, (_, i) => i + 1).map((idx) => (
                    <label key={idx} className="block">
                      <span className="mono-cap mb-0.5 block text-[9px] font-semibold tracking-[.1em] text-mute">{`{{${idx}}}`}</span>
                      <input
                        value={variables[String(idx)] ?? ""}
                        onChange={(e) => setVariables((p) => ({ ...p, [String(idx)]: e.target.value }))}
                        className="w-full rounded-md border border-rule bg-paper px-2.5 py-1 text-[12.5px] text-ink focus:border-brand-violet focus:outline-none"
                      />
                    </label>
                  ))}
                </div>
              )}
              {tpl && (
                <div className="rounded-md border border-rule bg-warm/40 px-3 py-2 text-[12.5px] leading-[1.45] text-ink">
                  <span className="mono-cap mr-1.5 text-[9px] font-semibold tracking-[.1em] text-mute">preview</span>
                  <span className="whitespace-pre-line">{preview}</span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
