"use client";

// "Share to Slack" button + preview/confirm dialog. Drop into any record
// page (lead, learner, case). Fetches the rendered preview from the API on
// open, lets the user add a note, then POSTs to /share/slack/.../...
//
// The button is hidden if the surface isn't configured for sharing — admins
// set that up at /admin/integrations/slack.

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { getSharePreview, shareToSlack } from "@/lib/api";
import type { ShareSurface, SlackSharePreview } from "@/lib/types";

export function ShareToSlackButton({
  surface,
  recordId,
  label = "Share to Slack",
  className,
}: {
  surface: ShareSurface;
  recordId: string;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-[9px] border border-rule bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-ink2 transition hover:border-brand-violet hover:text-brand-violet",
          className,
        )}
      >
        <Icon name="send" size={12} strokeWidth={2.2} />
        {label}
      </button>
      {open && (
        <ShareToSlackDialog
          surface={surface}
          recordId={recordId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ShareToSlackDialog({
  surface,
  recordId,
  onClose,
}: {
  surface: ShareSurface;
  recordId: string;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<SlackSharePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    getSharePreview(surface, recordId)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e: Error) => { if (!cancelled) setLoadError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [surface, recordId]);

  async function onSend() {
    setBusy(true);
    setSendError(null);
    try {
      await shareToSlack(surface, recordId, notes.trim() || null);
      setDone(true);
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="my-12 w-full max-w-[640px] rounded-2xl border border-rule bg-paper p-7 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[24px] font-normal leading-tight tracking-[-.01em]">Share to Slack</h2>
            <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">
              {preview?.target.channel ? (
                <>Sending to <b className="text-ink">{preview.target.channel}</b>. The fields below are pre-configured by your admin.</>
              ) : (
                <>Sending to the channel configured by your admin.</>
              )}
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>

        {loading && (
          <div className="my-10 text-center text-[13px] text-mute">Loading preview…</div>
        )}

        {loadError && (
          <div className="my-4 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
            {loadError}
          </div>
        )}

        {preview && !loadError && !done && (
          <>
            <div className="mb-4 rounded-[12px] border border-rule bg-warm/40 p-4">
              <div className="mono-cap mb-2 text-[9.5px] font-semibold tracking-[.12em] text-mute">
                Preview
              </div>
              <div className="font-serif text-[16px] leading-tight tracking-[-.01em]">
                {preview.preview.text}
              </div>
              <FieldsGrid preview={preview} />
            </div>

            <label className="mb-4 block">
              <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">
                Add notes (optional)
              </span>
              <textarea
                className="w-full resize-y rounded-[10px] border border-rule bg-paper p-3 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
                rows={3}
                placeholder="Add context for the channel — e.g. 'High-intent, follow up by Friday'"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <span className="mono-cap mt-1 block text-[10px] tracking-[.04em] text-hint">
                Notes appear at the bottom of the message, attributed to your name.
              </span>
            </label>

            {sendError && (
              <div className="mb-3 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
                {sendError}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 border-t border-rule pt-4">
              <button type="button" onClick={onClose} disabled={busy} className="btn">
                Cancel
              </button>
              <button type="button" onClick={onSend} disabled={busy} className="btn-grad disabled:opacity-60">
                {busy ? "Sending…" : "Send to Slack"}
              </button>
            </div>
          </>
        )}

        {done && (
          <div className="my-6 rounded-[12px] border border-state-ok/30 bg-state-ok/10 p-4 text-center">
            <Icon name="check" size={20} strokeWidth={2.2} className="mx-auto mb-2 text-state-ok" />
            <div className="text-[14px] font-semibold text-ink">Shared to Slack</div>
            <div className="mt-1 text-[12.5px] text-mute">
              Your message is in {preview?.target.channel ?? "the channel"}.
            </div>
            <button
              type="button"
              onClick={onClose}
              className="mt-4 rounded-md border border-rule bg-paper px-4 py-1.5 text-[12.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FieldsGrid({ preview }: { preview: SlackSharePreview }) {
  const r = preview.record as Record<string, unknown>;
  const blocks = preview.preview.blocks as Array<Record<string, unknown>>;
  // Pull section blocks with `fields` arrays — those are the field rows
  // in the rendered preview. We re-render them in the dialog's typography
  // rather than show raw Block Kit JSON.
  const fieldRows: { label: string; value: string }[] = [];
  for (const blk of blocks) {
    const fields = blk.fields as Array<{ text: string }> | undefined;
    if (!Array.isArray(fields)) continue;
    for (const f of fields) {
      const txt = String(f.text ?? "");
      const idx = txt.indexOf("\n");
      if (idx <= 0) continue;
      const label = txt.slice(0, idx).replace(/^\*+|\*+$/g, "");
      const value = txt.slice(idx + 1);
      fieldRows.push({ label, value });
    }
  }
  if (fieldRows.length === 0) return null;
  void r;
  return (
    <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2.5">
      {fieldRows.map((f, i) => (
        <div key={i} className="min-w-0">
          <div className="mono-cap text-[9.5px] font-semibold tracking-[.06em] text-mute">{f.label}</div>
          <div className="truncate text-[13px] text-ink">{f.value}</div>
        </div>
      ))}
    </div>
  );
}
