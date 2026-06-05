import Link from "next/link";
import { Topbar } from "@/components/shell/Topbar";
import { Icon, type IconName } from "@/components/ui/Icon";
import { getActivityFeed, getAgentRuns, getCurrentUser, getSummary } from "@/lib/api";
import { avatarGradClass } from "@/lib/ui";
import { cn } from "@/lib/cn";

function timeAgo(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return `${Math.round(hr / 24)} d ago`;
}

export default async function AgentHome() {
  const [agentCards, feedItems, me, summary] = await Promise.all([
    getAgentRuns(),
    getActivityFeed(),
    getCurrentUser(),
    getSummary(),
  ]);
  const liveAgentCount = summary.overall.liveAgents;
  const firstName = me?.name?.split(" ")[0] ?? "there";
  // Time-of-day greeting
  const hr = new Date().getHours();
  const greeting = hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
  return (
    <>
      <Topbar
        crumb={<>Edify CRM <span className="text-hint">/</span> <b className="font-semibold text-ink">Agent Home</b></>}
        search="Search leads, agents, records…"
        status={`${liveAgentCount} agent${liveAgentCount === 1 ? "" : "s"} live`}
      />

      <div className="mx-auto max-w-[920px] px-10 pb-[60px] pt-[72px]">
        {/* GREETING */}
        <div className="mb-3.5 flex items-start gap-[22px]">
          <div className="mt-2 flex-shrink-0">
            <Icon name="burst" size={46} strokeWidth={2.4} />
          </div>
          <h1 className="font-serif text-[58px] font-normal leading-[1.02] tracking-[-.01em] text-ink">
            {greeting}, {firstName}.<br />
            Let's <i className="italic">grow the cohort.</i>
          </h1>
        </div>
        <p className="mb-9 ml-[68px] flex items-center gap-2.5 text-[15px] text-mute">
          {summary.overall.hotOvernight} lead{summary.overall.hotOvernight === 1 ? "" : "s"} went hot overnight ·
          your agents have {summary.overall.pendingApprovals} action{summary.overall.pendingApprovals === 1 ? "" : "s"} queued.
          <Link href="/leads" className="font-medium text-brand-violet underline underline-offset-[3px]">
            Review the queue →
          </Link>
        </p>

        {/* COMMAND BOX */}
        <div className="mb-[18px] rounded-[22px] border border-rule2 bg-paper px-6 pb-4 pt-[22px] shadow-soft">
          <div className="mb-9 font-serif text-[19px] font-normal tracking-[.005em] text-hint">
            What should your CRM do today?
          </div>
          <div className="flex items-center gap-2.5">
            <button className="grid h-[34px] w-[34px] place-items-center rounded-full border border-rule bg-warm text-[18px] text-ink">
              +
            </button>
            <CmdPick icon="bars" label="Pick a segment" />
            <CmdPick icon="spark" label="Act" />
            <div className="flex-1" />
            <div className="flex items-center gap-2 text-[13px] font-medium text-mute">
              Edify Agent <b className="font-bold text-ink">Opus 4.8</b>
            </div>
            <button className="grid h-[38px] w-[38px] place-items-center rounded-full bg-grad text-white shadow-glow">
              <Icon name="arrow-right" size={16} strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* QUICK CHIPS */}
        <div className="mb-12 flex flex-wrap gap-2 pl-0.5">
          <QaChip icon="send" label="Draft follow-ups for hot leads" />
          <QaChip icon="clock" label="Book demos for this week" />
          <QaChip icon="chart" label="Forecast May enrolments" />
          <QaChip icon="star" label="Find leads at risk of churn" />
        </div>

        {/* ACTIVE AGENTS */}
        <SectionHead label="Your active agents" more="Manage all →" />
        <div className="mb-12 grid grid-cols-1 gap-3.5 md:grid-cols-2">
          {agentCards.map((a) => (
            <Link
              href="/leads"
              key={a.id}
              className="group flex flex-col gap-3 overflow-hidden rounded-2xl border border-rule bg-paper p-5 transition hover:-translate-y-0.5 hover:border-rule2 hover:shadow-card"
            >
              <div className="flex items-center gap-3">
                <div className={cn("flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[11px] text-white", avatarGradClass[a.glyph])}>
                  <Icon name={a.iconKey as IconName} size={18} strokeWidth={1.8} />
                </div>
                <div>
                  <div className="text-[16px] font-bold tracking-tight">{a.name}</div>
                  <div className="mono-cap mt-0.5 flex items-center gap-1.5 text-[9.5px] text-mute">
                    {a.live && <span className="h-1.5 w-1.5 rounded-full bg-state-ok shadow-[0_0_8px_#2E9E6A]" />}
                    <span>{a.status}</span>
                  </div>
                </div>
              </div>
              <div className="text-[13px] leading-[1.5] text-mute">{a.desc}</div>
              <div className="mono-cap flex items-center justify-between border-t border-rule pt-3 text-[10px] tracking-[.06em] text-mute">
                <span><b className="font-semibold text-ink">{a.metricValue}</b> {a.metricLabel}</span>
                <span className="rounded-full bg-warm2 px-2.5 py-1 text-[10px] font-semibold text-ink2">{a.rightPill}</span>
              </div>
            </Link>
          ))}
        </div>

        {/* FEED */}
        <SectionHead label="Agent activity · today" more="Full log →" />
        <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
          {feedItems.map((f) => (
            <div
              key={f.id}
              className="grid grid-cols-[34px_1fr_auto] items-start gap-[14px] border-b border-rule px-5 py-4 last:border-b-0"
            >
              <div
                className="mt-px flex h-[34px] w-[34px] items-center justify-center rounded-[10px]"
                style={{ background: f.iconBg }}
              >
                <Icon name={f.iconKey as IconName} size={15} strokeWidth={1.8} stroke={f.iconStroke} />
              </div>
              <div>
                <div className="text-[14px] font-semibold leading-snug tracking-[-.005em]">
                  <b className="font-bold">{f.actorName}</b>
                  {" "}{f.verb}{" "}
                  {f.payload?.subject && <b className="font-bold">{f.payload.subject}</b>}
                  {f.payload?.verbAfter ? ` ${f.payload.verbAfter}` : ""}
                </div>
                <div className="mt-[3px] text-[12.5px] leading-[1.45] text-mute">{f.detail}</div>
                <FeedTag tag={f.tag} />
              </div>
              <div className="mt-[3px] whitespace-nowrap font-mono text-[10px] tracking-[.06em] text-hint">
                {timeAgo(f.ts)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function SectionHead({ label, more }: { label: string; more: string }) {
  return (
    <div className="mb-4 flex items-baseline justify-between px-0.5">
      <div className="flex items-center gap-[9px]">
        <span className="h-[1.5px] w-[18px] bg-brand-violet" />
        <span className="mono-cap text-[11px] font-semibold tracking-[.16em] text-brand-violet">
          {label}
        </span>
      </div>
      <div className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">{more}</div>
    </div>
  );
}

function CmdPick({ icon, label }: { icon: IconName; label: string }) {
  return (
    <button className="flex items-center gap-2 rounded-full border border-rule bg-warm px-[14px] py-2 text-[13px] font-semibold text-ink2">
      <Icon name={icon} size={13} strokeWidth={1.8} className="text-mute" />
      <span>{label}</span>
      <span className="text-[11px] text-hint">⌄</span>
    </button>
  );
}

function QaChip({ icon, label }: { icon: IconName; label: string }) {
  return (
    <button className="group inline-flex items-center gap-2 rounded-full border border-rule bg-paper px-[14px] py-2 text-[13px] font-medium text-ink2 transition hover:-translate-y-px hover:border-brand-violet hover:text-brand-violet">
      <span className="flex h-[18px] w-[18px] items-center justify-center rounded-md bg-grad-soft">
        <Icon name={icon} size={11} strokeWidth={2} className="text-brand-violet" />
      </span>
      {label}
    </button>
  );
}

function FeedTag({ tag }: { tag: "auto" | "sent" | "need" }) {
  const label = tag === "auto" ? "Auto-scored" : tag === "sent" ? "Sent" : "Needs approval";
  const cls = {
    auto: "bg-[rgba(107,31,184,.08)] text-brand-violet",
    sent: "bg-[rgba(46,158,106,.10)] text-state-ok",
    need: "bg-[rgba(224,138,30,.12)] text-state-amber",
  }[tag];
  return (
    <span className={cn("mono-cap mt-1.5 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-semibold tracking-[.08em]", cls)}>
      {label}
    </span>
  );
}

