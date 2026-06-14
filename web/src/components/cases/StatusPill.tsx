import { cn } from "@/lib/cn";
import type { CaseStatus } from "@/lib/types";

const STATUS_STYLE: Record<CaseStatus, { bg: string; text: string; dot: string; label: string }> = {
  open:        { bg: "bg-[rgba(31,63,207,.08)]",  text: "text-brand-blue",    dot: "bg-brand-blue",    label: "Open" },
  in_progress: { bg: "bg-[rgba(107,31,184,.08)]", text: "text-brand-violet",  dot: "bg-brand-violet",  label: "In progress" },
  pending:     { bg: "bg-[rgba(224,138,30,.12)]", text: "text-state-amber",   dot: "bg-state-amber",   label: "Pending" },
  resolved:    { bg: "bg-[rgba(46,158,106,.10)]", text: "text-state-ok",      dot: "bg-state-ok",      label: "Resolved" },
  closed:      { bg: "bg-warm2",                  text: "text-mute",          dot: "bg-mute",          label: "Closed" },
  cancelled:   { bg: "bg-warm",                   text: "text-hint",          dot: "bg-hint",          label: "Cancelled" },
};

export const STATUS_LABEL: Record<CaseStatus, string> = Object.fromEntries(
  Object.entries(STATUS_STYLE).map(([k, v]) => [k, v.label]),
) as Record<CaseStatus, string>;

export function StatusPill({ status, size = "md" }: { status: CaseStatus; size?: "sm" | "md" }) {
  const s = STATUS_STYLE[status];
  const sizeCls = size === "sm" ? "px-2 py-0.5 text-[10.5px]" : "px-2.5 py-1 text-[11.5px]";
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full font-semibold", sizeCls, s.bg, s.text)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}
