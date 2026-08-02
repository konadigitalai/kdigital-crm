"use client";

// Candidates — learners with a recruiting profile.
//
// The important thing this screen has to communicate is WHY somebody is or is
// not offerable, because "eligible" is not one fact. It is three, owned in two
// places:
//
//   learner_profile.staffing_eligibility_status   qualified?
//   learner_profile.staffing_consent_status       consented?
//   candidate.profile_status                      profile ready?
//
// The first two live on the learner deliberately: withdrawing consent must
// remove someone from staffing however many applications are open. So the
// gate is rendered as its parts, not as a single green tick — a recruiter
// looking at an ineligible candidate needs to know which door is shut.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { updateCandidate } from "@/lib/api";
import type { Candidate, CandidateInput, CandidateStatus } from "@/lib/types";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField } from "@/components/filter/types";
import {
  DialogShell, EmptyRow, ErrorNote, Field, GridRow, Pill, TagInput,
  formatMoney, formatMonths, humanise, inputCls,
} from "@/components/admin/formKit";

const COLS = "2fr 1.4fr 130px 200px 120px 110px 130px";

const STATUSES: CandidateStatus[] = ["draft", "ready", "active", "placed", "withdrawn"];

const STATUS_TONE: Record<CandidateStatus, "good" | "warn" | "info" | "neutral"> = {
  draft: "neutral",
  ready: "good",
  active: "good",
  placed: "info",
  withdrawn: "warn",
};

function buildFields(): FilterField[] {
  return [
    { key: "name",   label: "Name",   type: "text", get: (c: Candidate) => c.name },
    { key: "number", label: "Number", type: "text", get: (c: Candidate) => c.number },
    { key: "status", label: "Profile status", type: "enum", options: STATUSES.map((s) => ({ value: s, label: humanise(s) })), get: (c: Candidate) => c.profileStatus },
    { key: "eligible", label: "Eligible", type: "boolean", get: (c: Candidate) => c.eligible },
    { key: "experience", label: "Experience (months)", type: "number", get: (c: Candidate) => c.totalExperienceMonths },
    { key: "notice", label: "Notice (days)", type: "number", get: (c: Candidate) => c.noticePeriodDays },
    { key: "employer", label: "Current employer", type: "text", get: (c: Candidate) => c.currentEmployer },
    { key: "openApplications", label: "Open applications", type: "number", get: (c: Candidate) => c.openApplicationCount },
  ];
}

export function CandidatesTable({ initial }: { initial: Candidate[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<Candidate[]>(initial);
  const [editing, setEditing] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields = useMemo(() => buildFields(), []);
  const [filtered, filterState, setFilterState] = useFilter(rows, fields);

  async function onSubmit(c: Candidate, input: CandidateInput) {
    setBusy(c.partyId); setError(null);
    try {
      const updated = await updateCandidate(c.partyId, input);
      setRows((all) => all.map((x) => (x.partyId === updated.partyId ? updated : x)));
      setEditing(null);
      router.refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  const eligible = rows.filter((c) => c.eligible).length;
  const blockedOnConsent = rows.filter(
    (c) => c.eligibilityStatus === "qualified" && c.consentStatus !== "granted",
  ).length;

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[13px] text-mute">
          {rows.length} candidate{rows.length === 1 ? "" : "s"}
          {" · "}{eligible} offerable
          {blockedOnConsent > 0 && (
            <> · <span className="text-state-warn">{blockedOnConsent} qualified but not consented</span></>
          )}
        </div>
      </div>

      <div className="mb-4 rounded-[14px] border border-rule bg-paper p-3">
        <FilterBar
          fields={fields}
          state={filterState}
          onChange={setFilterState}
          placeholder="Filter candidates by field…"
          totalRows={rows.length}
          filteredRows={filtered.length}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <GridRow cols={COLS} hdr>
          <div>Candidate</div>
          <div>Current role</div>
          <div>Experience</div>
          <div>Eligibility</div>
          <div className="text-right">Expected CTC</div>
          <div className="text-center">Open apps</div>
          <div className="text-right">Actions</div>
        </GridRow>

        {filtered.length === 0 ? (
          <EmptyRow>
            {rows.length === 0
              ? "No candidate profiles yet. A candidate is created from a learner once they are ready for placement."
              : "No candidates match the current filter."}
          </EmptyRow>
        ) : filtered.map((c) => (
          <GridRow key={c.partyId} cols={COLS} dimmed={c.profileStatus === "withdrawn"}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/learners/${c.partyId}`}
                  className="text-[14px] font-semibold tracking-[-.005em] hover:text-brand-violet"
                >
                  {c.name}
                </Link>
                <span className="font-mono text-[10.5px] text-hint">{c.number}</span>
                <Pill tone={STATUS_TONE[c.profileStatus]}>{humanise(c.profileStatus)}</Pill>
              </div>
              <div className="mt-0.5 truncate text-[11.5px] text-mute">
                {c.skills.length > 0 ? c.skills.join(", ") : "no skills recorded"}
              </div>
            </div>

            <div className="min-w-0 text-[13px] text-ink2">
              <div className="truncate">{c.currentDesignation ?? <span className="text-mute">—</span>}</div>
              {c.currentEmployer && (
                <div className="mt-0.5 truncate text-[11.5px] text-mute">{c.currentEmployer}</div>
              )}
            </div>

            <div className="text-[12.5px] text-ink2">
              {formatMonths(c.totalExperienceMonths)}
              {c.noticePeriodDays != null && (
                <div className="mt-0.5 text-[11px] text-mute">{c.noticePeriodDays}d notice</div>
              )}
            </div>

            <EligibilityCell candidate={c} />

            <div className="text-right font-mono text-[12.5px] text-ink2">
              {formatMoney(c.expectedCtc, c.currency)}
              {c.currentCtc && (
                <div className="text-[10.5px] text-mute">from {formatMoney(c.currentCtc, c.currency)}</div>
              )}
            </div>

            <div className="text-center text-[13px]">
              {c.openApplicationCount > 0 ? c.openApplicationCount : <span className="text-mute">—</span>}
            </div>

            <div className="flex items-center justify-end gap-1.5">
              <button
                onClick={() => setEditing(c)}
                className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
              >
                Edit
              </button>
            </div>
          </GridRow>
        ))}
      </div>

      <ErrorNote message={error} />

      {editing && (
        <CandidateFormDialog
          candidate={editing}
          onClose={() => setEditing(null)}
          onSubmit={(input) => onSubmit(editing, input)}
          busy={busy === editing.partyId}
        />
      )}
    </>
  );
}

/** The gate, rendered as its parts. A single "eligible / not eligible" badge
 *  would be true and useless — the recruiter's next action depends entirely on
 *  WHICH of the three conditions is unmet, and two of them are not theirs to
 *  fix (consent is the learner's; qualification is the academy's). */
function EligibilityCell({ candidate: c }: { candidate: Candidate }) {
  if (c.eligible) {
    return (
      <div className="flex items-center gap-1.5">
        <Pill tone="good">
          <Icon name="check" size={9} strokeWidth={3} /> offerable
        </Pill>
      </div>
    );
  }

  const blockers: string[] = [];
  if (c.eligibilityStatus !== "qualified") {
    blockers.push(c.eligibilityStatus === "not_qualified" ? "not qualified" : "not assessed");
  }
  if (c.consentStatus !== "granted") {
    blockers.push(
      c.consentStatus === "withdrawn" ? "consent withdrawn"
      : c.consentStatus === "withheld" ? "consent withheld"
      : "consent not asked",
    );
  }
  if (!["ready", "active"].includes(c.profileStatus)) {
    blockers.push(`profile ${c.profileStatus}`);
  }

  return (
    <div className="flex flex-wrap gap-1">
      {blockers.map((b) => (
        <Pill
          key={b}
          tone={b.startsWith("consent") ? "warn" : "neutral"}
          title="All three must hold before this person can be put forward"
        >
          {b}
        </Pill>
      ))}
    </div>
  );
}

function CandidateFormDialog({
  candidate, onClose, onSubmit, busy,
}: {
  candidate: Candidate; onClose: () => void;
  onSubmit: (input: CandidateInput) => void; busy: boolean;
}) {
  const [profileStatus, setProfileStatus] = useState<CandidateStatus>(candidate.profileStatus);
  const [totalExperienceMonths, setExp] = useState(candidate.totalExperienceMonths?.toString() ?? "");
  const [currentEmployer, setEmployer] = useState(candidate.currentEmployer ?? "");
  const [currentDesignation, setDesignation] = useState(candidate.currentDesignation ?? "");
  const [currentCtc, setCurrentCtc] = useState(candidate.currentCtc ?? "");
  const [expectedCtc, setExpectedCtc] = useState(candidate.expectedCtc ?? "");
  const [noticePeriodDays, setNotice] = useState(candidate.noticePeriodDays?.toString() ?? "");
  const [skills, setSkills] = useState<string[]>(candidate.skills);
  const [certifications, setCertifications] = useState<string[]>(candidate.certifications);
  const [highestQualification, setQualification] = useState(candidate.highestQualification ?? "");
  const [portfolioUrl, setPortfolio] = useState(candidate.portfolioUrl ?? "");
  const [workHistorySummary, setSummary] = useState(candidate.workHistorySummary ?? "");

  return (
    <DialogShell
      title={candidate.name}
      wide
      subtitle="The recruiting profile. Qualification and staffing consent are properties of the learner and are changed on their learner record, not here."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({
            profileStatus,
            totalExperienceMonths: totalExperienceMonths.trim() ? Number(totalExperienceMonths) : null,
            currentEmployer: currentEmployer.trim() || null,
            currentDesignation: currentDesignation.trim() || null,
            currentCtc: String(currentCtc).trim() || null,
            expectedCtc: String(expectedCtc).trim() || null,
            noticePeriodDays: noticePeriodDays.trim() ? Number(noticePeriodDays) : null,
            skills,
            certifications,
            highestQualification: highestQualification.trim() || null,
            portfolioUrl: portfolioUrl.trim() || null,
            workHistorySummary: workHistorySummary.trim() || null,
          });
        }}
        className="space-y-4"
      >
        {!candidate.eligible && (
          <div className="rounded-[10px] border border-state-warn/30 bg-state-warn/8 px-3 py-2.5 text-[12.5px] text-ink2">
            <b className="font-semibold text-ink">Not currently offerable.</b>{" "}
            {candidate.eligibilityStatus !== "qualified" && "They are not marked qualified. "}
            {candidate.consentStatus !== "granted" && "Staffing consent has not been granted. "}
            Both are set on the learner record —{" "}
            <Link href={`/learners/${candidate.partyId}`} className="font-semibold text-brand-violet hover:underline">
              open it
            </Link>.
          </div>
        )}

        <div className="grid grid-cols-3 gap-4">
          <Field label="Profile status" hint="Ready or active is required before they can be put forward.">
            <select className={inputCls} value={profileStatus} onChange={(e) => setProfileStatus(e.target.value as CandidateStatus)}>
              {STATUSES.map((s) => <option key={s} value={s}>{humanise(s)}</option>)}
            </select>
          </Field>
          <Field label="Total experience (months)">
            <input className={inputCls} value={totalExperienceMonths} onChange={(e) => setExp(e.target.value)} inputMode="numeric" placeholder="0 for a fresher" />
          </Field>
          <Field label="Notice period (days)">
            <input className={inputCls} value={noticePeriodDays} onChange={(e) => setNotice(e.target.value)} inputMode="numeric" />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Current employer">
            <input className={inputCls} value={currentEmployer} onChange={(e) => setEmployer(e.target.value)} />
          </Field>
          <Field label="Current designation">
            <input className={inputCls} value={currentDesignation} onChange={(e) => setDesignation(e.target.value)} />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Current CTC (₹)">
            <input className={inputCls} value={currentCtc ?? ""} onChange={(e) => setCurrentCtc(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Expected CTC (₹)">
            <input className={inputCls} value={expectedCtc ?? ""} onChange={(e) => setExpectedCtc(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Highest qualification">
            <input className={inputCls} value={highestQualification} onChange={(e) => setQualification(e.target.value)} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Skills">
            <TagInput value={skills} onChange={setSkills} />
          </Field>
          <Field label="Certifications">
            <TagInput value={certifications} onChange={setCertifications} />
          </Field>
        </div>

        <Field label="Portfolio URL">
          <input className={inputCls} value={portfolioUrl} onChange={(e) => setPortfolio(e.target.value)} placeholder="https://" />
        </Field>

        <Field label="Work history summary">
          <textarea
            className={`${inputCls} min-h-[80px] resize-y`}
            value={workHistorySummary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </Field>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
