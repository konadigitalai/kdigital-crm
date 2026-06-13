"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { runForecast } from "@/lib/api";
import { ratingStyles } from "@/lib/ui";
import type { ForecastSnapshot, LeadRating } from "@/lib/types";

function fmtINRShort(n: number): string {
  if (!n || isNaN(n)) return "₹0";
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(1).replace(/\.0$/, "")}Cr`;
  if (n >= 1_00_000)    return `₹${(n / 1_00_000).toFixed(1).replace(/\.0$/, "")}L`;
  if (n >= 1_000)       return `₹${Math.round(n / 1_000)}k`;
  return `₹${Math.round(n)}`;
}

function fmtINRFull(n: number): string {
  if (!n || isNaN(n)) return "—";
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function ForecastPanel({ initial }: { initial: ForecastSnapshot | null }) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<ForecastSnapshot | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRun() {
    setBusy(true); setError(null);
    try {
      const out = await runForecast();
      setSnapshot(out);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!snapshot) {
    return (
      <div className="rounded-2xl border border-rule bg-paper p-7">
        <div className="mb-3 flex items-start gap-3">
          <span className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-[12px] bg-brand-ochre text-white">
            <Icon name="chart" size={18} strokeWidth={2} />
          </span>
          <div>
            <h2 className="font-serif text-[24px] font-normal leading-tight tracking-[-.01em]">
              No forecast yet
            </h2>
            <p className="mt-1 text-[13px] text-mute">
              Click the button below — the agent aggregates your pipeline + revenue + cohort fill,
              then asks Claude for a tight briefing with risks, opportunities, and 3-5 priority leads.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={busy}
          className="btn-grad disabled:opacity-50"
        >
          {busy ? "Running…" : "Run forecast now"}
        </button>
        {error && (
          <div className="mt-3 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
            {error}
          </div>
        )}
      </div>
    );
  }

  const { numbers, narrative, generatedAt } = snapshot;
  const t = numbers.totals;

  return (
    <div className="space-y-4">
      {/* HEADER + HEALTH SUMMARY (dark hero) */}
      <div className="nba-aurora relative overflow-hidden rounded-[18px] bg-ink p-6 text-white">
        <div className="relative z-[1] mb-3 flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-grad">
            <Icon name="chart" size={14} strokeWidth={2} className="text-white" />
          </span>
          <span className="mono-cap text-[10px] font-semibold tracking-[.14em] text-white/60">
            Forecast · generated {timeAgo(generatedAt)}
          </span>
          <span className="mono-cap ml-auto text-[10px] tracking-[.04em] text-white/50">
            model {snapshot.model ?? "—"} · {snapshot.tokensIn ?? 0}+{snapshot.tokensOut ?? 0} tokens
          </span>
        </div>
        <div className="relative z-[1] mb-2 grid grid-cols-3 gap-6">
          <Headline value={fmtINRShort(t.weightedPipelineINR)} label="weighted pipeline" />
          <Headline value={fmtINRShort(t.collectedFeeINR)} label="fees collected" />
          <Headline value={`${t.enrolledLast30d}`} label="enrolled · 30d" />
        </div>
        <div className="relative z-[1] mt-3 font-serif text-[20px] leading-[1.3] text-white">
          {narrative.headline}
        </div>
        <div className="relative z-[1] mt-2 text-[13px] leading-[1.55] text-white/70">
          {narrative.healthSummary}
        </div>
        {narrative.monthTargetReadout && (
          <div className="relative z-[1] mt-3 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-[11.5px] font-semibold text-[#B7F35A]">
            <Icon name="check" size={11} strokeWidth={2.4} />
            {narrative.monthTargetReadout}
          </div>
        )}
        <div className="relative z-[1] mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={onRun}
            disabled={busy}
            className="rounded-full border-0 bg-white px-4 py-2 text-[12px] font-semibold text-ink disabled:opacity-60"
          >
            {busy ? "Refreshing…" : "Run forecast again"}
          </button>
          {error && (
            <span className="text-[11px] text-state-warn">{error}</span>
          )}
        </div>
      </div>

      {/* RATING FUNNEL */}
      <div className="rounded-2xl border border-rule bg-paper p-5">
        <div className="mono-cap mb-3 text-[10px] font-semibold tracking-[.12em] text-brand-violet">
          Rating funnel
        </div>
        <FunnelBars rows={numbers.ratingFunnel} />
      </div>

      {/* RISKS + OPPORTUNITIES */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-rule bg-paper p-5">
          <div className="mono-cap mb-3 text-[10px] font-semibold tracking-[.12em] text-state-warn">
            Risks
          </div>
          {narrative.risks.length === 0 ? (
            <div className="text-[12.5px] italic text-mute">Nothing flagged.</div>
          ) : (
            <ul className="space-y-2">
              {narrative.risks.map((r, i) => (
                <li
                  key={i}
                  className={cn(
                    "rounded-[10px] border p-3 text-[13px]",
                    r.severity === "high" && "border-state-warn/50 bg-state-warn/5",
                    r.severity === "med"  && "border-state-amber/50 bg-state-amber/5",
                    r.severity === "low"  && "border-rule bg-warm/40",
                  )}
                >
                  <div className="font-semibold text-ink">{r.title}</div>
                  <div className="mt-0.5 text-[12.5px] text-ink2">{r.detail}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-2xl border border-rule bg-paper p-5">
          <div className="mono-cap mb-3 text-[10px] font-semibold tracking-[.12em] text-state-ok">
            Opportunities
          </div>
          {narrative.opportunities.length === 0 ? (
            <div className="text-[12.5px] italic text-mute">No standout opportunities flagged.</div>
          ) : (
            <ul className="space-y-2">
              {narrative.opportunities.map((o, i) => (
                <li key={i} className="rounded-[10px] border border-state-ok/30 bg-state-ok/5 p-3 text-[13px]">
                  <div className="font-semibold text-ink">★ {o.title}</div>
                  <div className="mt-0.5 text-[12.5px] text-ink2">{o.detail}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* PRIORITY LEADS */}
      {narrative.priorityLeads.length > 0 && (
        <div className="rounded-2xl border border-rule bg-paper p-5">
          <div className="mono-cap mb-3 text-[10px] font-semibold tracking-[.12em] text-brand-magenta">
            Priority leads — work these first
          </div>
          <ul className="divide-y divide-rule">
            {narrative.priorityLeads.map((l) => {
              const meta = numbers.topOpenLeads.find((t) => t.number === l.leadNumber);
              const ratingChip = meta ? ratingStyles[meta.rating as LeadRating] : null;
              return (
                <li key={l.leadNumber} className="flex items-start gap-3 py-3">
                  {ratingChip && (
                    <span className={cn("mt-0.5 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-semibold", ratingChip.bg, ratingChip.text)}>
                      <span className={cn("h-1.5 w-1.5 rounded-full", ratingChip.dot)} />
                      {ratingChip.label}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <Link href={`/records/${l.leadNumber}`} className="text-[13.5px] font-semibold text-brand-violet hover:underline">
                      {l.leadNumber}
                      {meta && <span className="ml-2 text-ink"> · {meta.name}</span>}
                    </Link>
                    <div className="mt-0.5 text-[12.5px] text-ink2">{l.reason}</div>
                    {meta && (
                      <div className="mono-cap mt-0.5 text-[9.5px] tracking-[.04em] text-mute">
                        {meta.program ?? "—"} · score {meta.score ?? "?"} · value {fmtINRShort(meta.parsedValueINR)}
                        {meta.daysSinceLastTouch != null && ` · last touch ${meta.daysSinceLastTouch}d ago`}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* AT-RISK COUNTS + TOTALS */}
      <div className="rounded-2xl border border-rule bg-paper p-5">
        <div className="mono-cap mb-3 text-[10px] font-semibold tracking-[.12em] text-mute">
          Numbers behind the briefing
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Active leads" value={String(numbers.totals.activeLeads)} />
          <Stat label="Parsed pipeline" value={fmtINRShort(numbers.totals.parsedPipelineINR)} />
          <Stat label="Fees due" value={fmtINRShort(numbers.totals.feeDueINR)} />
          <Stat label="Fees collected" value={fmtINRShort(numbers.totals.collectedFeeINR)} hint={fmtINRFull(numbers.totals.collectedFeeINR)} />
          <Stat label="Silent ≥7d (hot+)" value={String(numbers.atRisk.silent7d)} hint="hot/superhot leads with no activity in 7+ days" />
          <Stat label="Fees overdue" value={String(numbers.atRisk.overdueFees)} hint="leads with fee_due > 0 past due_date" />
          <Stat label="Missing program" value={String(numbers.atRisk.missingProgram)} hint="open leads with no program set" />
          <Stat label="Enrolments · 30d" value={String(numbers.totals.enrolledLast30d)} />
        </div>
      </div>

      {/* PER-PROGRAM (collapsible) */}
      {numbers.byProgram.length > 0 && (
        <details className="rounded-2xl border border-rule bg-paper p-5">
          <summary className="mono-cap cursor-pointer text-[10px] font-semibold tracking-[.12em] text-brand-violet">
            Per-program breakdown ({numbers.byProgram.length})
          </summary>
          <div className="mt-3 overflow-hidden rounded-[10px] border border-rule">
            <div className="mono-cap grid items-center gap-3 border-b border-rule bg-warm px-4 py-2 text-[9.5px] font-semibold tracking-[.12em] text-mute"
                 style={{ gridTemplateColumns: "2fr 1fr 1.5fr 1fr 1fr" }}>
              <div>Program</div>
              <div className="text-right">Price</div>
              <div>Lead mix</div>
              <div className="text-right">Enrolments</div>
              <div className="text-right">Expected</div>
            </div>
            {numbers.byProgram.map((p) => (
              <div
                key={p.programId}
                className="grid items-center gap-3 border-b border-rule px-4 py-3 text-[12.5px] last:border-b-0"
                style={{ gridTemplateColumns: "2fr 1fr 1.5fr 1fr 1fr" }}
              >
                <div className="font-semibold text-ink">{p.programName}</div>
                <div className="text-right font-mono text-ink2">
                  {p.price != null ? `₹${Number(p.price).toLocaleString("en-IN")}` : <span className="text-mute">—</span>}
                </div>
                <div className="font-mono text-[10.5px] text-mute">
                  {Object.entries(p.leadsByRating ?? {})
                    .filter(([, c]) => c)
                    .map(([r, c]) => `${r}:${c}`)
                    .join(" · ") || "—"}
                </div>
                <div className="text-right text-ink2">
                  {p.enrolments}
                  {p.enrolmentsLast30d > 0 && (
                    <span className="ml-1 text-[10px] text-state-ok">+{p.enrolmentsLast30d}/30d</span>
                  )}
                </div>
                <div className="text-right font-mono text-ink2">{fmtINRShort(p.expectedFromOpenLeadsINR)}</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function Headline({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="font-mono text-[28px] font-bold leading-none tracking-[-.01em] text-white">{value}</div>
      <div className="mono-cap mt-1 text-[10px] font-semibold tracking-[.12em] text-white/60">{label}</div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <div className="mono-cap text-[9.5px] font-semibold tracking-[.1em] text-hint">{label}</div>
      <div className="mt-0.5 font-mono text-[15px] font-bold tracking-tight text-ink">{value}</div>
    </div>
  );
}

const RATING_ORDER: LeadRating[] = ["new lead", "attempted", "cold", "warm", "hot", "superhot", "enrolled"];

function FunnelBars({ rows }: { rows: Array<{ rating: string; count: number; parsedValueINR: number }> }) {
  const byRating = new Map(rows.map((r) => [r.rating, r]));
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="space-y-2">
      {RATING_ORDER.map((r) => {
        const row = byRating.get(r) ?? { rating: r, count: 0, parsedValueINR: 0 };
        const s = ratingStyles[r];
        const pct = (row.count / max) * 100;
        return (
          <div key={r} className="flex items-center gap-3">
            <div className="w-[100px] flex-shrink-0">
              <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-semibold", s.bg, s.text)}>
                <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
                {s.label}
              </span>
            </div>
            <div className="relative flex-1 overflow-hidden rounded-md bg-warm2/60">
              <div
                className={cn("h-[20px] rounded-md transition-all", s.bg)}
                style={{ width: `${pct}%`, minWidth: row.count > 0 ? 6 : 0 }}
              />
            </div>
            <div className="w-[60px] flex-shrink-0 text-right font-mono text-[11.5px] text-ink2">
              {row.count}
            </div>
            <div className="w-[80px] flex-shrink-0 text-right font-mono text-[11.5px] text-mute">
              {fmtINRShort(row.parsedValueINR)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
