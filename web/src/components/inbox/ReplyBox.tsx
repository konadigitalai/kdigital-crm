"use client";

import { useRef, useState } from "react";
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
  const taRef = useRef<HTMLTextAreaElement>(null);

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
      // Return focus to the textarea so the user can keep typing.
      requestAnimationFrame(() => taRef.current?.focus());
      onSent();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // WhatsApp-style key handling:
  //   Enter               → send
  //   Shift+Enter         → newline
  //   Ctrl/Cmd+Enter      → also send (kept for muscle memory)
  //   IME composition     → let the composition finish, don't send
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter") return;
    // e.nativeEvent.isComposing is true while an IME is active (e.g. picking
    // a CJK candidate). Enter there confirms the character, not the message.
    if (e.nativeEvent.isComposing) return;
    if (e.shiftKey) return; // allow newline
    e.preventDefault();
    void submit();
  }

  return (
    <div>
      {staged.length > 0 && (
        <StagedStrip
          assets={staged}
          onRemove={(id) => setStaged((prev) => prev.filter((a) => a.id !== id))}
          className="mb-2 px-1"
        />
      )}
      <div className="flex items-end gap-2 rounded-full bg-white px-3 py-2 shadow-sm focus-within:shadow">
        {canUpload && (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="mb-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-mute transition hover:bg-warm hover:text-brand-violet"
            aria-label="Attach file"
            title="Attach file"
          >
            <Icon name="plus" size={18} strokeWidth={2} />
          </button>
        )}
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Type a message"
          className="max-h-[160px] min-h-[24px] flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-[1.35] text-ink placeholder:text-mute outline-none"
          disabled={busy}
        />
        {/* Right-side placeholder — kept empty for now to leave room for
            future actions (voice, emoji). No Send button — Enter sends. */}
        <span className="mb-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center text-mute">
          {busy ? (
            <span className="animate-pulse text-[10px] font-mono">…</span>
          ) : (
            <span className="mono-cap text-[8.5px] tracking-[.08em] text-hint" title="Press Enter to send · Shift+Enter for a new line">
              ↵
            </span>
          )}
        </span>
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
