"use client";

// The workforce directory.
//
// A worker record is an EMPLOYMENT record, not an identity — the name, email
// and phone come from the party and are edited on the person, not here. That
// is why the create dialog leads with "employ someone the CRM already knows"
// and treats creating a new person as the fallback: the directory must not
// become a second, divergent copy of people the CRM already has.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { createWorker, updateWorker } from "@/lib/api";
import type {
  EmploymentType, Worker, WorkerInput, WorkerStatus, WorkerType,
} from "@/lib/types";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField } from "@/components/filter/types";
import {
  DialogShell, EmptyRow, ErrorNote, Field, GridRow, Pill, TagInput,
  distinct, formatMonths, humanise, inputCls,
} from "@/components/admin/formKit";

const COLS = "2fr 1.3fr 1.1fr 120px 110px 130px 170px";

const WORKER_TYPES: WorkerType[] = ["employee", "contractor", "trainer", "intern", "vendor"];
const EMPLOYMENT_TYPES: EmploymentType[] = ["full_time", "part_time", "contract", "intern"];
const STATUSES: WorkerStatus[] = ["active", "on_leave", "notice_period", "exited"];

const STATUS_TONE: Record<WorkerStatus, "good" | "warn" | "bad" | "neutral"> = {
  active: "good",
  on_leave: "warn",
  notice_period: "warn",
  exited: "neutral",
};

function buildFields(rows: Worker[]): FilterField[] {
  const departments = distinct(rows, (w) => w.department);
  const designations = distinct(rows, (w) => w.designation);
  return [
    { key: "name",       label: "Name",       type: "text", get: (w: Worker) => w.name },
    { key: "employeeNumber", label: "Employee no.", type: "text", get: (w: Worker) => w.employeeNumber },
    { key: "designation", label: "Designation", type: "enum", options: designations.map((d) => ({ value: d, label: d })), get: (w: Worker) => w.designation },
    { key: "department", label: "Department", type: "enum", options: departments.map((d) => ({ value: d, label: d })), get: (w: Worker) => w.department },
    { key: "workerType", label: "Type",       type: "enum", options: WORKER_TYPES.map((t) => ({ value: t, label: humanise(t) })), get: (w: Worker) => w.workerType },
    { key: "status",     label: "Status",     type: "enum", options: STATUSES.map((s) => ({ value: s, label: humanise(s) })), get: (w: Worker) => w.status },
    // The two the scheduler actually filters on.
    { key: "trainerCapable",      label: "Can train",  type: "boolean", get: (w: Worker) => w.trainerCapable },
    { key: "deploymentAvailable", label: "Deployable", type: "boolean", get: (w: Worker) => w.deploymentAvailable },
    { key: "activeBatchCount",    label: "Active batches", type: "number", get: (w: Worker) => w.activeBatchCount },
    { key: "shift",      label: "Shift",      type: "text", get: (w: Worker) => w.shift },
  ];
}

type Mode =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "editing"; worker: Worker };

export function WorkersTable({ initial }: { initial: Worker[] }) {
  const router = useRouter();
  const [workers, setWorkers] = useState<Worker[]>(initial);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields = useMemo(() => buildFields(workers), [workers]);
  const [filtered, filterState, setFilterState] = useFilter(workers, fields);

  function sortWorkers(a: Worker, b: Worker) {
    // Exited people sink; everyone else alphabetical.
    if ((a.status === "exited") !== (b.status === "exited")) return a.status === "exited" ? 1 : -1;
    return a.name.localeCompare(b.name);
  }

  async function onCreate(input: WorkerInput) {
    setBusy("create"); setError(null);
    try {
      const created = await createWorker(input);
      setWorkers((all) => [...all, created].sort(sortWorkers));
      setMode({ kind: "idle" });
      router.refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  async function onUpdate(w: Worker, patch: WorkerInput) {
    setBusy(w.partyId); setError(null);
    try {
      const updated = await updateWorker(w.partyId, patch);
      setWorkers((all) => all.map((x) => (x.partyId === w.partyId ? updated : x)).sort(sortWorkers));
      setMode({ kind: "idle" });
      router.refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  const trainers = workers.filter((w) => w.trainerCapable && w.status === "active");
  const deployable = workers.filter((w) => w.deploymentAvailable && w.status === "active");

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[13px] text-mute">
          {workers.length} {workers.length === 1 ? "person" : "people"}
          {" · "}{workers.filter((w) => w.status === "active").length} active
          {" · "}{trainers.length} can train
          {" · "}{deployable.length} deployable
        </div>
        <button onClick={() => setMode({ kind: "creating" })} className="btn-grad">
          <Icon name="plus" size={14} strokeWidth={2.2} /> Add worker
        </button>
      </div>

      <div className="mb-4 rounded-[14px] border border-rule bg-paper p-3">
        <FilterBar
          fields={fields}
          state={filterState}
          onChange={setFilterState}
          placeholder="Filter people by field…"
          totalRows={workers.length}
          filteredRows={filtered.length}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <GridRow cols={COLS} hdr>
          <div>Person</div>
          <div>Role</div>
          <div>Skills</div>
          <div className="text-center">Capability</div>
          <div className="text-center">Batches</div>
          <div>Status</div>
          <div className="text-right">Actions</div>
        </GridRow>

        {filtered.length === 0 ? (
          <EmptyRow>
            {workers.length === 0
              ? "Nobody in the directory yet — add your first."
              : "Nobody matches the current filter."}
          </EmptyRow>
        ) : filtered.map((w) => (
          <GridRow key={w.partyId} cols={COLS} dimmed={w.status === "exited"}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-semibold tracking-[-.005em]">{w.name}</span>
                <span className="font-mono text-[10.5px] text-hint">{w.employeeNumber}</span>
              </div>
              <div className="mt-0.5 truncate text-[11.5px] text-mute">
                {w.email ?? w.phone ?? "no contact details on the party record"}
              </div>
            </div>

            <div className="min-w-0 text-[13px] text-ink2">
              <div className="truncate">{w.designation ?? <span className="text-mute">—</span>}</div>
              <div className="mt-0.5 truncate text-[11.5px] text-mute">
                {[w.department, humanise(w.workerType)].filter(Boolean).join(" · ")}
              </div>
            </div>

            <div className="min-w-0 text-[12px] text-ink2">
              {w.skills.length === 0
                ? <span className="text-mute">—</span>
                : (
                  <span className="line-clamp-2" title={w.skills.join(", ")}>
                    {w.skills.join(", ")}
                  </span>
                )}
            </div>

            <div className="flex flex-wrap items-center justify-center gap-1">
              {w.trainerCapable && <Pill tone="brand" title="Appears in trainer pickers">trains</Pill>}
              {w.deploymentAvailable && <Pill tone="info" title="Available for client deployment">deployable</Pill>}
              {!w.trainerCapable && !w.deploymentAvailable && <span className="text-mute">—</span>}
            </div>

            <div className="text-center text-[13px]" title="Upcoming or running batches they train">
              {w.activeBatchCount > 0 ? w.activeBatchCount : <span className="text-mute">—</span>}
            </div>

            <div className="min-w-0">
              <Pill tone={STATUS_TONE[w.status]}>{humanise(w.status)}</Pill>
              {w.reportingToName && (
                <div className="mt-1 truncate text-[11px] text-mute" title={`Reports to ${w.reportingToName}`}>
                  ↳ {w.reportingToName}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-1.5">
              <button
                onClick={() => setMode({ kind: "editing", worker: w })}
                className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
              >
                Edit
              </button>
            </div>
          </GridRow>
        ))}
      </div>

      <ErrorNote message={error} />

      {mode.kind === "creating" && (
        <WorkerFormDialog
          title="Add to the directory"
          submitLabel="Add"
          managers={workers}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={onCreate}
          busy={busy === "create"}
        />
      )}
      {mode.kind === "editing" && (
        <WorkerFormDialog
          title={mode.worker.name}
          submitLabel="Save"
          managers={workers.filter((w) => w.partyId !== mode.worker.partyId)}
          initial={mode.worker}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(patch) => onUpdate(mode.worker, patch)}
          busy={busy === mode.worker.partyId}
        />
      )}
    </>
  );
}

function WorkerFormDialog({
  title, submitLabel, managers, initial, onClose, onSubmit, busy,
}: {
  title: string; submitLabel: string;
  managers: Worker[];
  initial?: Worker;
  onClose: () => void;
  onSubmit: (input: WorkerInput) => void;
  busy: boolean;
}) {
  const isEdit = Boolean(initial);

  const [name, setName] = useState(initial?.name ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [workerType, setWorkerType] = useState<WorkerType>(initial?.workerType ?? "employee");
  const [designation, setDesignation] = useState(initial?.designation ?? "");
  const [department, setDepartment] = useState(initial?.department ?? "");
  const [employmentType, setEmploymentType] = useState<EmploymentType | "">(initial?.employmentType ?? "");
  const [dateOfJoining, setDateOfJoining] = useState(initial?.dateOfJoining ?? "");
  const [dateOfExit, setDateOfExit] = useState(initial?.dateOfExit ?? "");
  const [reportingTo, setReportingTo] = useState(initial?.reportingToPartyId ?? "");
  const [status, setStatus] = useState<WorkerStatus>(initial?.status ?? "active");
  const [shift, setShift] = useState(initial?.shift ?? "");
  const [hours, setHours] = useState(initial?.workingHoursPerWeek ?? "");
  const [skills, setSkills] = useState<string[]>(initial?.skills ?? []);
  const [trainerCapable, setTrainerCapable] = useState(initial?.trainerCapable ?? false);
  const [deploymentAvailable, setDeploymentAvailable] = useState(initial?.deploymentAvailable ?? false);

  // Marking someone exited without a date leaves "when" unanswerable later,
  // so prefill today the moment the status flips.
  function onStatusChange(next: WorkerStatus) {
    setStatus(next);
    if (next === "exited" && !dateOfExit) setDateOfExit(new Date().toISOString().slice(0, 10));
  }

  return (
    <DialogShell
      title={title}
      wide
      subtitle={
        isEdit
          ? "Employment details. Name, email and phone live on the person's party record and are edited there."
          : "Employment details for a member of staff. Contact details are stored on the person, not on this record."
      }
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const patch: WorkerInput = {
            workerType,
            designation: designation.trim() || null,
            department: department.trim() || null,
            employmentType: employmentType || null,
            dateOfJoining: dateOfJoining || null,
            dateOfExit: dateOfExit || null,
            reportingToPartyId: reportingTo || null,
            status,
            shift: shift.trim() || null,
            workingHoursPerWeek: String(hours).trim() || null,
            skills,
            trainerCapable,
            deploymentAvailable,
          };
          if (!isEdit) {
            if (!name.trim()) return;
            patch.name = name.trim();
            patch.email = email.trim() || null;
            patch.phone = phone.trim() || null;
          }
          onSubmit(patch);
        }}
        className="space-y-4"
      >
        {!isEdit && (
          <div className="grid grid-cols-3 gap-4">
            <Field label="Full name" required>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Leena Das" />
            </Field>
            <Field label="Email">
              <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="leena@kdigital.ai" />
            </Field>
            <Field label="Phone">
              <input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91…" />
            </Field>
          </div>
        )}

        <div className="grid grid-cols-3 gap-4">
          <Field label="Designation">
            <input className={inputCls} value={designation} onChange={(e) => setDesignation(e.target.value)} placeholder="e.g. Senior Trainer" />
          </Field>
          <Field label="Department">
            <input className={inputCls} value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="e.g. Delivery" />
          </Field>
          <Field label="Worker type">
            <select className={inputCls} value={workerType} onChange={(e) => setWorkerType(e.target.value as WorkerType)}>
              {WORKER_TYPES.map((t) => <option key={t} value={t}>{humanise(t)}</option>)}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Employment type">
            <select className={inputCls} value={employmentType} onChange={(e) => setEmploymentType(e.target.value as EmploymentType | "")}>
              <option value="">—</option>
              {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{humanise(t)}</option>)}
            </select>
          </Field>
          <Field label="Joined">
            <input type="date" className={inputCls} value={dateOfJoining} onChange={(e) => setDateOfJoining(e.target.value)} />
          </Field>
          <Field label="Status">
            <select className={inputCls} value={status} onChange={(e) => onStatusChange(e.target.value as WorkerStatus)}>
              {STATUSES.map((s) => <option key={s} value={s}>{humanise(s)}</option>)}
            </select>
          </Field>
        </div>

        {status === "exited" && (
          <Field label="Exit date" hint="Kept so the batches they taught and the leads they owned still resolve to a name.">
            <input type="date" className={cn(inputCls, "max-w-[220px]")} value={dateOfExit} onChange={(e) => setDateOfExit(e.target.value)} />
          </Field>
        )}

        <div className="grid grid-cols-3 gap-4">
          <Field label="Reports to">
            <select className={inputCls} value={reportingTo} onChange={(e) => setReportingTo(e.target.value)}>
              <option value="">—</option>
              {managers
                .filter((m) => m.status !== "exited")
                .map((m) => <option key={m.partyId} value={m.partyId}>{m.name}</option>)}
            </select>
          </Field>
          <Field label="Shift" hint="Free text — shifts vary per team.">
            <input className={inputCls} value={shift} onChange={(e) => setShift(e.target.value)} placeholder="e.g. Evening (IST)" />
          </Field>
          <Field label="Hours / week">
            <input className={inputCls} value={hours ?? ""} onChange={(e) => setHours(e.target.value)} placeholder="e.g. 40" inputMode="decimal" />
          </Field>
        </div>

        <Field label="Skills" hint="Paste a comma-separated list, or type and press Enter.">
          <TagInput value={skills} onChange={setSkills} placeholder="Python, GenAI, ServiceNow…" />
        </Field>

        {/* These two drive real behaviour elsewhere, so they get an
            explanation rather than a bare checkbox. */}
        <div className="grid grid-cols-2 gap-3">
          <CapabilityToggle
            checked={trainerCapable}
            onChange={setTrainerCapable}
            label="Can train"
            detail="Appears in the trainer and co-trainer pickers on the Batches board."
          />
          <CapabilityToggle
            checked={deploymentAvailable}
            onChange={setDeploymentAvailable}
            label="Available for deployment"
            detail="Can be put forward for client engagements."
          />
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">
            {busy ? "Saving…" : submitLabel}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

function CapabilityToggle({
  checked, onChange, label, detail,
}: {
  checked: boolean; onChange: (v: boolean) => void; label: string; detail: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-[10px] border p-3 transition",
        checked ? "border-brand-violet bg-grad-soft" : "border-rule bg-paper hover:border-rule2",
      )}
    >
      <input type="checkbox" className="sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[4px] border-2 transition",
          checked ? "border-brand-violet bg-brand-violet" : "border-rule2",
        )}
      >
        {checked && <Icon name="check" size={11} strokeWidth={3} className="text-white" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold">{label}</span>
        <span className="mt-0.5 block text-[11.5px] leading-[1.45] text-mute">{detail}</span>
      </span>
    </label>
  );
}
