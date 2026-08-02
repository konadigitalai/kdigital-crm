"use client";

// The applicant pipeline for one role, plus the "put someone forward" picker.
//
// The picker is fed from /candidates?eligible=1, which reads the
// candidate_eligible view — qualified AND consented AND profile ready. It
// deliberately does not offer ineligible people with a disabled row and a
// tooltip: that would leak, to whoever is looking at this screen, that a named
// learner declined to be put forward. If they are not offerable they are
// simply not here.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { createApplication, updateApplication } from "@/lib/api";
import type { ApplicationStage, ApplicationSummary, Candidate } from "@/lib/types";
import {
  DialogShell, ErrorNote, Pill, formatMonths, humanise,
} from "@/components/admin/formKit";

// The order a candidate moves through. Terminal stages sit outside it.
const FUNNEL: ApplicationStage[] = ["applied", "screening", "shortlisted", "interviewing", "offered"];
const TERMINAL: ApplicationStage[] = ["hired", "rejected", "withdrawn"];

const STAGE_TONE: Record<ApplicationStage, "good" | "warn" | "bad" | "info" | "brand" | "neutral"> = {
  applied: "neutral",
  screening: "neutral",
  shortlisted: "info",
  interviewing: "info",
  offered: "brand",
  hired: "good",
  rejected: "bad",
  withdrawn: "warn",
};

export function RequisitionPipeline({
  requisitionId, requisitionOpen, initial, availableCandidates,
}: {
  requisitionId: string;
  requisitionOpen: boolean;
  initial: ApplicationSummary[];
  availableCandidates: Candidate[];
}) {
  const router = useRouter();
  const [applications, setApplications] = useState<ApplicationSummary[]>(initial);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const columns = useMemo(() => {
    const map = new Map<ApplicationStage, ApplicationSummary[]>();
    for (const s of [...FUNNEL, ...TERMINAL]) map.set(s, []);
    for (const a of applications) map.get(a.stage)?.push(a);
    return map;
  }, [applications]);

  async function add(candidate: Candidate) {
    setBusy(candidate.partyId); setError(null);
    try {
      const created = await createApplication({
        candidatePartyId: candidate.partyId,
        requisitionId,
      });
      setApplications((all) => [
        ...all,
        {
          id: created.id,
          number: created.number,
          stage: created.stage,
          screeningScore: created.screeningScore,
          appliedAt: created.appliedAt,
          candidatePartyId: created.candidatePartyId,
          candidateName: created.candidateName,
          candidateNumber: created.candidateNumber,
        },
      ]);
      setPicking(false);
      router.refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  async function advance(a: ApplicationSummary, stage: ApplicationStage) {
    if (stage === a.stage) return;
    // Rejection needs a reason, which needs a form — send the user to the
    // Applications screen rather than half-collecting it in a dropdown.
    if (stage === "rejected") {
      router.push("/staffing/applications");
      return;
    }
    setBusy(a.id); setError(null);
    try {
      const updated = await updateApplication(a.id, { stage });
      setApplications((all) => all.map((x) => (x.id === a.id ? { ...x, stage: updated.stage } : x)));
      router.refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  const terminalCount = TERMINAL.reduce((n, s) => n + (columns.get(s)?.length ?? 0), 0);

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-serif text-[24px] font-normal tracking-[-.01em]">Pipeline</h2>
        <button
          onClick={() => setPicking(true)}
          disabled={!requisitionOpen || availableCandidates.length === 0}
          title={
            !requisitionOpen ? "Only open requisitions accept applications"
            : availableCandidates.length === 0 ? "No eligible candidates available"
            : undefined
          }
          className="btn-grad disabled:opacity-50"
        >
          <Icon name="plus" size={14} strokeWidth={2.2} /> Put a candidate forward
        </button>
      </div>

      <ErrorNote message={error} />

      <div className="mt-4 grid grid-cols-5 gap-3">
        {FUNNEL.map((stage) => {
          const cards = columns.get(stage) ?? [];
          return (
            <div key={stage} className="flex min-h-[160px] flex-col rounded-2xl border border-rule bg-warm/40">
              <header className="mono-cap flex items-center justify-between border-b border-rule px-3 py-2.5 text-[9.5px] font-semibold tracking-[.1em] text-mute">
                <span>{humanise(stage)}</span>
                <span className="text-hint">{cards.length}</span>
              </header>
              <div className="flex flex-1 flex-col gap-2 p-2">
                {cards.length === 0 && (
                  <div className="px-2 py-5 text-center text-[11px] text-hint">—</div>
                )}
                {cards.map((a) => (
                  <article
                    key={a.id}
                    className={cn(
                      "rounded-[10px] border border-rule bg-paper p-2.5",
                      busy === a.id && "opacity-50",
                    )}
                  >
                    <Link
                      href={`/learners/${a.candidatePartyId}`}
                      className="block truncate text-[12.5px] font-semibold hover:text-brand-violet"
                    >
                      {a.candidateName}
                    </Link>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] text-hint">{a.candidateNumber}</span>
                      {a.screeningScore != null && (
                        <span className="font-mono text-[11px] text-ink2">{a.screeningScore}</span>
                      )}
                    </div>
                    <select
                      value={a.stage}
                      disabled={busy === a.id}
                      onChange={(e) => advance(a, e.target.value as ApplicationStage)}
                      className="mt-2 w-full rounded-md border border-rule bg-warm/60 px-1.5 py-1 text-[11px] text-ink2 outline-none focus:border-brand-violet"
                    >
                      {[...FUNNEL, ...TERMINAL].map((s) => (
                        <option key={s} value={s}>{humanise(s)}</option>
                      ))}
                    </select>
                  </article>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {terminalCount > 0 && (
        <div className="mt-4 rounded-2xl border border-rule bg-paper">
          <header className="mono-cap border-b border-rule bg-warm px-4 py-2.5 text-[10px] font-semibold tracking-[.12em] text-mute">
            Closed ({terminalCount})
          </header>
          <div className="flex flex-wrap gap-2 p-3">
            {TERMINAL.flatMap((s) => (columns.get(s) ?? []).map((a) => (
              <div key={a.id} className="flex items-center gap-2 rounded-full border border-rule px-3 py-1.5">
                <Link href={`/learners/${a.candidatePartyId}`} className="text-[12px] font-semibold hover:text-brand-violet">
                  {a.candidateName}
                </Link>
                <Pill tone={STAGE_TONE[a.stage]}>{humanise(a.stage)}</Pill>
              </div>
            )))}
          </div>
        </div>
      )}

      {picking && (
        <DialogShell
          title="Put a candidate forward"
          wide
          subtitle="Only candidates who are qualified, have granted staffing consent, and have a ready profile appear here."
          onClose={() => setPicking(false)}
        >
          <div className="max-h-[420px] space-y-2 overflow-y-auto">
            {availableCandidates.length === 0 && (
              <p className="py-8 text-center text-[13px] text-mute">
                Nobody eligible is available for this role right now.
              </p>
            )}
            {availableCandidates.map((c) => (
              <button
                key={c.partyId}
                onClick={() => add(c)}
                disabled={busy === c.partyId}
                className="flex w-full items-center gap-3 rounded-[10px] border border-rule bg-paper p-3 text-left transition hover:border-brand-violet disabled:opacity-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold">{c.name}</span>
                    <span className="font-mono text-[10px] text-hint">{c.number}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[11.5px] text-mute">
                    {[
                      formatMonths(c.totalExperienceMonths),
                      c.currentDesignation,
                      c.skills.slice(0, 4).join(", "),
                    ].filter(Boolean).join(" · ")}
                  </div>
                </div>
                {c.openApplicationCount > 0 && (
                  <Pill tone="info">{c.openApplicationCount} open</Pill>
                )}
              </button>
            ))}
          </div>
          <div className="flex justify-end pt-4">
            <button onClick={() => setPicking(false)} className="btn">Close</button>
          </div>
        </DialogShell>
      )}
    </section>
  );
}
