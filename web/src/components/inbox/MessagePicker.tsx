"use client";

// Saved-messages picker for the composer. Mirrors AttachmentPicker: a modal that
// lists the tenant's saved messages (searchable by title), plus an inline form
// to save a new one. Picking a message hands its body back to the composer,
// which drops it into the input for the user to edit before sending.

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  createMessageTemplate, deleteMessageTemplate, getMessageTemplates, updateMessageTemplate,
} from "@/lib/api";
import type { MessageTemplate } from "@/lib/types";

export function MessagePicker({
  canManage,
  onPick,
  onClose,
}: {
  /** messaging.send — gates the create/edit/delete controls. */
  canManage: boolean;
  onPick: (body: string) => void;
  onClose: () => void;
}) {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  // null = list; "new" = create form; a template = edit form.
  const [editing, setEditing] = useState<null | "new" | MessageTemplate>(null);

  useEffect(() => {
    let alive = true;
    getMessageTemplates()
      .then((t) => { if (alive) setTemplates(t); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return templates;
    // Title-first so the picker matches how people remember canned replies,
    // but body too so "fee" finds a message that mentions fees in its text.
    return templates.filter(
      (t) => t.title.toLowerCase().includes(needle) || t.body.toLowerCase().includes(needle),
    );
  }, [templates, q]);

  async function remove(id: string) {
    const before = templates;
    setTemplates((prev) => prev.filter((t) => t.id !== id));
    try {
      await deleteMessageTemplate(id);
    } catch (err) {
      setTemplates(before);
      setError((err as Error).message);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-rule bg-paper shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-rule px-5 py-3.5">
          <div className="mono-cap text-[11px] font-semibold tracking-[.1em] text-ink">
            {editing === "new" ? "New saved message" : editing ? "Edit saved message" : "Saved messages"}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-mute hover:bg-warm hover:text-ink"
          >
            <Icon name="plus" size={16} strokeWidth={2.2} className="rotate-45" />
          </button>
        </div>

        {editing ? (
          <TemplateForm
            initial={editing === "new" ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={(saved) => {
              setTemplates((prev) => {
                const without = prev.filter((t) => t.id !== saved.id);
                return [...without, saved].sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
              });
              setEditing(null);
            }}
          />
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-rule px-4 py-2.5">
              <Icon name="search" size={13} strokeWidth={2} className="text-mute" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search saved messages…"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-hint outline-none"
              />
              {canManage && (
                <button
                  type="button"
                  onClick={() => setEditing("new")}
                  className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-ink px-3 py-1.5 text-[11.5px] font-semibold text-white transition hover:bg-[#241a2e]"
                >
                  <Icon name="plus" size={11} strokeWidth={2.6} />
                  New
                </button>
              )}
            </div>

            {error && (
              <div className="border-b border-rule bg-state-warn/10 px-4 py-2 text-[12px] text-state-warn">
                {error}
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {loading ? (
                <div className="p-8 text-center text-[12.5px] text-mute">Loading…</div>
              ) : filtered.length === 0 ? (
                <div className="p-8 text-center">
                  <div className="text-[13px] text-mute">
                    {templates.length === 0 ? "No saved messages yet." : `Nothing matches “${q.trim()}”.`}
                  </div>
                  {canManage && templates.length === 0 && (
                    <button
                      type="button"
                      onClick={() => setEditing("new")}
                      className="mt-3 inline-flex items-center gap-1 rounded-full bg-ink px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#241a2e]"
                    >
                      <Icon name="plus" size={11} strokeWidth={2.6} />
                      Save your first message
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {filtered.map((t) => (
                    <div
                      key={t.id}
                      className="group flex items-start gap-2 rounded-xl border border-transparent px-3 py-2.5 transition hover:border-rule hover:bg-warm/50"
                    >
                      <button
                        type="button"
                        onClick={() => onPick(t.body)}
                        className="min-w-0 flex-1 text-left"
                        title="Insert into the composer"
                      >
                        <div className="truncate text-[13px] font-semibold text-ink">{t.title}</div>
                        <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-mute">{t.body}</div>
                      </button>
                      {canManage && (
                        <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                          <button
                            type="button"
                            onClick={() => setEditing(t)}
                            aria-label="Edit"
                            className="rounded-md p-1.5 text-mute hover:bg-warm2 hover:text-ink"
                          >
                            <Icon name="settings" size={13} strokeWidth={2} />
                          </button>
                          <button
                            type="button"
                            onClick={() => remove(t.id)}
                            aria-label="Delete"
                            className="rounded-md p-1.5 text-mute hover:bg-state-warn/10 hover:text-state-warn"
                          >
                            <Icon name="plus" size={13} strokeWidth={2.2} className="rotate-45" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t border-rule px-4 py-2 text-center text-[11px] text-hint">
              Click a message to drop it into the composer — you can edit before sending.
            </div>
          </>
        )}
      </div>
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
    <div className="flex flex-col gap-3 p-5">
      <div>
        <label className="mono-cap mb-1.5 block text-[9.5px] tracking-[.1em] text-mute">Title</label>
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
          placeholder="e.g. Fee structure · Demo follow-up"
          className="w-full rounded-[10px] border border-rule bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-hint outline-none focus:border-brand-violet"
        />
      </div>
      <div>
        <label className="mono-cap mb-1.5 block text-[9.5px] tracking-[.1em] text-mute">Message</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={4000}
          rows={6}
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
        <button
          type="button"
          onClick={onCancel}
          className="rounded-[10px] border border-rule bg-paper px-4 py-2 text-[12.5px] font-semibold text-ink2 hover:bg-warm"
        >
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
  );
}
