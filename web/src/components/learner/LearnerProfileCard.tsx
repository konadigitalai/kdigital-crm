"use client";

// Progress, risk, and the staffing gate.
//
// The staffing half of this card is the entry point to the whole placement
// module, and it is deliberately here — on the learner — rather than on their
// candidate record. Eligibility and consent are facts about the person: a
// learner who withdraws consent must disappear from staffing however many
// applications are already open, and that only works if there is exactly one
// place the answer lives. `candidate_eligible` reads these two columns and
// nothing restates them.
//
// So the card says out loud what each setting will do, including the part a
// recruiter will feel later.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { updateLearnerProfile } from "@/lib/api";
import type {
  LearnerProfileInput, RiskLevel, StaffingConsent, StaffingEligibility,
} from "@/lib/types";

const RISK_LEVELS: RiskLevel[] = ["low", "medium", "high"];

const RISK_STYLE: Record<RiskLevel, string> = {
  low:    "bg-state-ok/12 text-state-ok",
  medium: "bg-state-warn/12 text-state-warn",
  high:   "bg-state-bad/12 text-state-bad",
};

const ELIGIBILITY_OPTIONS: Array<{ value: StaffingEligibility; label: string }> = [
  { value: "not_assessed",  label: "Not assessed" },
  { value: "qualified",     label: "Qualified" },
  { value: "not_qualified", label: "Not qualified" },
];

const CONSENT_OPTIONS: Array<{ value: StaffingConsent; label: string }> = [
  { value: "not_asked", label: "Not asked" },
  { value: "granted",   label: "Granted" },
  { value: "withheld",  label: "Withheld" },
  { value: "withdrawn", label: "Withdrawn" },
];

export interface LearnerProfileState {
  progressPercent: number | null;
  riskLevel: RiskLevel | null;
  riskReason: string | null;
  staffingEligibilityStatus: StaffingEligibility;
  staffingConsentStatus: StaffingConsent;
  staffingConsentAt: string | null;
  hasCandidateProfile: number;
}

export function LearnerProfileCard({
  partyId, initial, canEdit,
}: {
  partyId: string; initial: LearnerProfileState; canEdit: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [progress, setProgress] = useState(state.progressPercent?.toString() ?? "");
  const [riskLevel, setRiskLevel] = useState<RiskLevel | "">(state.riskLevel ?? "");
  const [riskReason, setRiskReason] = useState(state.riskReason ?? "");
  const [eligibility, setEligibility] = useState<StaffingEligibility>(state.staffingEligibilityStatus);
  const [consent, setConsent] = useState<StaffingConsent>(state.staffingConsentStatus);

  const offerable =
    state.staffingEligibilityStatus === "qualified" && state.staffingConsentStatus === "granted";

  // What the recruiter will see. Withdrawing consent while applications are
  // open is legitimate and must stay possible — but it should not be a
  // surprise, so it is spelled out before the save.
  const willRevoke =
    state.hasCandidateProfile > 0 && offerable &&
    (eligibility !== "qualified" || consent !== "granted");

  async function save() {
    setBusy(true); setError(null);
    try {
      const patch: LearnerProfileInput = {
        progressPercent: progress.trim() ? Number(progress) : null,
        riskLevel: riskLevel || null,
        riskReason: riskReason.trim() || null,
        staffingEligibilityStatus: eligibility,
        staffingConsentStatus: consent,
      };
      await updateLearnerProfile(partyId, patch);
      setState((s) => ({
        ...s,
        progressPercent: patch.progressPercent ?? null,
        riskLevel: patch.riskLevel ?? null,
        riskReason: patch.riskReason ?? null,
        staffingEligibilityStatus: eligibility,
        staffingConsentStatus: consent,
        // The server stamps the moment on grant and clears it otherwise;
        // mirror that here so the card is honest before the refresh lands.
        staffingConsentAt: consent === "granted" ? new Date().toISOString() : null,
      }));
      setEditing(false);
      router.refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-rule bg-paper">
      <header className="flex items-center justify-between border-b border-rule bg-warm px-4 py-3">
        <h2 className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">
          Progress &amp; placement readiness
        </h2>
        {canEdit && !editing && (
          <button
            onClick={() => setEditing(true)}
            className="text-[11.5px] font-semibold text-brand-violet hover:underline"
          >
            Edit
          </button>
        )}
      </header>

      {!editing ? (
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-4">
            <Metric label="Course progress">
              {state.progressPercent == null ? (
                <span className="text-[13px] text-mute">Not recorded</span>
              ) : (
                <div>
                  <div className="font-mono text-[20px] leading-none">{state.progressPercent}%</div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-warm2">
                    <div
                      className="h-full rounded-full bg-grad"
                      style={{ width: `${Math.min(100, Math.max(0, state.progressPercent))}%` }}
                    />
                  </div>
                </div>
              )}
            </Metric>

            <Metric label="Risk">
              {state.riskLevel == null ? (
                <span className="text-[13px] text-mute">Not flagged</span>
              ) : (
                <>
                  <span className={cn(
                    "mono-cap inline-block rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-[.08em]",
                    RISK_STYLE[state.riskLevel],
                  )}>
                    {state.riskLevel}
                  </span>
                  {state.riskReason && (
                    <p className="mt-1.5 text-[12px] leading-[1.5] text-ink2">{state.riskReason}</p>
                  )}
                </>
              )}
            </Metric>
          </div>

          <div className="rounded-[10px] border border-rule bg-warm/30 p-3">
            <div className="mono-cap mb-2 text-[9.5px] font-semibold tracking-[.1em] text-mute">
              Staffing
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px]">
              <Fact label="Eligibility" value={labelOf(ELIGIBILITY_OPTIONS, state.staffingEligibilityStatus)} />
              <Fact label="Consent" value={labelOf(CONSENT_OPTIONS, state.staffingConsentStatus)} />
              {state.staffingConsentAt && (
                <Fact label="Consented" value={state.staffingConsentAt.slice(0, 10)} />
              )}
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              {offerable ? (
                <span className="mono-cap inline-flex items-center gap-1 rounded-full bg-state-ok/12 px-2.5 py-1 text-[10px] font-semibold tracking-[.08em] text-state-ok">
                  <Icon name="check" size={9} strokeWidth={3} /> can be put forward for roles
                </span>
              ) : (
                <span className="text-[12px] text-mute">
                  Not offerable — needs both &ldquo;qualified&rdquo; and &ldquo;granted&rdquo;.
                </span>
              )}
              {state.hasCandidateProfile > 0 && (
                <span className="mono-cap rounded-full bg-brand-violet/10 px-2.5 py-1 text-[10px] font-semibold tracking-[.08em] text-brand-violet">
                  has candidate profile
                </span>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-4">
            <Label text="Course progress %">
              <input
                className={inputCls}
                value={progress}
                onChange={(e) => setProgress(e.target.value)}
                inputMode="numeric"
                placeholder="0–100"
              />
            </Label>
            <Label text="Risk level">
              <select
                className={inputCls}
                value={riskLevel}
                onChange={(e) => setRiskLevel(e.target.value as RiskLevel | "")}
              >
                <option value="">Not flagged</option>
                {RISK_LEVELS.map((r) => (
                  <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
                ))}
              </select>
            </Label>
          </div>

          <Label text="Risk reason">
            <input
              className={inputCls}
              value={riskReason}
              onChange={(e) => setRiskReason(e.target.value)}
              placeholder="What an advisor should act on — e.g. missed 4 of the last 6 sessions"
            />
          </Label>

          <div className="grid grid-cols-2 gap-4">
            <Label text="Staffing eligibility">
              <select
                className={inputCls}
                value={eligibility}
                onChange={(e) => setEligibility(e.target.value as StaffingEligibility)}
              >
                {ELIGIBILITY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Label>
            <Label text="Staffing consent">
              <select
                className={inputCls}
                value={consent}
                onChange={(e) => setConsent(e.target.value as StaffingConsent)}
              >
                {CONSENT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Label>
          </div>

          {willRevoke && (
            <p className="rounded-[10px] border border-state-warn/30 bg-state-warn/8 px-3 py-2 text-[12.5px] leading-[1.5] text-ink2">
              <b className="font-semibold text-ink">This removes them from staffing.</b>{" "}
              They have a candidate profile, so they will disappear from the eligible list and
              from any &ldquo;put a candidate forward&rdquo; picker immediately — including on
              requisitions where their application is already open. Existing applications are not
              deleted; they simply cannot be advanced to a new role.
            </p>
          )}

          {error && (
            <p className="rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => { setEditing(false); setError(null); }}
              className="btn"
            >
              Cancel
            </button>
            <button type="button" onClick={save} disabled={busy} className="btn-grad disabled:opacity-60">
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function labelOf<T extends string>(opts: Array<{ value: T; label: string }>, v: T): string {
  return opts.find((o) => o.value === v)?.label ?? v;
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mono-cap mb-1.5 text-[9.5px] font-semibold tracking-[.1em] text-mute">{label}</div>
      {children}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-mute">{label}: </span>
      <b className="font-semibold text-ink">{value}</b>
    </span>
  );
}

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">{text}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 text-[13.5px] text-ink " +
  "placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20";
