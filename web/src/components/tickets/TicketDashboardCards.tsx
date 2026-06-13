import Link from "next/link";
import { cn } from "@/lib/cn";
import { Icon, type IconName } from "@/components/ui/Icon";
import { StatusPill } from "./StatusPill";
import { PriorityChip } from "./PriorityChip";
import type { TicketDashboard, TicketCategory, TicketPriority, TicketStatus } from "@/lib/types";

const CATEGORY_LABEL: Record<TicketCategory, string> = {
  billing: "Billing",
  technical: "Technical",
  content_lms: "Content / LMS",
  onboarding: "Onboarding",
  cohort_batch: "Cohort / Batch",
  refund: "Refund",
  certificate: "Certificate",
  other: "Other",
};

const PRIORITY_COLOR: Record<number, { bar: string; pill: string; text: string; label: string }> = {
  1: { bar: "bg-brand-magenta", pill: "bg-[rgba(199,25,122,.10)]", text: "text-brand-magenta", label: "Urgent" },
  2: { bar: "bg-state-amber",   pill: "bg-[rgba(224,138,30,.12)]", text: "text-state-amber",   label: "High"   },
  3: { bar: "bg-brand-violet",  pill: "bg-[rgba(107,31,184,.08)]", text: "text-brand-violet",  label: "Medium" },
  4: { bar: "bg-mute",          pill: "bg-warm2",                  text: "text-mute",          label: "Low"    },
};

export function TicketDashboardCards({ data }: { data: TicketDashboard }) {
  const c = data.counts;
  const totalActive = c.open + c.inProgress + c.pending;

  return (
    <div className="space-y-7">
      {/* Hero KPI strip */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <KpiCard label="Open"          value={c.open}          icon="inbox"  tone="blue"   subtle="awaiting triage" />
        <KpiCard label="In progress"   value={c.inProgress}    icon="spark"  tone="violet" subtle="being worked on" />
        <KpiCard label="Pending"       value={c.pending}       icon="clock"  tone="amber"  subtle="waiting on user" />
        <KpiCard label="Overdue"       value={c.overdue}       icon="info"   tone="magenta" subtle="past due" emphasis={c.overdue > 0} />
        <KpiCard label="Due today"     value={c.dueToday}      icon="clock"  tone="amber"  subtle="next 24h" />
        <KpiCard label="Closed (7d)"   value={c.closedThisWeek} icon="check" tone="ok"     subtle="resolved this week" />
      </div>

      {/* Priority bar + category breakdown */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-[16px] border border-rule bg-paper p-5 lg:col-span-2">
          <div className="mb-3 flex items-baseline justify-between">
            <div>
              <h3 className="font-serif text-[20px] tracking-[-.01em]">Active workload by priority</h3>
              <p className="text-[12px] text-mute">{totalActive} open ticket{totalActive === 1 ? "" : "s"} across all priorities.</p>
            </div>
          </div>
          <PriorityBar
            byPriority={data.byPriority}
            total={totalActive}
          />
          <div className="mt-3 flex flex-wrap gap-3 text-[11.5px]">
            {[1, 2, 3, 4].map((p) => {
              const c = data.byPriority.find((row) => row.priority === p)?.count ?? 0;
              const sty = PRIORITY_COLOR[p]!;
              return (
                <div key={p} className={cn("flex items-center gap-1.5 rounded-full px-2 py-0.5 font-semibold", sty.pill, sty.text)}>
                  <span className={cn("h-2 w-2 rounded-full", sty.bar)} />
                  {sty.label}: {c}
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-[16px] border border-rule bg-paper p-5">
          <h3 className="font-serif text-[20px] tracking-[-.01em]">By category</h3>
          <p className="mb-3 text-[12px] text-mute">Open tickets only.</p>
          <div className="space-y-2">
            {data.byCategory.length === 0 ? (
              <div className="text-[12px] text-mute">Nothing open right now.</div>
            ) : (
              data.byCategory.map((row) => (
                <div key={row.category} className="flex items-center justify-between rounded-lg border border-rule bg-warm px-3 py-2">
                  <span className="text-[13px] font-semibold">{CATEGORY_LABEL[row.category] ?? row.category}</span>
                  <span className="rounded-full bg-paper px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums">
                    {row.count}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* By assignee + lists */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-[16px] border border-rule bg-paper p-5">
          <h3 className="font-serif text-[20px] tracking-[-.01em]">By assignee</h3>
          <p className="mb-3 text-[12px] text-mute">Open · overdue · resolved this week.</p>
          <div className="space-y-2">
            {data.byAssignee.length === 0 ? (
              <div className="text-[12px] text-mute">No employees yet.</div>
            ) : (
              data.byAssignee.map((row) => (
                <div key={row.assigneeId} className="flex items-center gap-3 rounded-lg border border-rule bg-warm px-3 py-2">
                  <div className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full bg-grad text-[11px] font-bold text-white">
                    {initialsOf(row.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold">{row.name}</div>
                    <div className="text-[10.5px] uppercase tracking-wider text-hint">{row.role.replace("_", " ")}</div>
                  </div>
                  <Stat n={row.open} label="open" />
                  <Stat n={row.overdue} label="overdue" highlight={row.overdue > 0} />
                  <Stat n={row.closedThisWeek} label="closed" />
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-[16px] border border-rule bg-paper p-5 lg:col-span-2">
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <ListCard title="Oldest open" subtitle="Tickets sitting longest in the queue.">
              {data.oldestOpen.length === 0 ? (
                <Empty />
              ) : (
                data.oldestOpen.map((t) => (
                  <Link
                    key={t.id}
                    href={`/tickets/${t.number}`}
                    className="block rounded-lg border border-rule bg-warm p-2.5 transition hover:border-rule2"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-[10.5px] text-mute">{t.number}</span>
                      <PriorityChip priority={t.priority as TicketPriority} size="sm" />
                    </div>
                    <div className="mt-1 line-clamp-2 text-[12.5px] font-semibold text-ink">{t.subject}</div>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-mute">
                      <span className="truncate">{t.requesterName}</span>
                      <StatusPill status={t.status as TicketStatus} size="sm" />
                    </div>
                  </Link>
                ))
              )}
            </ListCard>

            <ListCard title="Recently closed" subtitle="Last five tickets put to bed.">
              {data.recentClosed.length === 0 ? (
                <Empty />
              ) : (
                data.recentClosed.map((t) => (
                  <Link
                    key={t.id}
                    href={`/tickets/${t.number}`}
                    className="block rounded-lg border border-rule bg-warm p-2.5 transition hover:border-rule2"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-[10.5px] text-mute">{t.number}</span>
                      <span className="rounded-full bg-[rgba(46,158,106,.10)] px-2 py-0.5 text-[10px] font-semibold text-state-ok">
                        {t.closedAt ? new Date(t.closedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—"}
                      </span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-[12.5px] font-semibold text-ink">{t.subject}</div>
                    {t.resolution && (
                      <div className="mt-1 line-clamp-2 text-[11px] text-mute">↳ {t.resolution}</div>
                    )}
                  </Link>
                ))
              )}
            </ListCard>
          </div>
        </div>
      </div>
    </div>
  );
}

function PriorityBar({ byPriority, total }: { byPriority: { priority: number; count: number }[]; total: number }) {
  if (total === 0) {
    return <div className="h-3 w-full rounded-full bg-warm2" />;
  }
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-warm2">
      {[1, 2, 3, 4].map((p) => {
        const count = byPriority.find((row) => row.priority === p)?.count ?? 0;
        if (count === 0) return null;
        const pct = (count / total) * 100;
        const sty = PRIORITY_COLOR[p]!;
        return <div key={p} className={cn("h-full", sty.bar)} style={{ width: `${pct}%` }} title={`${sty.label}: ${count}`} />;
      })}
    </div>
  );
}

function KpiCard({
  label, value, icon, tone, subtle, emphasis = false,
}: {
  label: string;
  value: number;
  icon: IconName;
  tone: "blue" | "violet" | "amber" | "magenta" | "ok";
  subtle: string;
  emphasis?: boolean;
}) {
  const toneCls: Record<string, { bg: string; ring: string; text: string }> = {
    blue:    { bg: "bg-[rgba(31,63,207,.08)]",  ring: "ring-[rgba(31,63,207,.18)]",  text: "text-brand-blue" },
    violet:  { bg: "bg-[rgba(107,31,184,.08)]", ring: "ring-[rgba(107,31,184,.18)]", text: "text-brand-violet" },
    amber:   { bg: "bg-[rgba(224,138,30,.10)]", ring: "ring-[rgba(224,138,30,.20)]", text: "text-state-amber" },
    magenta: { bg: "bg-[rgba(199,25,122,.10)]", ring: "ring-[rgba(199,25,122,.20)]", text: "text-brand-magenta" },
    ok:      { bg: "bg-[rgba(46,158,106,.10)]", ring: "ring-[rgba(46,158,106,.20)]", text: "text-state-ok" },
  };
  const t = toneCls[tone]!;
  return (
    <div className={cn(
      "rounded-[14px] border bg-paper p-4 transition",
      emphasis ? "border-brand-magenta/40 shadow-[0_2px_24px_rgba(199,25,122,.06)]" : "border-rule",
    )}>
      <div className="flex items-center justify-between">
        <span className={cn("flex h-9 w-9 items-center justify-center rounded-[11px] ring-1", t.bg, t.ring)}>
          <Icon name={icon} size={16} strokeWidth={1.8} className={t.text} />
        </span>
        <span className={cn("font-serif text-[34px] leading-none tracking-tight", emphasis ? "text-brand-magenta" : "text-ink")}>{value}</span>
      </div>
      <div className="mt-3 text-[12.5px] font-semibold text-ink">{label}</div>
      <div className="text-[10.5px] uppercase tracking-[.08em] text-hint">{subtle}</div>
    </div>
  );
}

function Stat({ n, label, highlight = false }: { n: number; label: string; highlight?: boolean }) {
  return (
    <div className="text-right">
      <div className={cn("font-mono text-[14px] font-semibold tabular-nums", highlight ? "text-brand-magenta" : "text-ink")}>{n}</div>
      <div className="text-[9px] uppercase tracking-[.08em] text-hint">{label}</div>
    </div>
  );
}

function ListCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="font-serif text-[18px] tracking-[-.01em]">{title}</h4>
      <p className="mb-2 text-[11.5px] text-mute">{subtitle}</p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Empty() {
  return <div className="rounded-lg border border-dashed border-rule px-3 py-6 text-center text-[12px] text-hint">Nothing here yet.</div>;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
