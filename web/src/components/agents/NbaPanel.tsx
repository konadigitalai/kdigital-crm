"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { LeadPicker } from "@/components/agents/LeadPicker";
import { refreshNba } from "@/lib/api";
import type { Lead } from "@/lib/types";

export function NbaPanel({ leads }: { leads: Lead[] }) {
  const router = useRouter();
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    leadNumber: string;
    nba: { nbaLabel: string; nbaIcon: string; nbaHeadline: string; nbaWhy: string; nbaConfidence: number };
  } | null>(null);

  async function onRun() {
    if (!picked) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const out = await refreshNba(picked);
      setResult({ leadNumber: picked, nba: out.nba });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-rule bg-paper p-5">
        <div className="mb-3 flex items-start gap-3">
          <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[10px] bg-brand-violet text-white">
            <Icon name="star" size={16} strokeWidth={2} />
          </span>
          <div>
            <div className="text-[15px] font-bold tracking-tight">Suggest the next-best-action</div>
            <div className="mt-0.5 text-[12.5px] text-mute">
              The agent picks ONE concrete action to advance this lead. Action respects the rating
              (cold → light nurture, hot → close-the-deal moves, enrolled → ask for referral).
              Cited evidence in the "why" line — never platitudes.
            </div>
          </div>
        </div>

        <LeadPicker leads={leads} value={picked} onChange={setPicked} disabled={busy} />

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={onRun}
            disabled={!picked || busy}
            className="btn-grad disabled:opacity-50"
          >
            {busy ? "Thinking…" : "Suggest next action"}
          </button>
          <span className="text-[11.5px] text-mute">
            Or click <b>Refresh suggestion</b> on a lead's record page.
          </span>
        </div>

        {error && (
          <div className="mt-3 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
            {error}
          </div>
        )}

        {result && (
          <div className="nba-aurora relative mt-4 overflow-hidden rounded-[14px] bg-ink p-5 text-white">
            <div className="relative z-[1] mb-3 flex items-center gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-grad">
                <Icon name="star" size={13} strokeWidth={1.9} className="text-white" />
              </span>
              <span className="mono-cap text-[10px] font-semibold tracking-[.14em] text-white/60">
                Suggested next action
              </span>
              <span className="mono-cap ml-auto font-mono text-[10px] tracking-[.08em] text-[#B7F35A]">
                {result.nba.nbaConfidence}% confidence
              </span>
            </div>
            <div className="relative z-[1] mb-2 font-serif text-[20px] leading-[1.25] text-white">
              {result.nba.nbaHeadline}
            </div>
            <div className="relative z-[1] mb-3 text-[12.5px] leading-[1.5] text-white/70">
              {result.nba.nbaWhy}
            </div>
            <div className="relative z-[1] flex items-center gap-3">
              <span className="rounded-full bg-white/10 px-3 py-1.5 text-[11.5px] font-semibold">
                {result.nba.nbaLabel}
              </span>
              <Link
                href={`/records/${result.leadNumber}`}
                className="text-[12.5px] font-semibold text-white/80 hover:text-white hover:underline"
              >
                Open lead →
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
