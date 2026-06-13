import { cn } from "@/lib/cn";
import type { TicketPriority } from "@/lib/types";

const PRIORITY_STYLE: Record<TicketPriority, { bg: string; text: string; label: string; dot: string }> = {
  1: { bg: "bg-[rgba(199,25,122,.10)]", text: "text-brand-magenta", dot: "bg-brand-magenta", label: "Urgent" },
  2: { bg: "bg-[rgba(224,138,30,.12)]", text: "text-state-amber",   dot: "bg-state-amber",   label: "High"   },
  3: { bg: "bg-[rgba(107,31,184,.08)]", text: "text-brand-violet",  dot: "bg-brand-violet",  label: "Medium" },
  4: { bg: "bg-warm2",                  text: "text-mute",          dot: "bg-mute",          label: "Low"    },
};

export const PRIORITY_LABEL: Record<TicketPriority, string> = Object.fromEntries(
  Object.entries(PRIORITY_STYLE).map(([k, v]) => [k, v.label]),
) as unknown as Record<TicketPriority, string>;

export function PriorityChip({ priority, size = "md" }: { priority: TicketPriority; size?: "sm" | "md" }) {
  const s = PRIORITY_STYLE[priority];
  const sizeCls = size === "sm" ? "px-2 py-0.5 text-[10.5px]" : "px-2.5 py-1 text-[11.5px]";
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full font-semibold", sizeCls, s.bg, s.text)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}
