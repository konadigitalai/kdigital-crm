"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { sendTwMessageInThread } from "@/lib/api";
import type { MediaAsset, TwChannel } from "@/lib/types";
import { AttachmentPicker } from "@/components/media/AttachmentPicker";
import { StagedStrip } from "@/components/media/StagedStrip";

export function ReplyBox({
  conversationId, channel, canUpload = false, canAddToLibrary = false, onSent,
}: {
  conversationId: string;
  /** Thread's channel — used for per-channel media validation. */
  channel: TwChannel;
  canUpload?: boolean;
  canAddToLibrary?: boolean;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<MediaAsset[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  async function submit() {
    const body = text.trim();
    if ((!body && staged.length === 0) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await sendTwMessageInThread(conversationId, body, staged.map((a) => a.id));
      if (!r.ok) {
        setError(r.errorMessage ?? `Send failed${r.errorCode ? ` (${r.errorCode})` : ""}`);
        return;
      }
      setText("");
      setStaged([]);
      onSent();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {staged.length > 0 && (
        <StagedStrip
          assets={staged}
          onRemove={(id) => setStaged((prev) => prev.filter((a) => a.id !== id))}
          className="mb-2"
        />
      )}
      <div className="flex items-end gap-2 rounded-[12px] border border-rule bg-warm/40 px-3 py-2 focus-within:border-brand-violet focus-within:ring-2 focus-within:ring-brand-violet/20">
        {canUpload && (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="mb-0.5 flex-shrink-0 text-mute hover:text-brand-violet"
            aria-label="Attach file"
            title="Attach file"
          >
            <Icon name="plus" size={16} strokeWidth={2} />
          </button>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
          }}
          rows={2}
          placeholder="Type a message… (Ctrl/⌘+Enter to send)"
          className="min-h-[36px] flex-1 resize-y bg-transparent text-[13px] text-ink placeholder:text-hint outline-none"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy || (!text.trim() && staged.length === 0)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold transition",
            (text.trim() || staged.length > 0) && !busy
              ? "bg-brand-violet text-white hover:bg-brand-violet/90"
              : "bg-warm2 text-mute cursor-not-allowed",
          )}
        >
          <Icon name="send" size={12} strokeWidth={2.2} />
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      {error && (
        <div className="mt-2 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
          {error}
        </div>
      )}
      {pickerOpen && (
        <AttachmentPicker
          channel={channel}
          canUpload={canUpload}
          canAddToLibrary={canAddToLibrary}
          onSelected={(asset) => {
            if (staged.length >= 10) {
              setError("You can attach at most 10 files per message.");
            } else if (!staged.some((a) => a.id === asset.id)) {
              setStaged((prev) => [...prev, asset]);
            }
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
