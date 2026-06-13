"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import Link from "next/link";
import {
  rescoreAllLeads,
  setAgentEnabled,
  setAgentMode,
} from "@/lib/api";
import type { AgentCatalogEntry, AgentMode } from "@/lib/types";
import { StepStrip } from "@/components/agents/StepStrip";

const DOMAIN_GLYPH: Record<string, { glyph: string; icon: "spark" | "star" | "clock" | "chart" }> = {
  outreach:   { glyph: "magenta", icon: "spark" },
  scoring:    { glyph: "violet",  icon: "star"  },
  scheduler:  { glyph: "blue",    icon: "clock" },
  forecast:   { glyph: "ochre",   icon: "chart" },
  triage:     { glyph: "magenta", icon: "spark" },
  onboarding: { glyph: "ok",      icon: "spark" },
};

const GLYPH_BG: Record<string, string> = {
  magenta: "bg-brand-magenta",
  violet:  "bg-brand-violet",
  blue:    "bg-brand-blue",
  ochre:   "bg-brand-ochre",
  ok:      "bg-state-ok",
};

const MODES: AgentMode[] = ["auto", "supervised", "manual"];

export function AgentCatalog({
  initial,
  canManage,
}: {
  initial: AgentCatalogEntry[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentCatalogEntry[]>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scoreAllResult, setScoreAllResult] = useState<{ scored: number; failed: number } | null>(null);

  function reload() { router.refresh(); }

  async function onToggle(a: AgentCatalogEntry) {
    if (!canManage) return;
    setBusy(a.key); setError(null);
    try {
      await setAgentEnabled(a.key, !a.enabled);
      setAgents((all) => all.map((x) => (x.key === a.key ? { ...x, enabled: !x.enabled } : x)));
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onModeChange(a: AgentCatalogEntry, mode: AgentMode) {
    if (!canManage || mode === a.mode) return;
    setBusy(a.key); setError(null);
    try {
      await setAgentMode(a.key, mode);
      setAgents((all) => all.map((x) => (x.key === a.key ? { ...x, mode } : x)));
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onRunScoreAll() {
    setBusy("scoring:bulk"); setError(null); setScoreAllResult(null);
    try {
      const r = await rescoreAllLeads();
      setScoreAllResult(r);
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((a) => {
          const visual = DOMAIN_GLYPH[a.key] ?? { glyph: "violet", icon: "star" as const };
          const live = a.lastRun?.live && a.lastRun?.status === "running";
          return (
            <div
              key={a.key}
              className={cn(
                "rounded-2xl border bg-paper p-5 shadow-card transition",
                a.enabled ? "border-rule" : "border-rule bg-warm/40 opacity-70",
              )}
            >
              <div className="flex items-start gap-3">
                <div
                  className={cn(
                    "grid h-[42px] w-[42px] flex-shrink-0 place-items-center rounded-[12px] text-white",
                    GLYPH_BG[visual.glyph] ?? "bg-brand-violet",
                  )}
                >
                  <Icon name={visual.icon} size={18} strokeWidth={1.8} />
                </div>
                <Link href={`/agents/${a.key}`} className="min-w-0 flex-1 hover:opacity-80">
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-bold tracking-tight">{a.name}</span>
                    {live && (
                      <span className="mono-cap inline-flex items-center gap-1 rounded-full bg-state-ok/10 px-2 py-0.5 text-[9px] font-bold tracking-[.12em] text-state-ok">
                        <span className="h-1.5 w-1.5 rounded-full bg-state-ok shadow-[0_0_8px_#2E9E6A]" />
                        LIVE
                      </span>
                    )}
                    {a.status === "stub" && (
                      <span className="mono-cap rounded-full bg-state-amber/10 px-2 py-0.5 text-[9px] font-semibold text-state-amber">
                        coming soon
                      </span>
                    )}
                    {!a.enabled && (
                      <span className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[9px] font-semibold text-mute">
                        disabled
                      </span>
                    )}
                  </div>
                  <div className="mono-cap mt-0.5 text-[10px] tracking-[.04em] text-mute">
                    {a.domain} · operates on {a.operatesOn.replace("_", " ")}
                  </div>
                </Link>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 border-t border-rule pt-3 text-[12px]">
                <Stat label="Runs · 24h" value={String(a.runsToday)} />
                <Stat
                  label="Last run"
                  value={a.lastRun ? formatRelative(a.lastRun.startedAt) : "—"}
                />
              </div>

              {a.lastRun?.steps?.length ? (
                <div className="mt-3 border-t border-rule pt-3">
                  <div className="mono-cap mb-1.5 text-[9.5px] font-semibold tracking-[.12em] text-hint">
                    Last run timeline
                  </div>
                  <StepStrip steps={a.lastRun.steps} />
                  {a.lastRun.target && (
                    <div className="mt-1 text-[12px] text-mute">{a.lastRun.target}</div>
                  )}
                </div>
              ) : null}

              <div className="mt-4 flex items-center justify-between gap-2 border-t border-rule pt-3">
                <ModePicker
                  mode={a.mode}
                  disabled={!canManage || busy === a.key}
                  onChange={(m) => onModeChange(a, m)}
                />
                <div className="flex items-center gap-2">
                  {a.key === "scoring" && (
                    <button
                      onClick={onRunScoreAll}
                      disabled={busy === "scoring:bulk" || !a.enabled}
                      className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet disabled:opacity-50"
                    >
                      {busy === "scoring:bulk" ? "Running…" : "Run score-all"}
                    </button>
                  )}
                  {canManage && (
                    <ToggleSwitch
                      enabled={a.enabled}
                      busy={busy === a.key}
                      onClick={() => onToggle(a)}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {scoreAllResult && (
        <div className="mt-6 rounded-lg border border-rule bg-paper px-4 py-3 text-[13px] text-ink2">
          <b className="font-semibold text-ink">Scoring run finished.</b>{" "}
          {scoreAllResult.scored} lead{scoreAllResult.scored === 1 ? "" : "s"} re-scored
          {scoreAllResult.failed > 0 && `, ${scoreAllResult.failed} failed`}.
        </div>
      )}

      {error && (
        <div className="mt-6 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
          {error}
        </div>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mono-cap text-[9.5px] font-semibold tracking-[.1em] text-hint">{label}</div>
      <div className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">{value}</div>
    </div>
  );
}

function ModePicker({
  mode,
  disabled,
  onChange,
}: {
  mode: AgentMode;
  disabled: boolean;
  onChange: (m: AgentMode) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-full border border-rule">
      {MODES.map((m) => (
        <button
          key={m}
          disabled={disabled}
          onClick={() => onChange(m)}
          className={cn(
            "px-2.5 py-1 text-[10.5px] font-semibold capitalize tracking-[.04em] transition",
            mode === m
              ? "bg-grad text-white"
              : "bg-paper text-mute hover:text-ink",
            disabled && "cursor-not-allowed opacity-60",
          )}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function ToggleSwitch({
  enabled,
  busy,
  onClick,
}: {
  enabled: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={enabled ? "Disable agent" : "Enable agent"}
      className={cn(
        "relative h-[22px] w-[40px] flex-shrink-0 rounded-full transition disabled:opacity-50",
        enabled ? "bg-grad" : "bg-rule2",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all",
          enabled ? "left-[20px]" : "left-0.5",
        )}
      />
    </button>
  );
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const ms = Date.now() - t;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleString();
}
