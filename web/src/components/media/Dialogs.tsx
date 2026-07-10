"use client";

// Small headless dialog primitives used by the media surfaces (folder create/
// rename, asset rename, delete confirm). Same "modal overlay + centered card"
// style as the SendMessageButton dialog and AttachmentPicker — keeps the
// visual language consistent instead of falling back to browser prompt()/confirm().

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";

// ─── PromptDialog ─────────────────────────────────────────────────────────
// Single-line text input + Confirm/Cancel. Resolves the callback with the
// trimmed string, or null if the user cancels. Autofocuses the input and
// pre-selects `initial` so users can just type over it.

export function PromptDialog({
  title, message, initial = "", confirmLabel = "Save",
  placeholder, busy = false, error = null,
  onSubmit, onClose,
}: {
  title: string;
  message?: string;
  initial?: string;
  confirmLabel?: string;
  placeholder?: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Autofocus + select-all on mount so the user can start typing straight
    // over the initial value.
    inputRef.current?.focus();
    inputRef.current?.select();
    // Esc closes the dialog (keyboard escape).
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function submit() {
    const v = value.trim();
    if (!v || busy) return;
    onSubmit(v);
  }

  return (
    <Overlay onClose={onClose}>
      <div className="w-full max-w-[440px] rounded-2xl border border-rule bg-paper p-6 shadow-card">
        <Header title={title} onClose={onClose} />
        {message && <p className="mt-1 text-[13px] text-ink2">{message}</p>}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          placeholder={placeholder}
          disabled={busy}
          className="mt-4 w-full rounded-[10px] border border-rule bg-warm/40 px-3 py-2 text-[14px] text-ink outline-none focus:border-brand-violet focus:ring-2 focus:ring-brand-violet/20 disabled:opacity-60"
        />
        {error && (
          <div className="mt-3 rounded-md border border-state-warn/40 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
            {error}
          </div>
        )}
        <div className="mt-5 flex items-center justify-end gap-2 border-t border-rule pt-4">
          <button type="button" onClick={onClose} disabled={busy} className="btn">Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !value.trim()}
            className="btn-grad disabled:opacity-60"
          >
            {busy ? "Saving…" : confirmLabel}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// ─── ConfirmDialog ────────────────────────────────────────────────────────
// Yes/No prompt with an optional destructive style. Resolves via onConfirm.

export function ConfirmDialog({
  title, message, confirmLabel = "Confirm", cancelLabel = "Cancel",
  destructive = false, busy = false, error = null,
  onConfirm, onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && !busy) onConfirm();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onConfirm, busy]);

  return (
    <Overlay onClose={onClose}>
      <div className="w-full max-w-[440px] rounded-2xl border border-rule bg-paper p-6 shadow-card">
        <Header title={title} onClose={onClose} />
        <p className="mt-2 text-[13.5px] leading-[1.5] text-ink2">{message}</p>
        {error && (
          <div className="mt-3 rounded-md border border-state-warn/40 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
            {error}
          </div>
        )}
        <div className="mt-5 flex items-center justify-end gap-2 border-t border-rule pt-4">
          <button type="button" onClick={onClose} disabled={busy} className="btn">{cancelLabel}</button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={cn(
              "rounded-md px-4 py-1.5 text-[13px] font-semibold text-white transition disabled:opacity-60",
              destructive ? "bg-state-warn hover:bg-state-warn/90" : "bg-brand-violet hover:bg-brand-violet/90",
            )}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// ─── shared bits ──────────────────────────────────────────────────────────

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="my-16" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

function Header({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <h2 className="font-serif text-[20px] font-normal leading-tight tracking-[-.01em]">{title}</h2>
      <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
        <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
      </button>
    </div>
  );
}
