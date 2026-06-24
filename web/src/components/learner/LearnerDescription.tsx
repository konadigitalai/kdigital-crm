"use client";

// Editable description block on the learner page. Reads/writes the same
// lead.description field that the lead record page edits, so support team
// notes captured here are visible on the lead side and vice-versa.
//
// Click the row to expand into a textarea; Save persists via
// PATCH /leads/:number, Cancel reverts. Saving an empty value clears the
// field. router.refresh() pulls the canonical state back so we don't drift.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { updateLead } from "@/lib/api";

export function LearnerDescription({
  leadNumber,
  initial,
}: {
  leadNumber: string;
  initial: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Re-sync from props when the server returns fresh data (router.refresh).
  useEffect(() => {
    if (!editing) setDraft(initial ?? "");
  }, [initial, editing]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  async function save() {
    const next = draft.trim();
    const original = (initial ?? "").trim();
    if (next === original) { setEditing(false); return; }
    setBusy(true);
    setError(null);
    try {
      await updateLead(leadNumber, { description: next || null });
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setDraft(initial ?? "");
    setEditing(false);
    setError(null);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="-mx-1 block w-full rounded-md px-1 py-1 text-left text-[13px] leading-[1.5] text-ink2 transition hover:bg-warm2"
        title="Click to edit"
      >
        {initial && initial.trim().length > 0 ? (
          <span className="whitespace-pre-line">{initial}</span>
        ) : (
          <span className="italic text-hint">Click to add context — call summary, concerns, anything support should know.</span>
        )}
      </button>
    );
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Ctrl+Enter / Cmd+Enter → save without closing the textarea via a
    // blur; Esc → cancel. Plain Enter still inserts a newline.
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }

  return (
    <div>
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        rows={4}
        className="w-full resize-y rounded-md border border-rule bg-paper px-2.5 py-2 text-[13px] leading-[1.5] text-ink focus:border-brand-violet focus:outline-none focus:ring-1 focus:ring-brand-violet/20"
        placeholder="Where does this learner stand? What did they say in the last call?"
      />
      <div className="mt-1 text-[10.5px] text-hint">
        Enter for newline · Ctrl+Enter to save · Esc to cancel
      </div>
      {error && (
        <div className="mt-1.5 rounded-md border border-state-warn/30 bg-state-warn/10 px-2 py-1 text-[11.5px] text-state-warn">
          {error}
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={cancel}
          disabled={busy}
          className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-rule2 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-md bg-ink px-2.5 py-1 text-[11.5px] font-semibold text-white hover:bg-ink/90 disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
