"use client";

import { useEffect, useState } from "react";
import type { WaAutomationRunItem } from "@/lib/types";
import { getWaAutomationRuns } from "@/lib/api";

const POLL_MS = 8_000;

const STATUS_STYLE: Record<string, string> = {
  running:   "bg-brand-violet/15 text-brand-violet ring-brand-violet/30",
  completed: "bg-state-ok/15 text-state-ok ring-state-ok/30",
  failed:    "bg-state-bad/15 text-state-bad ring-state-bad/30",
  skipped:   "bg-rule2/30 text-mute ring-rule2",
};

export function WaAutomationRuns({
  automationId, initialRuns,
}: { automationId: string; initialRuns: WaAutomationRunItem[] }) {
  const [runs, setRuns] = useState(initialRuns);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await getWaAutomationRuns(automationId, 50);
        if (!cancelled) setRuns(next);
      } catch { /* ignore */ }
    };
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [automationId]);

  return (
    <section className="overflow-hidden rounded-[14px] border border-rule bg-paper">
      <div className="border-b border-rule bg-warm/40 px-4 py-3">
        <h2 className="text-[14px] font-semibold text-ink">Recent runs ({runs.length})</h2>
      </div>
      {runs.length === 0 ? (
        <div className="px-4 py-8 text-center text-[13px] text-mute">No runs yet. Trigger an event to see one here.</div>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead className="bg-warm/30 text-mute">
            <tr>
              <th className="border-b border-rule px-4 py-2 text-left font-semibold">Started</th>
              <th className="border-b border-rule px-4 py-2 text-left font-semibold">Status</th>
              <th className="border-b border-rule px-4 py-2 text-left font-semibold">Party</th>
              <th className="border-b border-rule px-4 py-2 text-left font-semibold">Actions</th>
              <th className="border-b border-rule px-4 py-2 text-left font-semibold">Note</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-b border-rule last:border-b-0 hover:bg-warm/30 align-top">
                <td className="px-4 py-2 text-mute whitespace-nowrap">{new Date(r.startedAt).toLocaleString()}</td>
                <td className="px-4 py-2">
                  <span className={"inline-block rounded-full px-2 py-0.5 text-[10.5px] font-semibold capitalize ring-1 ring-inset " + (STATUS_STYLE[r.status] ?? "")}>
                    {r.status}
                  </span>
                </td>
                <td className="px-4 py-2 text-ink">{r.partyName ?? <span className="text-hint italic">—</span>}</td>
                <td className="px-4 py-2">
                  <ul className="space-y-0.5">
                    {(r.actionsLog ?? []).map((a, i) => (
                      <li key={i} className="flex items-center gap-1.5">
                        <span className={"font-mono text-[11px] " + (a.ok ? "text-state-ok" : "text-state-bad")}>
                          {a.ok ? "✓" : "✗"}
                        </span>
                        <span className="font-mono text-[11px] text-ink">{a.type}</span>
                        {a.error && <span className="text-[11px] text-state-bad">— {a.error.slice(0, 80)}</span>}
                      </li>
                    ))}
                    {(!r.actionsLog || r.actionsLog.length === 0) && <li className="text-[11px] italic text-hint">no actions</li>}
                  </ul>
                </td>
                <td className="px-4 py-2 text-state-bad" title={r.errorMessage ?? ""}>
                  {r.errorMessage ? r.errorMessage.slice(0, 80) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
