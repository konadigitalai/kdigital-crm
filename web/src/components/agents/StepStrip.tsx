// Horizontal pipeline of an agent_run's `steps` JSONB. Used by the agent
// catalog cards and the per-agent run-history rows.

import { cn } from "@/lib/cn";
import type { AgentRunStep } from "@/lib/types";

export function StepStrip({ steps }: { steps: AgentRunStep[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      {steps.map((s, i) => (
        <span key={`${s.label}-${i}`} className="inline-flex items-center gap-1">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px]",
              s.state === "done"   && "bg-state-ok/10 text-state-ok",
              s.state === "active" && "bg-brand-violet/10 text-brand-violet",
              s.state === "failed" && "bg-state-warn/10 text-state-warn",
              s.state === "queued" && "bg-warm2 text-mute",
            )}
            title={s.detail ?? undefined}
          >
            {s.label}
            {s.state === "done"   && " ✓"}
            {s.state === "active" && " ●"}
            {s.state === "failed" && " ✗"}
          </span>
          {i < steps.length - 1 && <span className="text-hint">·</span>}
        </span>
      ))}
    </div>
  );
}
