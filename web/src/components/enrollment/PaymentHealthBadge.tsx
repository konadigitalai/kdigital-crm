import { cn } from "@/lib/cn";
import type { PaymentHealth } from "@/lib/types";

// Payment-health pill shared by the enrollments table + record page. The
// health label is computed server-side from paid/quoted vs the due date.
const HEALTH: Record<PaymentHealth, { label: string; cls: string }> = {
  paid_in_full: { label: "Paid in full", cls: "bg-[rgba(46,158,106,.10)] text-state-ok" },
  on_track:     { label: "On track",     cls: "bg-[rgba(31,63,207,.08)]  text-brand-blue" },
  due_soon:     { label: "Due soon",      cls: "bg-[rgba(224,138,30,.12)] text-state-amber" },
  overdue:      { label: "Overdue",       cls: "bg-[rgba(217,83,79,.10)]  text-state-warn" },
  critical:     { label: "Critical",      cls: "bg-state-warn/20          text-state-warn" },
};

export function PaymentHealthBadge({ health }: { health: PaymentHealth }) {
  const h = HEALTH[health] ?? HEALTH.on_track;
  return (
    <span className={cn("mono-cap inline-flex items-center rounded-full px-2 py-0.5 text-[9.5px] font-semibold", h.cls)}>
      {h.label}
    </span>
  );
}
