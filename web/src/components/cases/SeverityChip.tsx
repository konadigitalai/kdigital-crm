import { cn } from "@/lib/cn";
import type { CaseSeverity } from "@/lib/types";

// Severity is the case's priority relabelled for the board (Critical/High/…).
const SEVERITY_STYLE: Record<CaseSeverity, { bg: string; text: string; dot: string }> = {
  Critical: { bg: "bg-[rgba(199,25,122,.10)]", text: "text-brand-magenta", dot: "bg-brand-magenta" },
  High:     { bg: "bg-[rgba(224,138,30,.12)]", text: "text-state-amber",   dot: "bg-state-amber"   },
  Medium:   { bg: "bg-[rgba(107,31,184,.08)]", text: "text-brand-violet",  dot: "bg-brand-violet"  },
  Low:      { bg: "bg-warm2",                  text: "text-mute",          dot: "bg-mute"          },
};

export function SeverityChip({ severity, size = "md" }: { severity: CaseSeverity; size?: "sm" | "md" }) {
  const s = SEVERITY_STYLE[severity] ?? SEVERITY_STYLE.Medium;
  const sizeCls = size === "sm" ? "px-2 py-0.5 text-[10.5px]" : "px-2.5 py-1 text-[11.5px]";
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full font-semibold", sizeCls, s.bg, s.text)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
      {severity}
    </span>
  );
}
