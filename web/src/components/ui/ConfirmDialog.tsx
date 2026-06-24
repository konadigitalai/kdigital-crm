"use client";

// Small in-app confirmation modal. Replaces window.confirm() at delete /
// destructive-action sites so the dialog matches the rest of the UI and
// supports a "danger" variant for destructive intent.
//
// Usage:
//   const [open, setOpen] = useState(false);
//   <ConfirmDialog
//     open={open}
//     title="Delete lead LEAD-9788?"
//     body="This hides the lead but keeps history…"
//     confirmLabel="Delete"
//     variant="danger"
//     onConfirm={async () => { await doIt(); setOpen(false); }}
//     onCancel={() => setOpen(false)}
//   />

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "danger";
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Esc closes; focus the cancel button on open so Enter doesn't accidentally
  // confirm a destructive action.
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        // Click outside cancels; click on the panel does nothing.
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="w-full max-w-[440px] rounded-2xl border border-rule bg-paper p-5 shadow-card">
        <h2 className="mb-2 font-serif text-[22px] leading-tight tracking-tight text-ink">
          {title}
        </h2>
        {body && (
          <div className="mb-5 text-[13.5px] leading-[1.5] text-ink2">{body}</div>
        )}
        <div className="flex justify-end gap-2.5">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-rule bg-paper px-3.5 py-1.5 text-[12.5px] font-semibold text-ink2 hover:border-rule2 hover:text-ink disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className={cn(
              "rounded-md px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition disabled:opacity-60",
              variant === "danger"
                ? "bg-state-warn hover:bg-state-warn/90"
                : "bg-ink hover:bg-ink/90",
            )}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
