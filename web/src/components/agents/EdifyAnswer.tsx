"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  refreshNba,
  rescoreAllLeads,
  rescoreLead,
  runForecast,
  runOutreachDraft,
} from "@/lib/api";
import type { EdifyAnswer as TEdifyAnswer, EdifyCitation } from "@/lib/types";

const CITATION_STYLES: Record<EdifyCitation["kind"], { bg: string; text: string }> = {
  lead:    { bg: "bg-[rgba(199,25,122,.10)]", text: "text-brand-magenta" },
  learner: { bg: "bg-[rgba(46,158,106,.10)]", text: "text-state-ok" },
  case:    { bg: "bg-[rgba(224,138,30,.12)]", text: "text-state-amber" },
  program: { bg: "bg-[rgba(31,63,207,.08)]",  text: "text-brand-blue" },
  cohort:  { bg: "bg-[rgba(31,63,207,.08)]",  text: "text-brand-blue" },
  user:    { bg: "bg-warm2",                   text: "text-ink2" },
  agent:   { bg: "bg-[rgba(107,31,184,.08)]", text: "text-brand-violet" },
};

function citationHref(c: EdifyCitation): string | null {
  switch (c.kind) {
    case "lead":    return `/records/${c.ref}`;
    case "learner": return `/learners/${c.ref}`;
    case "case":    return `/cases/${c.ref}`;
    case "agent":   return `/agents/${c.ref}`;
    case "program": return `/admin/programs`;
    case "cohort":  return `/admin/cohorts`;
    case "user":    return null;  // user management moved to Auth0; no in-app page
    default:        return null;
  }
}

export function EdifyAnswer({ entry }: { entry: TEdifyAnswer }) {
  const router = useRouter();
  const [actionPhase, setActionPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);

  async function runSuggested() {
    if (!entry.suggestedAction) return;
    setActionPhase("running");
    setActionError(null);
    setActionResult(null);
    try {
      const a = entry.suggestedAction;
      switch (a.action) {
        case "draft_outreach":
          if (!a.leadNumber) throw new Error("Missing lead number");
          await runOutreachDraft(a.leadNumber);
          setActionResult(`Draft created for ${a.leadNumber}. Open the lead to approve & send.`);
          break;
        case "rescore_lead":
          if (!a.leadNumber) throw new Error("Missing lead number");
          await rescoreLead(a.leadNumber);
          setActionResult(`Re-scored ${a.leadNumber}.`);
          break;
        case "refresh_nba":
          if (!a.leadNumber) throw new Error("Missing lead number");
          await refreshNba(a.leadNumber);
          setActionResult(`Refreshed next-best-action for ${a.leadNumber}.`);
          break;
        case "rescore_all": {
          const r = await rescoreAllLeads();
          setActionResult(`Re-scored ${r.scored} lead${r.scored === 1 ? "" : "s"}${r.failed > 0 ? `, ${r.failed} failed` : ""}.`);
          break;
        }
        case "run_forecast":
          await runForecast();
          setActionResult("Forecast refreshed.");
          break;
      }
      setActionPhase("done");
      router.refresh();
    } catch (err) {
      setActionError((err as Error).message);
      setActionPhase("error");
    }
  }

  return (
    <div className="rounded-2xl border border-rule bg-paper p-5 shadow-card">
      {/* Question echo */}
      <div className="mb-3 flex items-start gap-2.5">
        <span className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-full bg-warm2 text-[11px] font-bold text-ink2">
          You
        </span>
        <div className="flex-1 text-[13.5px] font-semibold leading-snug text-ink">
          {entry.question}
        </div>
      </div>

      {/* Answer */}
      <div className="mb-3 flex items-start gap-2.5">
        <span className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-full bg-grad text-[11px] font-bold text-white">
          E
        </span>
        <div className="flex-1 whitespace-pre-line text-[13.5px] leading-[1.6] text-ink2">
          {entry.answer}
        </div>
      </div>

      {/* Citations */}
      {entry.citations.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-rule pt-3">
          <span className="mono-cap text-[9.5px] font-semibold tracking-[.12em] text-hint">
            Cited:
          </span>
          {entry.citations.map((c, i) => {
            const styles = CITATION_STYLES[c.kind];
            const href = citationHref(c);
            const inner = (
              <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10.5px] font-semibold transition", styles.bg, styles.text, href && "hover:underline")}>
                <span className="mono-cap text-[8.5px] font-bold tracking-[.1em] uppercase opacity-70">
                  {c.kind}
                </span>
                {c.label}
              </span>
            );
            return href ? (
              <Link key={`${c.kind}:${c.ref}:${i}`} href={href}>
                {inner}
              </Link>
            ) : (
              <span key={`${c.kind}:${c.ref}:${i}`}>{inner}</span>
            );
          })}
        </div>
      )}

      {/* Suggested action */}
      {entry.suggestedAction && (
        <div className="mt-4 rounded-[12px] border border-rule2 bg-grad-soft p-3.5">
          <div className="mb-2 flex items-start gap-2">
            <Icon name="spark" size={14} strokeWidth={2} className="mt-0.5 text-brand-violet" />
            <div className="flex-1 text-[12.5px] leading-snug text-ink2">
              <b className="font-semibold text-ink">{entry.suggestedAction.label}</b>
              <div className="mt-0.5 text-[12px] text-mute">{entry.suggestedAction.rationale}</div>
            </div>
          </div>
          {actionPhase === "idle" && (
            <button
              type="button"
              onClick={runSuggested}
              className="btn-grad"
            >
              <Icon name="arrow-right" size={13} strokeWidth={2.2} />
              {entry.suggestedAction.label}
            </button>
          )}
          {actionPhase === "running" && (
            <div className="text-[12px] font-semibold text-brand-violet">Running…</div>
          )}
          {actionPhase === "done" && actionResult && (
            <div className="flex items-center gap-2 text-[12.5px] font-semibold text-state-ok">
              <Icon name="check" size={13} strokeWidth={2.4} />
              {actionResult}
            </div>
          )}
          {actionPhase === "error" && actionError && (
            <div className="flex items-center gap-2 text-[12px] text-state-warn">
              <Icon name="info" size={13} strokeWidth={2.2} />
              {actionError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
