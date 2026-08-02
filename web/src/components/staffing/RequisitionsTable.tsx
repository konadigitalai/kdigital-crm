"use client";

// Open roles at hiring-partner accounts.
//
// The one number worth designing around is `openSeats` — openings minus
// people already hired. A requisition for 3 with 2 hired is not "3 openings"
// and it is not closed either, and every recruiter has to know which.
// It is computed server-side so the list and the detail agree.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { createRequisition, updateRequisition } from "@/lib/api";
import type {
  Account, EmploymentType, Requisition, RequisitionInput, RequisitionStatus, WorkMode, Worker,
} from "@/lib/types";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField } from "@/components/filter/types";
import {
  DialogShell, EmptyRow, ErrorNote, Field, GridRow, Pill, TagInput,
  distinct, formatMoney, formatMonths, humanise, inputCls,
} from "@/components/admin/formKit";

const COLS = "2.2fr 1.3fr 130px 120px 140px 130px 150px";

const STATUSES: RequisitionStatus[] = ["draft", "open", "on_hold", "filled", "cancelled", "closed"];
const WORK_MODES: WorkMode[] = ["onsite", "remote", "hybrid"];
const EMPLOYMENT: EmploymentType[] = ["full_time", "part_time", "contract", "intern"];

const STATUS_TONE: Record<RequisitionStatus, "good" | "warn" | "bad" | "neutral" | "info"> = {
  draft: "neutral",
  open: "good",
  on_hold: "warn",
  filled: "info",
  cancelled: "bad",
  closed: "neutral",
};

function buildFields(rows: Requisition[]): FilterField[] {
  const accounts = distinct(rows, (r) => r.accountName);
  const departments = distinct(rows, (r) => r.department);
  return [
    { key: "jobTitle", label: "Role",     type: "text", get: (r: Requisition) => r.jobTitle },
    { key: "number",   label: "Number",   type: "text", get: (r: Requisition) => r.number },
    { key: "account",  label: "Account",  type: "enum", options: accounts.map((a) => ({ value: a, label: a })), get: (r: Requisition) => r.accountName },
    { key: "department", label: "Department", type: "enum", options: departments.map((d) => ({ value: d, label: d })), get: (r: Requisition) => r.department },
    { key: "status",   label: "Status",   type: "enum", options: STATUSES.map((s) => ({ value: s, label: humanise(s) })), get: (r: Requisition) => r.status },
    { key: "workMode", label: "Work mode", type: "enum", options: WORK_MODES.map((m) => ({ value: m, label: humanise(m) })), get: (r: Requisition) => r.workMode },
    { key: "openSeats", label: "Seats left", type: "number", get: (r: Requisition) => r.openSeats },
    { key: "applicationCount", label: "Applicants", type: "number", get: (r: Requisition) => r.applicationCount },
    { key: "recruiter", label: "Recruiter", type: "text", get: (r: Requisition) => r.recruiterName },
    { key: "budgetApproved", label: "Budget approved", type: "boolean", get: (r: Requisition) => r.budgetApproved },
  ];
}

type Mode = { kind: "idle" } | { kind: "creating" } | { kind: "editing"; requisition: Requisition };

export function RequisitionsTable({
  initial, accounts, recruiters,
}: {
  initial: Requisition[]; accounts: Account[]; recruiters: Worker[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Requisition[]>(initial);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields = useMemo(() => buildFields(rows), [rows]);
  const [filtered, filterState, setFilterState] = useFilter(rows, fields);

  // Only hiring partners and clients can have roles raised against them.
  const eligibleAccounts = accounts.filter(
    (a) => a.status === "active" && (a.accountType === "hiring_partner" || a.accountType === "client"),
  );

  async function onSubmit(input: RequisitionInput) {
    setBusy("form"); setError(null);
    try {
      if (mode.kind === "editing") {
        const updated = await updateRequisition(mode.requisition.id, input);
        setRows((all) => all.map((x) => (x.id === updated.id ? updated : x)));
      } else {
        const created = await createRequisition(input);
        setRows((all) => [created, ...all]);
      }
      setMode({ kind: "idle" });
      router.refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  const totalSeats = rows.filter((r) => r.status === "open").reduce((s, r) => s + r.openSeats, 0);

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[13px] text-mute">
          {rows.length} requisition{rows.length === 1 ? "" : "s"}
          {" · "}{rows.filter((r) => r.status === "open").length} open
          {totalSeats > 0 && <> · {totalSeats} seat{totalSeats === 1 ? "" : "s"} to fill</>}
        </div>
        <button
          onClick={() => setMode({ kind: "creating" })}
          disabled={eligibleAccounts.length === 0}
          title={eligibleAccounts.length === 0 ? "Mark an account as a hiring partner first" : undefined}
          className="btn-grad disabled:opacity-50"
        >
          <Icon name="plus" size={14} strokeWidth={2.2} /> New requisition
        </button>
      </div>

      <div className="mb-4 rounded-[14px] border border-rule bg-paper p-3">
        <FilterBar
          fields={fields}
          state={filterState}
          onChange={setFilterState}
          placeholder="Filter roles by field…"
          totalRows={rows.length}
          filteredRows={filtered.length}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <GridRow cols={COLS} hdr>
          <div>Role</div>
          <div>Account</div>
          <div>Experience</div>
          <div className="text-center">Seats left</div>
          <div className="text-right">Salary range</div>
          <div className="text-center">Applicants</div>
          <div className="text-right">Actions</div>
        </GridRow>

        {filtered.length === 0 ? (
          <EmptyRow>
            {rows.length === 0
              ? "No roles yet — raise one against a hiring-partner account."
              : "No roles match the current filter."}
          </EmptyRow>
        ) : filtered.map((r) => (
          <GridRow key={r.id} cols={COLS} dimmed={["cancelled", "closed"].includes(r.status)}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-semibold tracking-[-.005em]">{r.jobTitle}</span>
                <span className="font-mono text-[10.5px] text-hint">{r.number}</span>
                <Pill tone={STATUS_TONE[r.status]}>{humanise(r.status)}</Pill>
                {r.approvalStatus === "pending" && <Pill tone="warn">approval pending</Pill>}
              </div>
              <div className="mt-0.5 truncate text-[11.5px] text-mute">
                {[r.department, r.workMode && humanise(r.workMode), r.workLocation]
                  .filter(Boolean).join(" · ") || "—"}
              </div>
            </div>

            <div className="min-w-0 text-[13px] text-ink2">
              <div className="truncate">{r.accountName}</div>
              {r.recruiterName && (
                <div className="mt-0.5 truncate text-[11.5px] text-mute">Recruiter · {r.recruiterName}</div>
              )}
            </div>

            <div className="text-[12.5px] text-ink2">
              {r.minimumExperienceMonths == null && r.maximumExperienceMonths == null
                ? <span className="text-mute">—</span>
                : `${formatMonths(r.minimumExperienceMonths ?? 0)} – ${formatMonths(r.maximumExperienceMonths) }`}
            </div>

            <div className="text-center">
              {r.openSeats > 0
                ? (
                  <span className="text-[13px] font-semibold">
                    {r.openSeats}
                    {r.hiredCount > 0 && <span className="ml-1 text-[11px] font-normal text-mute">of {r.openings}</span>}
                  </span>
                )
                : <Pill tone="info">all filled</Pill>}
            </div>

            <div className="text-right font-mono text-[12.5px] text-ink2">
              {r.salaryMin || r.salaryMax
                ? `${formatMoney(r.salaryMin, r.currency)} – ${formatMoney(r.salaryMax, r.currency)}`
                : <span className="text-mute">—</span>}
              {!r.budgetApproved && (r.salaryMin || r.salaryMax) && (
                <div className="text-[10.5px] font-sans text-state-warn">budget not approved</div>
              )}
            </div>

            <div className="text-center text-[13px]">
              {r.applicationCount > 0
                ? (
                  <Link href={`/staffing/requisitions/${r.id}`} className="font-semibold hover:text-brand-violet">
                    {r.applicationCount}
                  </Link>
                )
                : <span className="text-mute">—</span>}
            </div>

            <div className="flex items-center justify-end gap-1.5">
              <Link
                href={`/staffing/requisitions/${r.id}`}
                className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
              >
                Open
              </Link>
              <button
                onClick={() => setMode({ kind: "editing", requisition: r })}
                className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
              >
                Edit
              </button>
            </div>
          </GridRow>
        ))}
      </div>

      <ErrorNote message={error} />

      {mode.kind !== "idle" && (
        <RequisitionFormDialog
          accounts={eligibleAccounts}
          recruiters={recruiters}
          initial={mode.kind === "editing" ? mode.requisition : undefined}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={onSubmit}
          busy={busy === "form"}
        />
      )}
    </>
  );
}

function RequisitionFormDialog({
  accounts, recruiters, initial, onClose, onSubmit, busy,
}: {
  accounts: Account[]; recruiters: Worker[]; initial?: Requisition;
  onClose: () => void; onSubmit: (input: RequisitionInput) => void; busy: boolean;
}) {
  const [accountPartyId, setAccountPartyId] = useState(initial?.accountPartyId ?? accounts[0]?.partyId ?? "");
  const [jobTitle, setJobTitle] = useState(initial?.jobTitle ?? "");
  const [department, setDepartment] = useState(initial?.department ?? "");
  const [openings, setOpenings] = useState(String(initial?.openings ?? 1));
  const [status, setStatus] = useState<RequisitionStatus>(initial?.status ?? "draft");
  const [employmentType, setEmploymentType] = useState<EmploymentType | "">(initial?.employmentType ?? "");
  const [workMode, setWorkMode] = useState<WorkMode | "">(initial?.workMode ?? "");
  const [workLocation, setWorkLocation] = useState(initial?.workLocation ?? "");
  const [minExp, setMinExp] = useState(initial?.minimumExperienceMonths?.toString() ?? "");
  const [maxExp, setMaxExp] = useState(initial?.maximumExperienceMonths?.toString() ?? "");
  const [salaryMin, setSalaryMin] = useState(initial?.salaryMin ?? "");
  const [salaryMax, setSalaryMax] = useState(initial?.salaryMax ?? "");
  const [budgetApproved, setBudgetApproved] = useState(initial?.budgetApproved ?? false);
  const [requiredSkills, setRequiredSkills] = useState<string[]>(initial?.requiredSkills ?? []);
  const [preferredSkills, setPreferredSkills] = useState<string[]>(initial?.preferredSkills ?? []);
  const [recruiterPartyId, setRecruiterPartyId] = useState(initial?.recruiterPartyId ?? "");
  const [targetCloseDate, setTargetCloseDate] = useState(initial?.targetCloseDate ?? "");
  const [jobDescription, setJobDescription] = useState(initial?.jobDescription ?? "");

  return (
    <DialogShell
      title={initial ? initial.jobTitle : "New requisition"}
      wide
      subtitle="A role at a hiring-partner account. Experience is captured in months so that sub-year ranges — where a six-month-pathway graduate sits — are expressible."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!jobTitle.trim() || !accountPartyId) return;
          onSubmit({
            accountPartyId,
            jobTitle: jobTitle.trim(),
            department: department.trim() || null,
            openings: Number(openings) || 1,
            status,
            employmentType: employmentType || null,
            workMode: workMode || null,
            workLocation: workLocation.trim() || null,
            minimumExperienceMonths: minExp.trim() ? Number(minExp) : null,
            maximumExperienceMonths: maxExp.trim() ? Number(maxExp) : null,
            salaryMin: String(salaryMin).trim() || null,
            salaryMax: String(salaryMax).trim() || null,
            budgetApproved,
            requiredSkills,
            preferredSkills,
            recruiterPartyId: recruiterPartyId || null,
            targetCloseDate: targetCloseDate || null,
            jobDescription: jobDescription.trim() || null,
          });
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-3 gap-4">
          <Field label="Job title" required>
            <input className={inputCls} value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} autoFocus placeholder="e.g. Agentic AI Engineer" />
          </Field>
          <Field label="Account" required>
            <select className={inputCls} value={accountPartyId} onChange={(e) => setAccountPartyId(e.target.value)}>
              {accounts.length === 0 && <option value="">— No hiring partners —</option>}
              {accounts.map((a) => <option key={a.partyId} value={a.partyId}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Department">
            <input className={inputCls} value={department} onChange={(e) => setDepartment(e.target.value)} />
          </Field>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <Field label="Openings">
            <input className={inputCls} value={openings} onChange={(e) => setOpenings(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Status" hint={status === "open" ? "Candidates can be put forward." : "Only open roles accept applications."}>
            <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as RequisitionStatus)}>
              {STATUSES.map((s) => <option key={s} value={s}>{humanise(s)}</option>)}
            </select>
          </Field>
          <Field label="Employment">
            <select className={inputCls} value={employmentType} onChange={(e) => setEmploymentType(e.target.value as EmploymentType | "")}>
              <option value="">—</option>
              {EMPLOYMENT.map((t) => <option key={t} value={t}>{humanise(t)}</option>)}
            </select>
          </Field>
          <Field label="Work mode">
            <select className={inputCls} value={workMode} onChange={(e) => setWorkMode(e.target.value as WorkMode | "")}>
              <option value="">—</option>
              {WORK_MODES.map((m) => <option key={m} value={m}>{humanise(m)}</option>)}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <Field label="Min experience (months)" hint="0 for freshers.">
            <input className={inputCls} value={minExp} onChange={(e) => setMinExp(e.target.value)} inputMode="numeric" placeholder="e.g. 0" />
          </Field>
          <Field label="Max experience (months)">
            <input className={inputCls} value={maxExp} onChange={(e) => setMaxExp(e.target.value)} inputMode="numeric" placeholder="e.g. 36" />
          </Field>
          <Field label="Salary min (₹)">
            <input className={inputCls} value={salaryMin ?? ""} onChange={(e) => setSalaryMin(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Salary max (₹)">
            <input className={inputCls} value={salaryMax ?? ""} onChange={(e) => setSalaryMax(e.target.value)} inputMode="numeric" />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Required skills">
            <TagInput value={requiredSkills} onChange={setRequiredSkills} placeholder="Python, LangGraph…" />
          </Field>
          <Field label="Preferred skills">
            <TagInput value={preferredSkills} onChange={setPreferredSkills} placeholder="Nice to have…" />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Recruiter">
            <select className={inputCls} value={recruiterPartyId} onChange={(e) => setRecruiterPartyId(e.target.value)}>
              <option value="">—</option>
              {recruiters.map((w) => <option key={w.partyId} value={w.partyId}>{w.name}</option>)}
            </select>
          </Field>
          <Field label="Target close">
            <input type="date" className={inputCls} value={targetCloseDate} onChange={(e) => setTargetCloseDate(e.target.value)} />
          </Field>
          <Field label="Work location">
            <input className={inputCls} value={workLocation} onChange={(e) => setWorkLocation(e.target.value)} placeholder="e.g. Hyderabad" />
          </Field>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink2">
          <input
            type="checkbox"
            checked={budgetApproved}
            onChange={(e) => setBudgetApproved(e.target.checked)}
            className="h-3.5 w-3.5 accent-brand-violet"
          />
          Budget approved for this role
        </label>

        <Field label="Job description">
          <textarea
            className={`${inputCls} min-h-[90px] resize-y`}
            value={jobDescription}
            onChange={(e) => setJobDescription(e.target.value)}
          />
        </Field>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">
            {busy ? "Saving…" : initial ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
