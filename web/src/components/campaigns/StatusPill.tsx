import { cn } from "@/lib/cn";

/** Compact status chip shared across campaign lists + detail pages. */
export function StatusPill({ status, className }: { status: string; className?: string }) {
  const cls =
    status === "running"    ? "bg-brand-violet/10 text-brand-violet ring-brand-violet/30" :
    status === "scheduled"  ? "bg-brand-blue/10   text-brand-blue   ring-brand-blue/30" :
    status === "completed"  ? "bg-state-ok/10     text-state-ok     ring-state-ok/30" :
    status === "paused"     ? "bg-state-amber/10  text-state-amber  ring-state-amber/30" :
    status === "cancelled"  ? "bg-mute/10          text-mute         ring-mute/30" :
    status === "failed"     ? "bg-state-warn/10   text-state-warn   ring-state-warn/30" :
    /* draft, pending, sent, delivered, read, skipped_* */
    "bg-warm text-ink2 ring-rule2";
  return (
    <span className={cn(
      "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide ring-1",
      cls, className,
    )}>
      {status.replace(/_/g, " ")}
    </span>
  );
}
