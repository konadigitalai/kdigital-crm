"use client";

// Admin "Saved messages" library — the management surface for canned replies.
// Same shape as the Media library: a header card with a create button, then a
// searchable grid. The inbox composer's MessagePicker inserts these; this is
// where they're curated. Both hit the same /message-templates API.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  createMessageTemplate, deleteMessageTemplate, getMessageTemplates, updateMessageTemplate,
} from "@/lib/api";
import type { MessageTemplate } from "@/lib/types";

type Dialog =
  | { kind: "none" }
  | { kind: "new" }
  | { kind: "edit"; template: MessageTemplate }
  | { kind: "delete"; template: MessageTemplate };

export function MessageTemplatesLibrary({ canManage }: { canManage: boolean }) {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });

  const refresh = useCallback(async () => {
    try {
      setTemplates(await getMessageTemplates());
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return templates;
    return templates.filter(
      (t) => t.title.toLowerCase().includes(needle) || t.body.toLowerCase().includes(needle),
    );
  }, [templates, q]);

  async function remove(t: MessageTemplate) {
    const before = templates;
    setTemplates((prev) => prev.filter((x) => x.id !== t.id));
    setDialog({ kind: "none" });
    try {
      await deleteMessageTemplate(t.id);
    } catch (err) {
      setTemplates(before);
      setError((err as Error).message);
    }
  }

  function upsert(saved: MessageTemplate) {
    setTemplates((prev) => {
      const without = prev.filter((t) => t.id !== saved.id);
      return [...without, saved].sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
    });
    setDialog({ kind: "none" });
  }

  return (
    <div className="rounded-2xl border border-rule bg-paper">
      <div className="flex items-center justify-between border-b border-rule px-5 py-3">
        <h1 className="font-serif text-[22px] font-normal tracking-[-.01em]">Saved messages</h1>
        {canManage && (
          <button
            type="button"
            onClick={() => setDialog({ kind: "new" })}
            className="inline-flex items-center gap-1.5 rounded-md border border-brand-violet bg-brand-violet px-3 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-brand-violet/90"
          >
            <Icon name="plus" size={12} strokeWidth={2.4} />
            New message
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 border-b border-rule px-5 py-2.5">
        <Icon name="search" size={13} strokeWidth={2} className="text-mute" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search saved messages…"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-hint outline-none"
        />
        <span className="mono-cap text-[10px] tracking-[.06em] text-hint">
          {templates.length} saved
        </span>
      </div>

      <div className="min-h-[420px] p-5">
        {error && (
          <div className="mb-3 rounded-md border border-state-warn/40 bg-state-warn/10 p-3 text-[12.5px] text-state-warn">
            {error}
          </div>
        )}

        {loading ? (
          <div className="p-6 text-center text-[12.5px] text-mute">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="rounded-md border border-dashed border-rule2 p-10 text-center">
            <Icon name="message-square" size={26} strokeWidth={1.5} className="mx-auto mb-2 text-hint" />
            <div className="text-[13px] text-mute">
              {templates.length === 0 ? "No saved messages yet." : `Nothing matches “${q.trim()}”.`}
            </div>
            {canManage && templates.length === 0 && (
              <button
                type="button"
                onClick={() => setDialog({ kind: "new" })}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-ink px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#241a2e]"
              >
                <Icon name="plus" size={11} strokeWidth={2.6} />
                Save your first message
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((t) => (
              <div
                key={t.id}
                className="group flex flex-col rounded-xl border border-rule bg-warm/30 p-4 transition hover:border-brand-violet/50 hover:shadow-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="truncate text-[13.5px] font-bold text-ink" title={t.title}>{t.title}</div>
                  {canManage && (
                    <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => setDialog({ kind: "edit", template: t })}
                        aria-label="Edit"
                        className="rounded-md p-1.5 text-mute hover:bg-warm2 hover:text-ink"
                      >
                        <Icon name="settings" size={13} strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDialog({ kind: "delete", template: t })}
                        aria-label="Delete"
                        className="rounded-md p-1.5 text-mute hover:bg-state-warn/10 hover:text-state-warn"
                      >
                        <Icon name="plus" size={13} strokeWidth={2.2} className="rotate-45" />
                      </button>
                    </div>
                  )}
                </div>
                <div className="mt-1.5 line-clamp-5 whitespace-pre-wrap text-[12px] leading-snug text-mute">
                  {t.body}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {(dialog.kind === "new" || dialog.kind === "edit") && (
        <TemplateForm
          initial={dialog.kind === "edit" ? dialog.template : null}
          onCancel={() => setDialog({ kind: "none" })}
          onSaved={upsert}
        />
      )}
      {dialog.kind === "delete" && (
        <ConfirmDelete
          template={dialog.template}
          onCancel={() => setDialog({ kind: "none" })}
          onConfirm={() => remove(dialog.template)}
        />
      )}
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm">
      {children}
    </div>
  );
}

function TemplateForm({
  initial, onCancel, onSaved,
}: {
  initial: MessageTemplate | null;
  onCancel: () => void;
  onSaved: (t: MessageTemplate) => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onCancel(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  async function save() {
    const t = title.trim();
    const b = body.trim();
    if (!t || !b) { setError("Both a title and message text are required."); return; }
    setBusy(true);
    setError(null);
    try {
      const saved = initial
        ? await updateMessageTemplate(initial.id, { title: t, body: b })
        : await createMessageTemplate({ title: t, body: b });
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Overlay>
      <div
        className="flex w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-rule bg-paper shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-rule px-5 py-3.5">
          <span className="mono-cap text-[11px] font-semibold tracking-[.1em] text-ink">
            {initial ? "Edit saved message" : "New saved message"}
          </span>
          <button type="button" onClick={onCancel} aria-label="Close" className="rounded-md p-1.5 text-mute hover:bg-warm hover:text-ink">
            <Icon name="plus" size={16} strokeWidth={2.2} className="rotate-45" />
          </button>
        </div>

        <div className="flex flex-col gap-3 p-5">
          <div>
            <label className="mono-cap mb-1.5 block text-[9.5px] tracking-[.1em] text-mute">Title</label>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              placeholder="e.g. Welcome message · Fee structure"
              className="w-full rounded-[10px] border border-rule bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-hint outline-none focus:border-brand-violet"
            />
          </div>
          <div>
            <label className="mono-cap mb-1.5 block text-[9.5px] tracking-[.1em] text-mute">Message</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={4000}
              rows={7}
              placeholder="The message text that gets inserted into the composer…"
              className="w-full resize-y rounded-[10px] border border-rule bg-paper px-3 py-2 text-[13px] leading-[1.4] text-ink placeholder:text-hint outline-none focus:border-brand-violet"
            />
            <div className="mt-1 text-right text-[10px] text-hint">{body.length}/4000</div>
          </div>

          {error && (
            <div className="rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onCancel} className="rounded-[10px] border border-rule bg-paper px-4 py-2 text-[12.5px] font-semibold text-ink2 hover:bg-warm">
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="rounded-[10px] bg-ink px-4 py-2 text-[12.5px] font-semibold text-white transition hover:bg-[#241a2e] disabled:opacity-50"
            >
              {busy ? "Saving…" : initial ? "Save changes" : "Save message"}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}

function ConfirmDelete({
  template, onCancel, onConfirm,
}: {
  template: MessageTemplate;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Overlay>
      <div className="w-full max-w-[420px] rounded-2xl border border-rule bg-paper p-5 shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="text-[14px] font-bold text-ink">Delete saved message?</div>
        <div className="mt-1.5 text-[12.5px] text-mute">
          “<span className="font-semibold text-ink2">{template.title}</span>” will be removed for everyone. This can&apos;t be undone.
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-[10px] border border-rule bg-paper px-4 py-2 text-[12.5px] font-semibold text-ink2 hover:bg-warm">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} className="rounded-[10px] bg-state-warn px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-state-warn/90">
            Delete
          </button>
        </div>
      </div>
    </Overlay>
  );
}
