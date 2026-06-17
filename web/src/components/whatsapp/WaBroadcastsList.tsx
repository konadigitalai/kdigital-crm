"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { WaBroadcastListItem } from "@/lib/types";
import { getWaBroadcasts } from "@/lib/api";

const POLL_MS = 8_000;

const STATUS_STYLE: Record<string, string> = {
  draft:     "bg-rule2/30 text-mute ring-rule2",
  scheduled: "bg-state-amber/15 text-state-amber ring-state-amber/30",
  sending:   "bg-brand-violet/15 text-brand-violet ring-brand-violet/30",
  completed: "bg-state-ok/15 text-state-ok ring-state-ok/30",
  cancelled: "bg-rule2/30 text-mute ring-rule2",
  failed:    "bg-state-bad/15 text-state-bad ring-state-bad/30",
};

export function WaBroadcastsList({
  initialBroadcasts,
}: { initialBroadcasts: WaBroadcastListItem[] }) {
  const [broadcasts, setBroadcasts] = useState(initialBroadcasts);

  // Poll while page is visible and any broadcast is sending/scheduled.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await getWaBroadcasts();
        if (!cancelled) setBroadcasts(next);
      } catch { /* ignore transient */ }
    };
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (broadcasts.length === 0) {
    return (
      <div className="rounded-[16px] border border-dashed border-rule bg-warm/30 px-6 py-16 text-center">
        <h3 className="font-serif text-[22px] text-ink">No broadcasts yet</h3>
        <p className="mt-2 text-[13.5px] text-mute">Click <b className="text-ink">New broadcast</b> to send an approved template to a group of contacts.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[14px] border border-rule bg-paper">
      <table className="w-full text-[13px]">
        <thead className="bg-warm/40 text-mute">
          <tr>
            <th className="border-b border-rule px-4 py-2.5 text-left font-semibold">Name</th>
            <th className="border-b border-rule px-4 py-2.5 text-left font-semibold">Template</th>
            <th className="border-b border-rule px-4 py-2.5 text-left font-semibold">Status</th>
            <th className="border-b border-rule px-4 py-2.5 text-right font-semibold">Total</th>
            <th className="border-b border-rule px-4 py-2.5 text-right font-semibold">Sent</th>
            <th className="border-b border-rule px-4 py-2.5 text-right font-semibold">Delivered</th>
            <th className="border-b border-rule px-4 py-2.5 text-right font-semibold">Read</th>
            <th className="border-b border-rule px-4 py-2.5 text-right font-semibold">Failed</th>
            <th className="border-b border-rule px-4 py-2.5 text-left font-semibold">Created</th>
          </tr>
        </thead>
        <tbody>
          {broadcasts.map((b) => {
            const pct = b.totalRecipients > 0
              ? Math.round(((b.sentCount + b.deliveredCount + b.readCount + b.failedCount) / b.totalRecipients) * 100)
              : 0;
            return (
              <tr key={b.id} className="border-b border-rule last:border-b-0 hover:bg-warm/30">
                <td className="px-4 py-2.5">
                  <Link href={`/whatsapp/broadcasts/${b.id}`} className="font-semibold text-ink hover:text-brand-violet">
                    {b.name}
                  </Link>
                  {b.status === "sending" && (
                    <div className="mt-1 h-1 w-32 overflow-hidden rounded-full bg-rule2/40">
                      <div className="h-full bg-brand-violet" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5 font-mono text-[12px] text-mute">
                  {b.templateName ?? <span className="italic text-state-bad">deleted</span>}
                  {b.templateLanguage && <span className="ml-1 text-hint">· {b.templateLanguage}</span>}
                </td>
                <td className="px-4 py-2.5">
                  <span className={"inline-block rounded-full px-2 py-0.5 text-[10.5px] font-semibold ring-1 ring-inset " + (STATUS_STYLE[b.status] ?? "")}>
                    {b.status}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right font-mono">{b.totalRecipients}</td>
                <td className="px-4 py-2.5 text-right font-mono text-ink">{b.sentCount}</td>
                <td className="px-4 py-2.5 text-right font-mono text-state-ok">{b.deliveredCount}</td>
                <td className="px-4 py-2.5 text-right font-mono text-brand-violet">{b.readCount}</td>
                <td className="px-4 py-2.5 text-right font-mono text-state-bad">{b.failedCount}</td>
                <td className="px-4 py-2.5 text-mute">
                  {new Date(b.createdAt).toLocaleString()}
                  {b.createdByName && <div className="text-[11px] text-hint">by {b.createdByName}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
