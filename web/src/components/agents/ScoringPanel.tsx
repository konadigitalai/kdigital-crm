"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { LeadPicker } from "@/components/agents/LeadPicker";
import { rescoreAllLeads, rescoreLead } from "@/lib/api";
import type { Lead } from "@/lib/types";

export function ScoringPanel({ leads }: { leads: Lead[] }) {
  const router = useRouter();
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState<"one" | "all" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [oneResult, setOneResult] = useState<{
    leadNumber: string; before: number | null; after: number;
  } | null>(null);
  const [bulkResult, setBulkResult] = useState<{ scored: number; failed: number } | null>(null);

  async function onScoreOne() {
    if (!picked) return;
    setBusy("one"); setError(null); setOneResult(null); setBulkResult(null);
    try {
      // The API returns the full result, but we don't surface the signals here —
      // the lead's record page does that. Just show the score delta.
      const before = leads.find((l) => l.number === picked)?.score ?? null;
      await rescoreLead(picked);
      // We don't get the new score back from rescoreLead's void return; refresh
      // and lift it from the lead row would be extra round-trips. For now,
      // tell the user it's done and link to the record.
      setOneResult({ leadNumber: picked, before, after: before ?? 0 });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onScoreAll() {
    setBusy("all"); setError(null); setOneResult(null); setBulkResult(null);
    try {
      const out = await rescoreAllLeads();
      setBulkResult(out);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
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
            <div className="text-[15px] font-bold tracking-tight">Re-score one lead</div>
            <div className="mt-0.5 text-[12.5px] text-mute">
              Pick a lead — the agent reads everything (profile, timeline, signals, payment trail,
              advisor notes, rating) and rewrites the score plus 4-7 fresh signals.
            </div>
          </div>
        </div>

        <LeadPicker leads={leads} value={picked} onChange={setPicked} disabled={busy !== null} />

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={onScoreOne}
            disabled={!picked || busy !== null}
            className="btn-grad disabled:opacity-50"
          >
            {busy === "one" ? "Scoring…" : "Re-score this lead"}
          </button>
          <span className="text-[11.5px] text-mute">
            Or use the <b>Re-score</b> button on a lead's record page.
          </span>
        </div>

        {oneResult && (
          <div className="mt-4 rounded-[12px] border border-state-ok/40 bg-state-ok/5 p-4 text-[13px] text-ink2">
            <div className="mb-1 flex items-center gap-2">
              <Icon name="check" size={14} strokeWidth={2.4} className="text-state-ok" />
              <span className="font-semibold text-state-ok">Score updated.</span>
            </div>
            <div>
              <Link href={`/records/${oneResult.leadNumber}`} className="font-semibold text-brand-violet hover:underline">
                Open lead to see new score + signals →
              </Link>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-rule bg-paper p-5">
        <div className="mb-3 flex items-start gap-3">
          <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[10px] bg-grad text-white">
            <Icon name="chart" size={16} strokeWidth={2} />
          </span>
          <div>
            <div className="text-[15px] font-bold tracking-tight">Re-score every open lead</div>
            <div className="mt-0.5 text-[12.5px] text-mute">
              Runs through all non-enrolled leads sequentially. One Claude call per lead, so
              expect ~2-3s × N leads. Fee paid &gt; 0 + verbal-yes signals get reflected in scores
              after this completes.
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onScoreAll}
          disabled={busy !== null}
          className="btn disabled:opacity-50"
        >
          {busy === "all" ? "Running…" : "Run score-all"}
        </button>

        {bulkResult && (
          <div className="mt-3 rounded-md border border-rule bg-warm/40 px-3 py-2 text-[12.5px] text-ink2">
            <b className="font-semibold text-ink">Done.</b>{" "}
            {bulkResult.scored} lead{bulkResult.scored === 1 ? "" : "s"} re-scored
            {bulkResult.failed > 0 && `, ${bulkResult.failed} failed`}.
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
          {error}
        </div>
      )}
    </div>
  );
}
