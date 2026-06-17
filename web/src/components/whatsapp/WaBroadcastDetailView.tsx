"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { WaBroadcastDetail, WaBroadcastRecipientStatus } from "@/lib/types";
import {
  cancelWaBroadcast, deleteWaBroadcast, getWaBroadcast, sendWaBroadcast,
} from "@/lib/api";

const POLL_MS = 5_000;

const STATUS_STYLE: Record<string, string> = {
  draft:     "bg-rule2/30 text-mute ring-rule2",
  scheduled: "bg-state-amber/15 text-state-amber ring-state-amber/30",
  sending:   "bg-brand-violet/15 text-brand-violet ring-brand-violet/30",
  completed: "bg-state-ok/15 text-state-ok ring-state-ok/30",
  cancelled: "bg-rule2/30 text-mute ring-rule2",
  failed:    "bg-state-bad/15 text-state-bad ring-state-bad/30",
};

const RECIPIENT_STYLE: Record<WaBroadcastRecipientStatus, string> = {
  pending:   "text-mute",
  sent:      "text-ink",
  delivered: "text-state-ok",
  read:      "text-brand-violet",
  failed:    "text-state-bad",
  cancelled: "text-mute",
};

export function WaBroadcastDetailView({
  initialDetail, canBroadcast,
}: { initialDetail: WaBroadcastDetail; canBroadcast: boolean }) {
  const router = useRouter();
  const [detail, setDetail] = useState(initialDetail);
  const [busy, setBusy] = useState<"send" | "cancel" | "delete" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Poll while the broadcast is in motion (sending or scheduled).
  useEffect(() => {
    let cancelled = false;
    const id = detail.broadcast.id;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      const status = detail.broadcast.status;
      if (status !== "sending" && status !== "scheduled") return;
      try {
        const next = await getWaBroadcast(id);
        if (!cancelled) setDetail(next);
      } catch { /* ignore */ }
    };
    const t = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [detail.broadcast.id, detail.broadcast.status]);

  const b = detail.broadcast;
  const totalSettled = b.sentCount + b.deliveredCount + b.readCount + b.failedCount;
  const pct = b.totalRecipients > 0 ? Math.round((totalSettled / b.totalRecipients) * 100) : 0;

  async function handleSend() {
    setBusy("send"); setErr(null);
    try {
      await sendWaBroadcast(b.id);
      setDetail(await getWaBroadcast(b.id));
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }
  async function handleCancel() {
    if (!confirm("Cancel this broadcast? Pending recipients will not be sent.")) return;
    setBusy("cancel"); setErr(null);
    try {
      await cancelWaBroadcast(b.id);
      setDetail(await getWaBroadcast(b.id));
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }
  async function handleDelete() {
    if (!confirm("Delete this draft broadcast permanently?")) return;
    setBusy("delete"); setErr(null);
    try {
      await deleteWaBroadcast(b.id);
      router.push("/whatsapp/broadcasts");
    } catch (e) { setErr((e as Error).message); setBusy(null); }
  }

  return (
    <div className="space-y-6">
      {/* Header card */}
      <section className="rounded-[14px] border border-rule bg-paper p-6">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h1 className="font-serif text-[32px] font-normal leading-none tracking-[-.01em]">{b.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-mute">
              <span className={"rounded-full px-2 py-0.5 text-[10.5px] font-semibold ring-1 ring-inset " + (STATUS_STYLE[b.status] ?? "")}>
                {b.status}
              </span>
              <span>·</span>
              <span>Template: <b className="font-mono text-ink">{b.templateName ?? "deleted"}</b></span>
              {b.templateLanguage && <><span>·</span><span>{b.templateLanguage}</span></>}
              <span>·</span>
              <span>Created {new Date(b.createdAt).toLocaleString()}</span>
              {b.createdByName && <><span>·</span><span>by {b.createdByName}</span></>}
            </div>
          </div>
          {canBroadcast && (
            <div className="flex gap-2">
              {(b.status === "draft" || b.status === "scheduled") && (
                <button onClick={handleSend} disabled={busy !== null}
                  className="rounded-md bg-brand-violet px-3 py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
                  {busy === "send" ? "Starting…" : "Send now"}
                </button>
              )}
              {(b.status === "draft" || b.status === "scheduled" || b.status === "sending") && (
                <button onClick={handleCancel} disabled={busy !== null}
                  className="rounded-md border border-state-amber/40 bg-state-amber/5 px-3 py-1.5 text-[12.5px] font-semibold text-state-amber hover:bg-state-amber/10 disabled:opacity-50">
                  {busy === "cancel" ? "Cancelling…" : "Cancel"}
                </button>
              )}
              {b.status === "draft" && (
                <button onClick={handleDelete} disabled={busy !== null}
                  className="rounded-md border border-state-bad/40 bg-state-bad/5 px-3 py-1.5 text-[12.5px] font-semibold text-state-bad hover:bg-state-bad/10 disabled:opacity-50">
                  {busy === "delete" ? "Deleting…" : "Delete"}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Counts + progress */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Counter label="Total" value={b.totalRecipients} />
          <Counter label="Sent" value={b.sentCount} tone="ink" />
          <Counter label="Delivered" value={b.deliveredCount} tone="ok" />
          <Counter label="Read" value={b.readCount} tone="violet" />
          <Counter label="Failed" value={b.failedCount} tone="bad" />
        </div>

        {b.totalRecipients > 0 && (
          <div className="mt-4">
            <div className="mb-1 flex items-center justify-between text-[11px] text-mute">
              <span>{totalSettled} of {b.totalRecipients} processed ({pct}%)</span>
              {b.scheduledAt && <span>Scheduled: {new Date(b.scheduledAt).toLocaleString()}</span>}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-rule2/40">
              <div className="h-full bg-brand-violet transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        {err && <div className="mt-3 rounded-md border border-state-bad/40 bg-state-bad/5 px-3 py-2 text-[12.5px] text-state-bad">{err}</div>}
      </section>

      {/* Template body preview */}
      {b.templateBodyText && (
        <section className="rounded-[14px] border border-rule bg-paper p-6">
          <h2 className="mb-3 text-[14px] font-semibold text-ink">Template body</h2>
          <div className="rounded-md border border-rule bg-warm/40 p-3 text-[12.5px] leading-[1.45] text-ink whitespace-pre-line">
            {b.templateBodyText}
          </div>
        </section>
      )}

      {/* Recipients table */}
      <section className="overflow-hidden rounded-[14px] border border-rule bg-paper">
        <div className="border-b border-rule bg-warm/40 px-4 py-3">
          <h2 className="text-[14px] font-semibold text-ink">Recipients ({detail.recipients.length})</h2>
        </div>
        {detail.recipients.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px] text-mute">No recipients added yet.</div>
        ) : (
          <table className="w-full text-[12.5px]">
            <thead className="bg-warm/30 text-mute">
              <tr>
                <th className="border-b border-rule px-4 py-2 text-left font-semibold">Name</th>
                <th className="border-b border-rule px-4 py-2 text-left font-semibold">Phone</th>
                <th className="border-b border-rule px-4 py-2 text-left font-semibold">Status</th>
                <th className="border-b border-rule px-4 py-2 text-left font-semibold">Sent</th>
                <th className="border-b border-rule px-4 py-2 text-left font-semibold">Delivered</th>
                <th className="border-b border-rule px-4 py-2 text-left font-semibold">Read</th>
                <th className="border-b border-rule px-4 py-2 text-left font-semibold">Note</th>
              </tr>
            </thead>
            <tbody>
              {detail.recipients.map((r) => (
                <tr key={r.id} className="border-b border-rule last:border-b-0 hover:bg-warm/30">
                  <td className="px-4 py-2 text-ink">{r.partyName ?? <span className="text-hint italic">unmatched</span>}</td>
                  <td className="px-4 py-2 font-mono text-mute">{r.toPhone}</td>
                  <td className={"px-4 py-2 font-semibold capitalize " + (RECIPIENT_STYLE[r.status] ?? "")}>
                    {r.status}
                  </td>
                  <td className="px-4 py-2 text-mute">{r.sentAt ? new Date(r.sentAt).toLocaleTimeString() : "—"}</td>
                  <td className="px-4 py-2 text-mute">{r.deliveredAt ? new Date(r.deliveredAt).toLocaleTimeString() : "—"}</td>
                  <td className="px-4 py-2 text-mute">{r.readAt ? new Date(r.readAt).toLocaleTimeString() : "—"}</td>
                  <td className="px-4 py-2 text-state-bad" title={r.errorMessage ?? ""}>
                    {r.errorMessage ? r.errorMessage.slice(0, 60) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Counter({
  label, value, tone,
}: { label: string; value: number; tone?: "ink" | "ok" | "violet" | "bad" }) {
  const cls = (() => {
    switch (tone) {
      case "ok":     return "text-state-ok";
      case "violet": return "text-brand-violet";
      case "bad":    return "text-state-bad";
      case "ink":    return "text-ink";
      default:       return "text-ink";
    }
  })();
  return (
    <div className="rounded-md border border-rule bg-warm/30 p-3">
      <div className="mono-cap text-[10px] font-semibold tracking-[.1em] text-mute">{label}</div>
      <div className={"mt-1 text-[24px] font-semibold tabular-nums " + cls}>{value.toLocaleString()}</div>
    </div>
  );
}
