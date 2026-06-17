"use client";

import { useState } from "react";
import Link from "next/link";
import type { WaAutomationListItem, WaTriggerType } from "@/lib/types";
import { setWaAutomationEnabled } from "@/lib/api";

const TRIGGER_LABEL: Record<WaTriggerType, string> = {
  inbound_message_keyword: "Inbound keyword",
  new_contact: "New contact",
  lead_created: "Lead created",
};

export function WaAutomationsList({
  initialAutomations, canManage,
}: { initialAutomations: WaAutomationListItem[]; canManage: boolean }) {
  const [automations, setAutomations] = useState(initialAutomations);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function handleToggle(id: string, enabled: boolean) {
    setBusyId(id); setErr(null);
    try {
      await setWaAutomationEnabled(id, enabled);
      setAutomations((prev) => prev.map((a) => (a.id === id ? { ...a, enabled } : a)));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (automations.length === 0) {
    return (
      <div className="rounded-[16px] border border-dashed border-rule bg-warm/30 px-6 py-16 text-center">
        <h3 className="font-serif text-[22px] text-ink">No automations yet</h3>
        <p className="mt-2 text-[13.5px] text-mute">
          Click <b className="text-ink">New automation</b> to create your first rule. They run on inbound messages,
          new contacts, or new leads.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {err && <div className="rounded-md border border-state-bad/40 bg-state-bad/5 px-3 py-2 text-[12.5px] text-state-bad">{err}</div>}
      {automations.map((a) => (
        <div key={a.id} className="rounded-[14px] border border-rule bg-paper p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Link href={`/whatsapp/automations/${a.id}`} className="text-[16px] font-semibold text-ink hover:text-brand-violet">
                  {a.name}
                </Link>
                <span className={
                  "rounded-full px-2 py-0.5 text-[10.5px] font-semibold ring-1 ring-inset " +
                  (a.enabled ? "bg-state-ok/15 text-state-ok ring-state-ok/30" : "bg-rule2/30 text-mute ring-rule2")
                }>
                  {a.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              {a.description && <div className="mt-1 text-[12.5px] text-mute">{a.description}</div>}
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-mute">
                <span className="rounded-md border border-rule bg-warm/40 px-2 py-0.5 font-mono text-ink">
                  {TRIGGER_LABEL[a.trigger.type]}
                </span>
                <span>→</span>
                <span>{a.actions.length} action{a.actions.length === 1 ? "" : "s"}</span>
                <span>·</span>
                <span>{a.runCount} run{a.runCount === 1 ? "" : "s"}</span>
                {a.createdByName && <><span>·</span><span>by {a.createdByName}</span></>}
                <span>·</span>
                <span>{new Date(a.updatedAt).toLocaleString()}</span>
              </div>
            </div>
            {canManage && (
              <button
                onClick={() => handleToggle(a.id, !a.enabled)}
                disabled={busyId === a.id}
                className={
                  "shrink-0 rounded-md border px-3 py-1.5 text-[12.5px] font-semibold transition disabled:opacity-50 " +
                  (a.enabled
                    ? "border-state-amber/40 bg-state-amber/5 text-state-amber hover:bg-state-amber/10"
                    : "border-state-ok/40 bg-state-ok/5 text-state-ok hover:bg-state-ok/10")
                }
              >
                {busyId === a.id ? "…" : a.enabled ? "Disable" : "Enable"}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
