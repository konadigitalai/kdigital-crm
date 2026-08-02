"use client";

// Applications — the join between a candidate and a role.
//
// Two rules are enforced in SQL and mirrored here so the UI never offers an
// action the server will refuse:
//
//   A rejection needs a reason. The dialog will not submit without one, and
//   the DB CHECK refuses it anyway — belt and braces, because a pipeline of
//   reasonless rejections cannot be reviewed later.
//
//   Hiring, rejecting and withdrawing need staffing.decide, not staffing.write.
//   Those three stages are gated at the router. A coordinator can shortlist
//   and schedule interviews all day without being able to end someone's
//   candidacy.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { updateApplication } from "@/lib/api";
import type {
  ApplicationInput, ApplicationStage, InterviewStatus, JobApplication, OfferStatus,
} from "@/lib/types";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField } from "@/components/filter/types";
import {
  DialogShell, EmptyRow, ErrorNote, Field, GridRow, Pill,
  distinct, humanise, inputCls,
} from "@/components/admin/formKit";

const COLS = "1.8fr 1.8fr 150px 110px 150px 130px";

const STAGES: ApplicationStage[] = [
  "applied", "screening", "shortlisted", "interviewing", "offered", "hired", "rejected", "withdrawn",
];
// Stages the server gates on staffing.decide. Kept in one place so the dialog
// can warn before the request rather than after the 403.
const DECIDING_STAGES: ApplicationStage[] = ["hired", "rejected", "withdrawn"];

const INTERVIEW: InterviewStatus[] = ["not_scheduled", "scheduled", "completed", "no_show", "cancelled"];
const OFFERS: OfferStatus[] = ["none", "extended", "accepted", "declined", "withdrawn"];

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

function buildFields(rows: JobApplication[]): FilterField[] {
  const accounts = distinct(rows, (a) => a.accountName);
  const roles = distinct(rows, (a) => a.jobTitle);
  return [
    { key: "candidate", label: "Candidate", type: "text", get: (a: JobApplication) => a.candidateName },
    { key: "number",    label: "Number",    type: "text", get: (a: JobApplication) => a.number },
    { key: "role",      label: "Role",      type: "enum", options: roles.map((r) => ({ value: r, label: r })), get: (a: JobApplication) => a.jobTitle },
    { key: "account",   label: "Account",   type: "enum", options: accounts.map((x) => ({ value: x, label: x })), get: (a: JobApplication) => a.accountName },
    { key: "stage",     label: "Stage",     type: "enum", options: STAGES.map((s) => ({ value: s, label: humanise(s) })), get: (a: JobApplication) => a.stage },
    { key: "score",     label: "Screening score", type: "number", get: (a: JobApplication) => a.screeningScore },
    { key: "status",    label: "Open",      type: "boolean", get: (a: JobApplication) => a.status === "open" },
    { key: "review",    label: "Awaiting human review", type: "boolean", get: (a: JobApplication) => a.humanReviewStatus === "pending" },
  ];
}

export function ApplicationsTable({ initial }: { initial: JobApplication[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<JobApplication[]>(initial);
  const [editing, setEditing] = useState<JobApplication | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields = useMemo(() => buildFields(rows), [rows]);
  const [filtered, filterState, setFilterState] = useFilter(rows, fields);

  async function onSubmit(a: JobApplication, input: ApplicationInput) {
    setBusy(a.id); setError(null);
    try {
      const updated = await updateApplication(a.id, input);
      setRows((all) => all.map((x) => (x.id === updated.id ? updated : x)));
      setEditing(null);
      router.refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  const open = rows.filter((a) => a.status === "open").length;
  const awaitingReview = rows.filter((a) => a.humanReviewStatus === "pending").length;

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[13px] text-mute">
          {rows.length} application{rows.length === 1 ? "" : "s"} · {open} open
          {awaitingReview > 0 && (
            <> · <span className="text-state-warn">{awaitingReview} awaiting human review</span></>
          )}
        </div>
      </div>

      {awaitingReview > 0 && (
        <div className="mb-4 rounded-[14px] border border-state-warn/30 bg-state-warn/8 px-[18px] py-3 text-[13px] text-ink2">
          <b className="font-bold text-ink">
            {awaitingReview} application{awaitingReview === 1 ? " was" : "s were"} scored automatically.
          </b>{" "}
          A machine screen has to be signed off by a person before it can reject anyone. Open one and set
          human review to approved or rejected.
        </div>
      )}

      <div className="mb-4 rounded-[14px] border border-rule bg-paper p-3">
        <FilterBar
          fields={fields}
          state={filterState}
          onChange={setFilterState}
          placeholder="Filter applications by field…"
          totalRows={rows.length}
          filteredRows={filtered.length}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <GridRow cols={COLS} hdr>
          <div>Candidate</div>
          <div>Role</div>
          <div>Stage</div>
          <div className="text-center">Score</div>
          <div>Interview / offer</div>
          <div className="text-right">Actions</div>
        </GridRow>

        {filtered.length === 0 ? (
          <EmptyRow>
            {rows.length === 0
              ? "No applications yet. Put an eligible candidate forward from an open requisition."
              : "No applications match the current filter."}
          </EmptyRow>
        ) : filtered.map((a) => (
          <GridRow key={a.id} cols={COLS} dimmed={a.status === "closed"}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/learners/${a.candidatePartyId}`}
                  className="text-[14px] font-semibold tracking-[-.005em] hover:text-brand-violet"
                >
                  {a.candidateName}
                </Link>
                <span className="font-mono text-[10.5px] text-hint">{a.candidateNumber}</span>
              </div>
              <div className="mt-0.5 font-mono text-[10.5px] text-hint">{a.number}</div>
            </div>

            <div className="min-w-0 text-[13px] text-ink2">
              <Link href={`/staffing/requisitions/${a.requisitionId}`} className="truncate hover:text-brand-violet">
                {a.jobTitle}
              </Link>
              <div className="mt-0.5 truncate text-[11.5px] text-mute">{a.accountName}</div>
            </div>

            <div>
              <Pill tone={STAGE_TONE[a.stage]}>{humanise(a.stage)}</Pill>
              {a.stage === "rejected" && a.rejectionReason && (
                <div className="mt-1 line-clamp-2 text-[11px] text-mute" title={a.rejectionReason}>
                  {a.rejectionReason}
                </div>
              )}
            </div>

            <div className="text-center">
              {a.screeningScore == null
                ? <span className="text-mute">—</span>
                : (
                  <>
                    <span className="font-mono text-[13px]">{a.screeningScore}</span>
                    {a.humanReviewStatus === "pending" && (
                      <div className="mt-1"><Pill tone="warn">review</Pill></div>
                    )}
                  </>
                )}
            </div>

            <div className="text-[12px] text-ink2">
              {a.interviewStatus && <div>{humanise(a.interviewStatus)}</div>}
              {a.offerStatus && a.offerStatus !== "none" && (
                <div className="mt-0.5 text-mute">Offer · {humanise(a.offerStatus)}</div>
              )}
              {!a.interviewStatus && (!a.offerStatus || a.offerStatus === "none") && (
                <span className="text-mute">—</span>
              )}
            </div>

            <div className="flex items-center justify-end gap-1.5">
              <button
                onClick={() => setEditing(a)}
                className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
              >
                Advance
              </button>
            </div>
          </GridRow>
        ))}
      </div>

      <ErrorNote message={error} />

      {editing && (
        <ApplicationDialog
          application={editing}
          onClose={() => setEditing(null)}
          onSubmit={(input) => onSubmit(editing, input)}
          busy={busy === editing.id}
        />
      )}
    </>
  );
}

function ApplicationDialog({
  application: a, onClose, onSubmit, busy,
}: {
  application: JobApplication; onClose: () => void;
  onSubmit: (input: ApplicationInput) => void; busy: boolean;
}) {
  const [stage, setStage] = useState<ApplicationStage>(a.stage);
  const [rejectionReason, setRejectionReason] = useState(a.rejectionReason ?? "");
  const [interviewStatus, setInterviewStatus] = useState<InterviewStatus | "">(a.interviewStatus ?? "");
  const [offerStatus, setOfferStatus] = useState<OfferStatus | "">(a.offerStatus ?? "");
  const [humanReviewStatus, setHumanReview] = useState(a.humanReviewStatus);
  const [screeningScore, setScore] = useState(a.screeningScore?.toString() ?? "");

  const rejecting = stage === "rejected";
  const deciding = DECIDING_STAGES.includes(stage) && stage !== a.stage;
  const canSubmit = !rejecting || rejectionReason.trim().length > 0;

  return (
    <DialogShell
      title={a.candidateName}
      wide
      subtitle={`${a.jobTitle} at ${a.accountName} · ${a.number}`}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          onSubmit({
            stage,
            rejectionReason: rejecting ? rejectionReason.trim() : null,
            interviewStatus: interviewStatus || null,
            offerStatus: offerStatus || null,
            humanReviewStatus,
            screeningScore: screeningScore.trim() ? Number(screeningScore) : null,
          });
        }}
        className="space-y-4"
      >
        {deciding && (
          <div className="rounded-[10px] border border-brand-violet/30 bg-grad-soft px-3 py-2.5 text-[12.5px] text-ink2">
            <b className="font-semibold text-ink">This ends the application.</b>{" "}
            Hiring, rejecting and withdrawing are separately permissioned — if you do not have the
            staffing decision permission this will be refused.
            {stage === "hired" && " Marking hired also records the placement on their learner record."}
          </div>
        )}

        <div className="grid grid-cols-3 gap-4">
          <Field label="Stage">
            <select className={inputCls} value={stage} onChange={(e) => setStage(e.target.value as ApplicationStage)}>
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {humanise(s)}{DECIDING_STAGES.includes(s) ? " ·  final" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Interview">
            <select className={inputCls} value={interviewStatus} onChange={(e) => setInterviewStatus(e.target.value as InterviewStatus | "")}>
              <option value="">—</option>
              {INTERVIEW.map((s) => <option key={s} value={s}>{humanise(s)}</option>)}
            </select>
          </Field>
          <Field label="Offer">
            <select className={inputCls} value={offerStatus} onChange={(e) => setOfferStatus(e.target.value as OfferStatus | "")}>
              <option value="">—</option>
              {OFFERS.map((s) => <option key={s} value={s}>{humanise(s)}</option>)}
            </select>
          </Field>
        </div>

        {rejecting && (
          <Field
            label="Rejection reason"
            required
            hint="Required. A pipeline of reasonless rejections cannot be reviewed, and a candidate who asks deserves an answer."
          >
            <textarea
              className={`${inputCls} min-h-[70px] resize-y`}
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              autoFocus
              placeholder="e.g. Needs more production experience with agent frameworks"
            />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-4">
          <Field label="Screening score" hint="0–100.">
            <input className={inputCls} value={screeningScore} onChange={(e) => setScore(e.target.value)} inputMode="numeric" />
          </Field>
          <Field
            label="Human review"
            hint={a.humanReviewStatus === "pending" ? "This was scored automatically and needs a person to sign it off." : undefined}
          >
            <select
              className={inputCls}
              value={humanReviewStatus}
              onChange={(e) => setHumanReview(e.target.value as typeof humanReviewStatus)}
            >
              <option value="not_required">Not required</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </Field>
        </div>

        {Object.keys(a.screeningFactors ?? {}).length > 0 && (
          <div>
            <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">
              Screening evidence
            </span>
            <pre className="max-h-[160px] overflow-auto rounded-[10px] border border-rule bg-warm/40 p-3 text-[11.5px] leading-[1.6] text-ink2">
              {JSON.stringify(a.screeningFactors, null, 2)}
            </pre>
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="submit" disabled={busy || !canSubmit} className="btn-grad disabled:opacity-60">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
