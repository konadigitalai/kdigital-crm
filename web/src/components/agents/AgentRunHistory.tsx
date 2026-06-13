import { cn } from "@/lib/cn";
import { StepStrip } from "@/components/agents/StepStrip";
import type { AgentRunRecord } from "@/lib/types";

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function AgentRunHistory({ runs }: { runs: AgentRunRecord[] }) {
  if (runs.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-rule bg-paper p-8 text-center text-[13px] text-mute">
        No runs yet. Use the panel above to run this agent on demand.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
      <div className="mono-cap grid items-center gap-3 border-b border-rule bg-warm px-5 py-2.5 text-[9.5px] font-semibold tracking-[.12em] text-mute"
           style={{ gridTemplateColumns: "120px 100px 1.4fr 2fr" }}>
        <div>When</div>
        <div>Status</div>
        <div>Target</div>
        <div>Steps</div>
      </div>
      {runs.map((r) => (
        <div
          key={r.workItemId}
          className="grid items-start gap-3 border-b border-rule px-5 py-3 last:border-b-0 hover:bg-warm/40"
          style={{ gridTemplateColumns: "120px 100px 1.4fr 2fr" }}
        >
          <div title={new Date(r.startedAt).toLocaleString()}>
            <div className="text-[13px] font-semibold text-ink">{timeAgo(r.startedAt)}</div>
            <div className="mono-cap mt-0.5 text-[9.5px] tracking-[.04em] text-mute">{r.number}</div>
          </div>
          <div>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                r.status === "running"   && "bg-brand-violet/10 text-brand-violet",
                r.status === "completed" && "bg-state-ok/10 text-state-ok",
                r.status === "failed"    && "bg-state-warn/10 text-state-warn",
              )}
            >
              <span className={cn(
                "h-1.5 w-1.5 rounded-full",
                r.status === "running"   && "bg-brand-violet animate-pulse",
                r.status === "completed" && "bg-state-ok",
                r.status === "failed"    && "bg-state-warn",
              )} />
              {r.status}
            </span>
          </div>
          <div className="min-w-0 text-[13px] text-ink2">
            {r.target ? (
              <span className="truncate" title={r.target}>{r.target}</span>
            ) : (
              <span className="text-mute">—</span>
            )}
          </div>
          <div className="min-w-0">
            <StepStrip steps={r.steps ?? []} />
          </div>
        </div>
      ))}
    </div>
  );
}
