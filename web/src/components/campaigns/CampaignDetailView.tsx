"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  getCampaign, getCampaignRecipients, listCampaigns,
  pauseCampaign, resumeCampaign, cancelCampaign, scheduleCampaign,
  type CampaignDetail, type CampaignRecipient, type CampaignSummary,
} from "@/lib/api";
import { StatusPill } from "./StatusPill";

export function CampaignDetailView({ id }: { id: string }) {
  const [campaign, setCampaign]     = useState<CampaignDetail | null>(null);
  const [summary,  setSummary]      = useState<CampaignSummary | null>(null);
  const [recipients, setRecipients] = useState<CampaignRecipient[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState<string | null>(null);

  async function load() {
    try {
      const [c, list, r] = await Promise.all([
        getCampaign(id),
        listCampaigns(),
        getCampaignRecipients(id, { status: statusFilter || undefined, limit: 500 }),
      ]);
      setCampaign(c);
      setSummary(list.find((x) => x.id === id) ?? null);
      setRecipients(r);
    } catch (e) { setErr((e as Error).message); }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, statusFilter]);

  async function withBusy(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await fn(); await load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  const total = summary?.totalRecipients ?? 0;
  const done  = (summary?.sentCount ?? 0) + (summary?.deliveredCount ?? 0);
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;

  const canSchedule = campaign?.status === "draft";
  const canPause    = campaign?.status === "running" || campaign?.status === "scheduled";
  const canResume   = campaign?.status === "paused";
  const canCancel   = campaign && !["completed","cancelled"].includes(campaign.status);

  const statusOptions = useMemo(() => [
    { key: "",                 label: "All"        },
    { key: "pending",          label: "Pending"    },
    { key: "sent",             label: "Sent"       },
    { key: "delivered",        label: "Delivered"  },
    { key: "read",             label: "Read"       },
    { key: "failed",           label: "Failed"     },
    { key: "skipped_optout",   label: "Opt-out"    },
    { key: "skipped_no_phone", label: "No phone"   },
  ], []);

  if (!campaign) return <div className="text-[13px] text-mute">Loading…</div>;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-[34px] font-normal leading-none tracking-[-.01em]">
            {campaign.name}
          </h1>
          <div className="mt-2 flex items-center gap-2 text-[12.5px] text-mute">
            <StatusPill status={campaign.status} />
            <span className="text-hint">·</span>
            <span>{campaign.templateName ?? campaign.contentSid}</span>
            {campaign.scheduledAt && (
              <>
                <span className="text-hint">·</span>
                <span>Starts {new Date(campaign.scheduledAt).toLocaleString()}</span>
              </>
            )}
            <span className="text-hint">·</span>
            <span>Rate {campaign.sendRatePerSec}/sec</span>
            {campaign.dailyCap && (
              <>
                <span className="text-hint">·</span>
                <span>Daily cap {campaign.dailyCap}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canSchedule && <button onClick={() => withBusy(() => scheduleCampaign(id))} disabled={busy} className="btn-grad">Schedule now</button>}
          {canPause    && <button onClick={() => withBusy(() => pauseCampaign(id))}    disabled={busy} className="btn">Pause</button>}
          {canResume   && <button onClick={() => withBusy(() => resumeCampaign(id))}   disabled={busy} className="btn">Resume</button>}
          {canCancel   && <button onClick={() => withBusy(() => cancelCampaign(id))}   disabled={busy} className="btn">Cancel</button>}
          <Link href="/campaigns" className="btn">Back</Link>
        </div>
      </div>

      {err && <div className="mb-4 rounded-md border border-state-warn/30 bg-state-warn/10 p-3 text-[13px] text-state-warn">{err}</div>}

      {/* Progress */}
      <div className="mb-6 rounded-[14px] border border-rule bg-paper p-5">
        <div className="mb-2 flex items-center justify-between text-[12.5px]">
          <span className="font-semibold text-ink">Progress</span>
          <span className="tabular-nums text-mute">{done}/{total} · {pct}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-warm2">
          <div className="h-full rounded-full bg-grad transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
          <Stat label="Pending"   value={summary?.pendingCount   ?? 0} />
          <Stat label="Sent"      value={summary?.sentCount      ?? 0} />
          <Stat label="Delivered" value={summary?.deliveredCount ?? 0} />
          <Stat label="Failed"    value={summary?.failedCount    ?? 0} />
        </div>
      </div>

      {/* Recipients */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-serif text-[24px] leading-none">Recipients</h2>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-rule bg-paper px-2 py-1.5 text-[12.5px]"
        >
          {statusOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      </div>
      <div className="overflow-hidden rounded-[14px] border border-rule bg-paper">
        {recipients == null ? (
          <div className="p-5 text-[13px] text-mute">Loading…</div>
        ) : recipients.length === 0 ? (
          <div className="p-5 text-[13px] text-mute">No recipients {statusFilter && `with status ${statusFilter}`}.</div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-rule bg-warm/40 text-left mono-cap text-[10.5px] tracking-[.05em] text-mute">
                <th className="px-4 py-2 font-semibold">Lead</th>
                <th className="px-4 py-2 font-semibold">Contact</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold">Sent / Delivered</th>
                <th className="px-4 py-2 font-semibold">Error</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((r) => (
                <tr key={r.id} className="border-b border-rule last:border-0">
                  <td className="px-4 py-2 mono-cap text-[11px] text-mute">{r.leadNumber ?? "—"}</td>
                  <td className="px-4 py-2 text-ink2">{r.partyName ?? "—"} · {r.partyPhone ?? "—"}</td>
                  <td className="px-4 py-2"><StatusPill status={r.status} /></td>
                  <td className="px-4 py-2 text-mute text-[12px]">
                    {r.sentAt ? new Date(r.sentAt).toLocaleTimeString() : "—"}
                    {" / "}
                    {r.deliveredAt ? new Date(r.deliveredAt).toLocaleTimeString() : "—"}
                  </td>
                  <td className="px-4 py-2 text-[12px] text-state-warn">
                    {r.errorCode || r.errorMessage ? (
                      <span title={r.errorMessage ?? ""}>{r.errorCode ?? "err"}</span>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-rule bg-warm/40 px-3 py-2">
      <div className="mono-cap text-[10px] text-mute">{label}</div>
      <div className="mt-0.5 text-[18px] font-semibold tabular-nums">{value.toLocaleString("en-IN")}</div>
    </div>
  );
}
