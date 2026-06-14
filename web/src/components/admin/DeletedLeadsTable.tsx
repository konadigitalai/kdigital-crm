"use client";

// Admin "Trash" table for soft-deleted leads. Each row has Restore (per the
// leads.write gate, which the page-level guard already requires) and an
// optional Permanently delete (gated by leads.purge). Both confirm first;
// neither is bulk in v1 — purge is irreversible and worth a per-row tap.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { purgeLead, restoreLead } from "@/lib/api";
import type { DeletedLead } from "@/lib/types";

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

  async function onRestore(lead: DeletedLead) {
    if (!confirm(`Restore ${lead.number}: "${lead.name}"?\n\nThe lead will reappear in the pipeline and search.`)) return;
    setBusy(lead.id);
    setError(null);
    setFlash(null);
    setLeads((all) => all.filter((x) => x.id !== lead.id)); // optimistic
    try {
      await restoreLead(lead.id);
      setFlash(`Restored ${lead.number} — back in the pipeline.`);
      router.refresh();
    } catch (err) {
      setError(`Couldn't restore ${lead.number}: ${(err as Error).message}`);
      // Refetch to recover the row.
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function onPurge(lead: DeletedLead) {
    const typed = prompt(
      `Permanently delete ${lead.number}: "${lead.name}"?\n\n` +
      `This wipes the lead, its activity timeline, score signals, agent assignments — everything. There is NO undo.\n\n` +
      `Type the lead number (${lead.number}) to confirm:`,
    );
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== lead.number.toUpperCase()) {
      setError("Confirmation didn't match. Nothing was deleted.");
      return;
    }
    setBusy(lead.id);
    setError(null);
    setFlash(null);
    setLeads((all) => all.filter((x) => x.id !== lead.id)); // optimistic
    try {
      await purgeLead(lead.id);
      setFlash(`Permanently deleted ${lead.number}.`);
      router.refresh();
    } catch (err) {
      setError(`Couldn't purge ${lead.number}: ${(err as Error).message}`);
      router.refresh();
    } finally {
      setBusy(null);
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
                  onClick={() => onRestore(l)}
                  disabled={busy === l.id}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet disabled:opacity-40"
                >
                  Restore
                </button>
                {canPurge && (
                  <button
                    type="button"
                    onClick={() => onPurge(l)}
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
    </>
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
