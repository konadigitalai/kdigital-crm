// Agent implementation registry. Surfaces which agents are wired to real
// LLM/agent code vs. which are still stubs. Used by /agents/catalog to drive
// the per-agent detail-page UI: live agents render an action panel, stub
// agents render a "Not available · Phase X will deliver…" placeholder.

export type AgentStatus = "live" | "stub";

// Visual + summary metadata for an agent. This is the source of truth for
// what the home-page card and detail-page hero show. Run rows only contribute
// "live status" (running/idle) + "target" string — never visual fields.
export interface AgentMeta {
  status: AgentStatus;
  /** Capability keys this agent supports — drives which buttons render. */
  capabilities?: string[];
  /** Phase string the user-facing "coming soon" copy mentions. */
  phase?: string;
  /** One-line description of what the stub is missing. */
  missing?: string;
  /** Avatar gradient key in the UI's avatarGradClass map. */
  glyph: "magenta" | "violet" | "blue" | "ochre" | "ok" | "mute" | "vm";
  /** Icon key the home card + detail hero render. */
  iconKey: "spark" | "star" | "clock" | "chart";
  /** One-paragraph "what this agent does" copy. */
  desc: string;
  /** Left-hand metric on the home card. e.g. value="142" + label="sent this week". */
  metricLabel: string;
  /** Right-hand pill on the home card. */
  rightPill: string;
}

export const AGENT_META: Record<string, AgentMeta> = {
  edify: {
    status: "live",
    capabilities: ["ask"],
    glyph: "vm",
    iconKey: "spark",
    desc: "On-page chat assistant. Knows leads, learners, cases, batches, programs, users — and can suggest actions like drafting outreach or running a forecast.",
    metricLabel: "questions answered",
    rightPill: "ask anything",
  },
  outreach: {
    status: "live",
    capabilities: ["draft-for-one"],
    glyph: "magenta",
    iconKey: "spark",
    desc: "Drafts personalised follow-up emails from each lead's timeline, signals, and rating. Drafts wait for human approval before they send.",
    metricLabel: "drafts queued",
    rightPill: "supervised",
  },
  scoring: {
    status: "live",
    capabilities: ["score-one", "score-all"],
    glyph: "violet",
    iconKey: "star",
    desc: "Re-scores leads on intent, fit, and urgency using profile, payment trail, advisor notes, recent activity, and human rating. Writes back score + signals.",
    metricLabel: "leads scored",
    rightPill: "live",
  },
  nba: {
    status: "live",
    capabilities: ["suggest-for-one"],
    glyph: "violet",
    iconKey: "star",
    desc: "Picks the single most leveraged action for a lead. Action respects the rating: cold → light nurture, hot → close-the-deal, enrolled → ask for referral.",
    metricLabel: "suggestions made",
    rightPill: "on demand",
  },
  scheduler: {
    status: "stub",
    phase: "Phase E",
    missing: "Calendar booking + WhatsApp confirmation",
    glyph: "blue",
    iconKey: "clock",
    desc: "Will find demo slots that fit each lead's timezone, book them, and send calendar invites with the right advisor.",
    metricLabel: "demos booked",
    rightPill: "coming soon",
  },
  forecast: {
    status: "live",
    capabilities: ["run-snapshot"],
    glyph: "ochre",
    iconKey: "chart",
    desc: "Projects weighted pipeline + revenue, flags risks (silent leads, overdue fees), and picks 3-5 priority leads to work first.",
    metricLabel: "weighted pipeline",
    rightPill: "on demand",
  },
  triage: {
    status: "stub",
    phase: "Phase F",
    missing: "Inbound channel intake (WhatsApp / email) + service-case routing",
    glyph: "magenta",
    iconKey: "spark",
    desc: "Will classify inbound messages across WhatsApp, email and call transcripts into service cases, and route to the right rep.",
    metricLabel: "cases routed",
    rightPill: "coming soon",
  },
  onboarding: {
    status: "stub",
    phase: "Phase F",
    missing: "Enrolment-to-learner step tracking + nudges",
    glyph: "ok",
    iconKey: "spark",
    desc: "Will track every enrolled learner through onboarding milestones — payments, course access, schedule confirmations — and nudge when steps stall.",
    metricLabel: "learners onboarded",
    rightPill: "coming soon",
  },
};

const FALLBACK: AgentMeta = {
  status: "stub",
  phase: "TBD",
  missing: "Not yet specified.",
  glyph: "violet",
  iconKey: "star",
  desc: "Agent metadata not yet defined.",
  metricLabel: "runs",
  rightPill: "—",
};

export function metaFor(key: string): AgentMeta {
  return AGENT_META[key] ?? FALLBACK;
}
