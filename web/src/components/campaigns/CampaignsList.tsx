"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listCampaigns, type CampaignSummary } from "@/lib/api";
import { StatusPill } from "./StatusPill";

export function CampaignsList() {
  const [rows, setRows] = useState<CampaignSummary[] | null>(null);
  const [err,  setErr]  = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await listCampaigns();
        if (alive) setRows(r);
      } catch (e) { if (alive) setErr((e as Error).message); }
    };
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (err)         return <div className="rounded-lg border border-state-warn/30 bg-state-warn/10 p-3 text-[12.5px] text-state-warn">{err}</div>;
  if (rows == null) return <div className="text-[13px] text-mute">Loading…</div>;
  if (rows.length === 0) {
    return (
      <div className="rounded-[14px] border border-rule bg-warm/40 p-8 text-center text-[13px] text-mute">
        No campaigns yet. Start with a WhatsApp template — click <b>New campaign</b> above.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[14px] border border-rule bg-paper">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-rule bg-warm/40 text-left mono-cap text-[10.5px] tracking-[.05em] text-mute">
            <th className="px-4 py-2 font-semibold">Name</th>
            <th className="px-4 py-2 font-semibold">Template</th>
            <th className="px-4 py-2 font-semibold">Status</th>
            <th className="px-4 py-2 font-semibold text-right">Progress</th>
            <th className="px-4 py-2 font-semibold text-right">Failed / skipped</th>
            <th className="px-4 py-2 font-semibold">Scheduled</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const total = Math.max(c.totalRecipients, 1);
            const done  = c.sentCount + c.deliveredCount;
            const pct   = Math.round((done / total) * 100);
            return (
              <tr key={c.id} className="border-b border-rule last:border-0 hover:bg-warm/30">
                <td className="px-4 py-3">
                  <Link href={`/campaigns/${c.id}`} className="font-semibold text-ink hover:text-brand-violet">
                    {c.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-ink2">{c.templateName ?? c.contentSid}</td>
                <td className="px-4 py-3"><StatusPill status={c.status} /></td>
                <td className="px-4 py-3 text-right tabular-nums text-ink2">
                  {done}/{c.totalRecipients} <span className="text-hint">· {pct}%</span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-ink2">
                  {c.failedCount} <span className="text-hint">/ {c.skippedCount}</span>
                </td>
                <td className="px-4 py-3 text-mute">
                  {c.scheduledAt ? new Date(c.scheduledAt).toLocaleString() : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
