"use client";

// Admin "Trash" table for soft-deleted leads. Each row has Restore (per the
// leads.write gate, which the page-level guard already requires) and an
// optional Permanently delete (gated by leads.purge). Both confirm first;
// neither is bulk in v1 — purge is irreversible and worth a per-row tap.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import { purgeLead, restoreLead } from "@/lib/api";
import type { DeletedLead } from "@/lib/types";
import { emitCrmMutation } from "@/lib/live-summary";

export function DeletedLeadsTable({
  initial,
  canPurge,
}: {
  initial: DeletedLead[];
  canPurge: boolean;
}) {
  const router = useRouter();
  const [leads, setLeads] = useState<DeletedLead[]>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // In-app confirm state (replaces window.confirm / prompt).
  const [restoring, setRestoring] = useState<DeletedLead | null>(null);
  const [purging, setPurging] = useState<DeletedLead | null>(null);

  async function doRestore(lead: DeletedLead) {
    setBusy(lead.id);
    setError(null);
    setFlash(null);
    setLeads((all) => all.filter((x) => x.id !== lead.id)); // optimistic
    try {
      await restoreLead(lead.id);
      emitCrmMutation("lead.restored");
      setFlash(`Restored ${lead.number} — back in the pipeline.`);
      router.refresh();
    } catch (err) {
      setError(`Couldn't restore ${lead.number}: ${(err as Error).message}`);
      // Refetch to recover the row.
      router.refresh();
    } finally {
      setBusy(null);
      setRestoring(null);
    }
  }

  async function doPurge(lead: DeletedLead) {
    setBusy(lead.id);
    setError(null);
    setFlash(null);
    setLeads((all) => all.filter((x) => x.id !== lead.id)); // optimistic
    try {
      await purgeLead(lead.id);
      emitCrmMutation("lead.purged");
      setFlash(`Permanently deleted ${lead.number}.`);
      router.refresh();
    } catch (err) {
      setError(`Couldn't purge ${lead.number}: ${(err as Error).message}`);
      router.refresh();
    } finally {
      setBusy(null);
      setPurging(null);
    }
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[13px] text-mute">
          {leads.length} deleted lead{leads.length === 1 ? "" : "s"}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <Row hdr>
          <div>Lead</div>
          <div>Email · Phone</div>
          <div>Program</div>
          <div>Advisor</div>
          <div>Deleted</div>
          <div className="text-right">Actions</div>
        </Row>

        {leads.length === 0 ? (
          <div className="px-[22px] py-10 text-center text-[13px] text-mute">
            Nothing here. Deleted leads from the pipeline will appear in this list.
          </div>
        ) : (
          leads.map((l) => (
            <Row key={l.id}>
              <div className="min-w-0">
                <Link
                  href={`/records/${l.number}`}
                  className="text-[13.5px] font-semibold tracking-[-.005em] text-ink hover:text-brand-violet"
                >
                  {l.name}
                </Link>
                <div className="mono-cap mt-0.5 text-[10px] tracking-[.06em] text-mute">{l.number}</div>
              </div>
              <div className="min-w-0 text-[12.5px] text-ink2">
                <div className="truncate">{l.email ?? <span className="text-hint">—</span>}</div>
                <div className="truncate text-mute">{l.phone ?? <span className="text-hint">—</span>}</div>
              </div>
              <div className="truncate text-[13px] text-ink2">{l.program ?? <span className="text-hint">—</span>}</div>
              <div className="truncate text-[13px] text-ink2">{l.advisorName ?? <span className="text-hint">—</span>}</div>
              <div className="text-[12.5px] text-mute">{formatWhen(l.deletedAt)}</div>
              <div className="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setRestoring(l)}
                  disabled={busy === l.id}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet disabled:opacity-40"
                >
                  Restore
                </button>
                {canPurge && (
                  <button
                    type="button"
                    onClick={() => setPurging(l)}
                    disabled={busy === l.id}
                    title="Permanently delete — no undo"
                    className="rounded-md border border-state-warn/40 bg-state-warn/5 px-2.5 py-1 text-[11.5px] font-semibold text-state-warn hover:border-state-warn hover:bg-state-warn/10 disabled:opacity-40"
                  >
                    Permanently delete
                  </button>
                )}
              </div>
            </Row>
          ))
        )}
      </div>

      {flash && (
        <div className="mt-4 rounded-lg border border-state-ok/30 bg-state-ok/10 px-3 py-2 text-[12px] text-state-ok">
          {flash}
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
          {error}
        </div>
      )}

      {/* Restore confirmation — non-destructive, so a simple ConfirmDialog. */}
      <ConfirmDialog
        open={!!restoring}
        title={restoring ? `Restore ${restoring.number}?` : ""}
        body={restoring && (
          <>
            <p className="mb-1.5">
              <span className="font-semibold text-ink">{restoring.name}</span> will reappear in the pipeline and search.
            </p>
            <p className="text-mute">Activity history is already preserved.</p>
          </>
        )}
        confirmLabel="Restore"
        onConfirm={() => (restoring ? doRestore(restoring) : Promise.resolve())}
        onCancel={() => setRestoring(null)}
      />

      {/* Purge confirmation — irreversible; requires typing the lead number. */}
      <PurgeConfirmDialog
        lead={purging}
        onCancel={() => setPurging(null)}
        onConfirm={() => (purging ? doPurge(purging) : Promise.resolve())}
      />
    </>
  );
}

// Dedicated "type the lead number to confirm" dialog for purge. Kept
// alongside ConfirmDialog rather than adding a "requires-typed-input"
// variant to that shared component — only the purge flow needs this.
function PurgeConfirmDialog({
  lead,
  onCancel,
  onConfirm,
}: {
  lead: DeletedLead | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the input each time the dialog is opened on a fresh row.
  useEffect(() => {
    setTyped("");
    setBusy(false);
    if (lead) {
      // Focus the input on next paint so the caret is ready.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [lead]);

  // Esc closes; guard against Esc while a purge is in flight.
  useEffect(() => {
    if (!lead) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lead, busy, onCancel]);

  if (!lead) return null;
  const matches = typed.trim().toUpperCase() === lead.number.toUpperCase();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!matches || busy) return;
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
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-[480px] rounded-2xl border border-rule bg-paper p-5 shadow-card"
      >
        <h2 className="mb-2 font-serif text-[22px] leading-tight tracking-tight text-ink">
          Permanently delete {lead.number}?
        </h2>
        <div className="mb-4 text-[13.5px] leading-[1.5] text-ink2">
          <p className="mb-1.5">
            <span className="font-semibold text-ink">&ldquo;{lead.name}&rdquo;</span> and all its data will be wiped —
            activity timeline, score signals, agent assignments. There is <span className="font-semibold text-state-warn">no undo</span>.
          </p>
          <p className="text-mute">
            Type the lead number <span className="mono-cap font-semibold text-ink">{lead.number}</span> below to confirm.
          </p>
        </div>
        <input
          ref={inputRef}
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={lead.number}
          disabled={busy}
          className="mb-4 w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20 disabled:opacity-60"
        />
        <div className="flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-rule bg-paper px-3.5 py-1.5 text-[12.5px] font-semibold text-ink2 hover:border-rule2 hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!matches || busy}
            className="rounded-md bg-state-warn px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-state-warn/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? "Deleting…" : "Permanently delete"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Row({
  hdr = false,
  children,
}: {
  hdr?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid items-center gap-4 px-[22px] border-b border-rule last:border-b-0",
        hdr ? "mono-cap py-3 text-[9.5px] font-semibold tracking-[.12em] text-mute bg-warm" : "py-3.5",
      )}
      style={{ gridTemplateColumns: "2fr 1.6fr 1.4fr 1fr 130px 220px" }}
    >
      {children}
    </div>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
