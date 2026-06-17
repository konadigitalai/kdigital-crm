"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { syncWaTemplates, getWaTemplates } from "@/lib/api";
import type { WaTemplate } from "@/lib/types";

const STATUS_STYLE: Record<string, string> = {
  approved: "bg-state-ok/15 text-state-ok ring-state-ok/30",
  pending:  "bg-state-amber/15 text-state-amber ring-state-amber/30",
  rejected: "bg-state-bad/15 text-state-bad ring-state-bad/30",
  paused:   "bg-rule2/30 text-mute ring-rule2",
};

export function WaTemplatesCard({
  initialTemplates, canManage,
}: { initialTemplates: WaTemplate[]; canManage: boolean }) {
  const [templates, setTemplates] = useState<WaTemplate[]>(initialTemplates);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [filter, setFilter] = useState<"all" | "approved" | "pending" | "rejected" | "paused">("all");

  async function handleSync() {
    if (!canManage) return;
    setBusy(true); setMsg(null);
    try {
      const out = await syncWaTemplates();
      setTemplates(await getWaTemplates());
      setMsg({ kind: "ok", text: `Synced ${out.total}: ${out.inserted} new, ${out.updated} updated.` });
      setTimeout(() => setMsg(null), 6000);
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const filtered = templates.filter((t) => filter === "all" || t.status === filter);

  return (
    <div className="rounded-[16px] border border-rule bg-paper p-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-semibold text-ink">Templates</h2>
          <p className="mt-1 text-[13px] text-mute">
            Read-only mirror of the templates you've created in Meta Business Manager. Only{" "}
            <b className="text-ink">approved</b> templates can be sent.
          </p>
        </div>
        <button onClick={handleSync} disabled={!canManage || busy}
          className="shrink-0 rounded-md bg-brand-violet px-3 py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
          <Icon name="burst" size={12} strokeWidth={2.4} className="mr-1.5 inline-block" />
          {busy ? "Syncing…" : "Sync from Meta"}
        </button>
      </div>

      {msg && (
        <div className={
          "mb-3 rounded-md border px-3 py-2 text-[12.5px] " +
          (msg.kind === "ok" ? "border-state-ok/40 bg-state-ok/5 text-state-ok" : "border-state-bad/40 bg-state-bad/5 text-state-bad")
        }>{msg.text}</div>
      )}

      {/* Filter pills */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {(["all", "approved", "pending", "rejected", "paused"] as const).map((s) => (
          <button key={s} onClick={() => setFilter(s)}
            className={
              "rounded-md border px-2.5 py-1 text-[11.5px] font-semibold capitalize transition " +
              (filter === s
                ? "border-brand-violet bg-brand-violet/10 text-brand-violet"
                : "border-rule bg-paper text-mute hover:border-rule2 hover:text-ink")
            }>
            {s} ({s === "all" ? templates.length : templates.filter((t) => t.status === s).length})
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-rule bg-warm/30 px-4 py-8 text-center text-[13px] text-mute">
          No templates found{filter !== "all" ? ` matching "${filter}"` : ""}. Create them in Meta Business Manager and click <b className="text-ink">Sync from Meta</b>.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-rule">
          <table className="w-full text-[12.5px]">
            <thead className="bg-warm/40 text-mute">
              <tr>
                <th className="border-b border-rule px-3 py-2 text-left font-semibold">Name</th>
                <th className="border-b border-rule px-3 py-2 text-left font-semibold">Lang</th>
                <th className="border-b border-rule px-3 py-2 text-left font-semibold">Category</th>
                <th className="border-b border-rule px-3 py-2 text-left font-semibold">Vars</th>
                <th className="border-b border-rule px-3 py-2 text-left font-semibold">Status</th>
                <th className="border-b border-rule px-3 py-2 text-left font-semibold">Body</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={t.id} className="border-b border-rule last:border-b-0 hover:bg-warm/30">
                  <td className="px-3 py-2 font-mono text-ink">{t.templateName}</td>
                  <td className="px-3 py-2 font-mono text-mute">{t.language}</td>
                  <td className="px-3 py-2 text-mute">{t.category}</td>
                  <td className="px-3 py-2 text-mute">{t.variableCount}</td>
                  <td className="px-3 py-2">
                    <span className={"inline-block rounded-full px-2 py-0.5 text-[10.5px] font-semibold ring-1 ring-inset " + (STATUS_STYLE[t.status] ?? "")}>
                      {t.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 max-w-[400px] truncate text-ink2" title={t.bodyText ?? ""}>
                    {t.bodyText}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
