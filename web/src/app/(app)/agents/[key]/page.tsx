import Link from "next/link";
import { notFound } from "next/navigation";
import { Topbar } from "@/components/shell/Topbar";
import { Icon, type IconName } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { getAgentCatalog, getAgentRunHistory, getEdifySession, getEdifySessions, getForecastLatest, getLeads } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { OutreachPanel } from "@/components/agents/OutreachPanel";
import { ScoringPanel } from "@/components/agents/ScoringPanel";
import { NbaPanel } from "@/components/agents/NbaPanel";
import { ForecastPanel } from "@/components/agents/ForecastPanel";
import { EdifyPanel } from "@/components/agents/EdifyPanel";
import { NotAvailablePanel } from "@/components/agents/NotAvailablePanel";
import { AgentRunHistory } from "@/components/agents/AgentRunHistory";

const GLYPH: Record<string, { bg: string; icon: IconName }> = {
  edify:      { bg: "bg-grad",          icon: "spark" },
  outreach:   { bg: "bg-brand-magenta", icon: "spark" },
  scoring:    { bg: "bg-brand-violet",  icon: "star"  },
  nba:        { bg: "bg-brand-violet",  icon: "star"  },
  scheduler:  { bg: "bg-brand-blue",    icon: "clock" },
  forecast:   { bg: "bg-brand-ochre",   icon: "chart" },
  triage:     { bg: "bg-brand-magenta", icon: "spark" },
  onboarding: { bg: "bg-state-ok",      icon: "spark" },
};

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ session?: string }>;
}) {
  await requirePagePermission("agents.read");
  const { key } = await params;
  const { session: sessionFromUrl } = await searchParams;
  const [catalog, runs, leads, forecast, edifySessions] = await Promise.all([
    getAgentCatalog(),
    getAgentRunHistory(key, 10),
    getLeads(),
    key === "forecast" ? getForecastLatest() : Promise.resolve(null),
    key === "edify" ? getEdifySessions(50) : Promise.resolve([]),
  ]);

  // For Edify, pre-load one session if requested OR the most recent one.
  let edifyActiveId: string | null = null;
  let edifyMessages: import("@/lib/types").EdifyAnswer[] = [];
  if (key === "edify") {
    const targetId = sessionFromUrl ?? edifySessions[0]?.id ?? null;
    if (targetId) {
      const data = await getEdifySession(targetId);
      if (data) {
        edifyActiveId = data.session.id;
        edifyMessages = data.messages;
      }
    }
  }

  const agent = catalog.find((a) => a.key === key);
  if (!agent) notFound();
  const visual = GLYPH[key] ?? { bg: "bg-brand-violet", icon: "spark" as IconName };

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/agents" className="cursor-pointer hover:text-ink">Agents</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">{agent.name}</b>
          </>
        }
        status="Synced"
      />

      <div className="px-9 pb-[60px] pt-7">
        {/* HERO */}
        <div className="mb-6 flex items-start gap-4">
          <div className={cn("grid h-[52px] w-[52px] flex-shrink-0 place-items-center rounded-[14px] text-white", visual.bg)}>
            <Icon name={visual.icon} size={22} strokeWidth={1.8} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="font-serif text-[36px] font-normal leading-none tracking-[-.01em]">
              {agent.name}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[10.5px] tracking-[.04em] text-mute">
              <span>{agent.domain} · operates on {agent.operatesOn.replace("_", " ")}</span>
              <span>·</span>
              <span>mode: <b className="font-semibold text-ink">{agent.mode}</b></span>
              <span>·</span>
              <span>{agent.runsToday} run{agent.runsToday === 1 ? "" : "s"} · 24h</span>
              <span>·</span>
              <span>last: {formatRelative(agent.lastRun?.startedAt ?? null)}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {agent.status === "live" ? (
              <span className="mono-cap inline-flex items-center gap-1.5 rounded-full bg-state-ok/10 px-2.5 py-1 text-[10px] font-bold tracking-[.12em] text-state-ok">
                <span className="h-1.5 w-1.5 rounded-full bg-state-ok shadow-[0_0_8px_#2E9E6A]" />
                LIVE
              </span>
            ) : (
              <span className="mono-cap inline-flex items-center gap-1.5 rounded-full bg-state-amber/10 px-2.5 py-1 text-[10px] font-bold tracking-[.12em] text-state-amber">
                Coming soon
              </span>
            )}
            {!agent.enabled && (
              <span className="mono-cap inline-flex items-center gap-1.5 rounded-full bg-warm2 px-2.5 py-1 text-[10px] font-bold tracking-[.12em] text-mute">
                Disabled
              </span>
            )}
          </div>
        </div>

        {/* ACTION PANEL — picks the right component for the agent */}
        {agent.status === "stub" ? (
          <NotAvailablePanel
            agentName={agent.name}
            phase={agent.phase}
            missing={agent.missing}
          />
        ) : key === "outreach" ? (
          <OutreachPanel leads={leads} />
        ) : key === "scoring" ? (
          <ScoringPanel leads={leads} />
        ) : key === "nba" ? (
          <NbaPanel leads={leads} />
        ) : key === "forecast" ? (
          <ForecastPanel initial={forecast} />
        ) : key === "edify" ? (
          <EdifyPanel
            initialSessions={edifySessions}
            initialActiveId={edifyActiveId}
            initialMessages={edifyMessages}
          />
        ) : (
          // Live agent we don't have a panel for yet (shouldn't happen, but
          // fall back to NotAvailablePanel rather than rendering nothing).
          <NotAvailablePanel
            agentName={agent.name}
            phase="TBD"
            missing="Action panel not implemented yet."
          />
        )}

        {/* HISTORY */}
        <div className="mt-7">
          <div className="mono-cap mb-3 flex items-center gap-[9px] text-[11px] font-semibold tracking-[.16em] text-brand-violet">
            <span className="h-[1.5px] w-[18px] bg-brand-violet" />
            Recent runs · last 10
          </div>
          <AgentRunHistory runs={runs} />
        </div>
      </div>
    </>
  );
}
