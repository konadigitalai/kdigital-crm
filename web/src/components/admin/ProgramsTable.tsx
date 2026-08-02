"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { createProgram, updateProgram } from "@/lib/api";
import type { Course, DurationUnit, Program, ProgramInput, Stack } from "@/lib/types";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField } from "@/components/filter/types";
import { DialogShell, Pill, RegistryId, distinct } from "@/components/admin/formKit";
import { deliveryModeLabel, normaliseDeliveryMode } from "@/lib/deliveryMode";

function buildFields(rows: Program[]): FilterField[] {
  const stacks = distinct(rows, (r) => r.stackName);
  const families = distinct(rows, (r) => r.family);
  return [
    { key: "name",           label: "Name",       type: "text",   get: (p: Program) => p.name },
    { key: "registryId",     label: "Registry ID",type: "text",   get: (p: Program) => p.registryId },
    { key: "shortCode",      label: "Code",       type: "text",   get: (p: Program) => p.shortCode },
    { key: "stack",          label: "Stack",      type: "enum",   options: stacks.map((s) => ({ value: s, label: s })), get: (p: Program) => p.stackName },
    // Family is the registry's own grouping and is far more useful than stack
    // for the nine KDigital pathways, which all sit in one stack.
    { key: "family",         label: "Family",     type: "enum",   options: families.map((f) => ({ value: f, label: f })), get: (p: Program) => p.family },
    { key: "price",          label: "Price",      type: "number", get: (p: Program) => p.price ? Number(p.price) : null },
    { key: "duration",       label: "Duration",   type: "number", get: (p: Program) => p.durationValue },
    { key: "enabled",        label: "Active",     type: "boolean",get: (p: Program) => p.enabled },
    { key: "composite",      label: "Composite",  type: "boolean",get: (p: Program) => p.referencedProgrammeCount > 0 },
    { key: "leadCount",      label: "Leads",      type: "number", get: (p: Program) => p.leadCount },
    { key: "courseCount",    label: "Courses",    type: "number", get: (p: Program) => p.courseCount },
    { key: "batchCount",     label: "Batches",    type: "number", get: (p: Program) => p.batchCount },
    { key: "enrolmentCount", label: "Enrolments", type: "number", get: (p: Program) => p.enrolmentCount },
  ];
}

type Mode =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "editing"; program: Program };

export function ProgramsTable({
  initial, stacks, courses,
}: {
  initial: Program[]; stacks: Stack[]; courses: Course[];
}) {
  const router = useRouter();
  const [programs, setPrograms] = useState<Program[]>(initial);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [detail, setDetail] = useState<Program | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields = useMemo(() => buildFields(programs), [programs]);
  const [filtered, filterState, setFilterState] = useFilter(programs, fields);

  const activeStacks = stacks.filter((s) => s.enabled);
  const activeCourses = courses.filter((c) => c.enabled);

  function reload() { router.refresh(); }

  async function onCreate(input: ProgramInput) {
    setBusy("create"); setError(null);
    try {
      const created = await createProgram(input);
      setPrograms((all) => [...all, created].sort(sortPrograms));
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onUpdate(p: Program, patch: Partial<ProgramInput>) {
    setBusy(p.id); setError(null);
    try {
      const updated = await updateProgram(p.id, patch);
      setPrograms((all) => all.map((x) => (x.id === p.id ? { ...x, ...updated } : x)).sort(sortPrograms));
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onToggle(p: Program) {
    setBusy(p.id); setError(null);
    try {
      const updated = await updateProgram(p.id, { enabled: !p.enabled });
      setPrograms((all) => all.map((x) => (x.id === p.id ? { ...x, ...updated } : x)).sort(sortPrograms));
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // The registry ships no price. Programmes land unpriced and stay sellable —
  // an advisor quotes per lead — but the gap is worth surfacing once at the
  // top rather than only as a dash in each row.
  const unpriced = programs.filter((p) => p.enabled && !p.price);
  const registryCount = programs.filter((p) => p.registryId).length;

  return (
    <>
      {unpriced.length > 0 && (
        <div className="mb-4 flex items-start gap-3 rounded-[14px] border border-state-warn/30 bg-state-warn/8 p-[14px_18px] text-[13px] text-ink2">
          <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[9px] bg-state-warn/15 text-state-warn">
            <Icon name="info" size={15} strokeWidth={2} />
          </span>
          <div>
            <b className="font-bold text-ink">
              {unpriced.length} active program{unpriced.length === 1 ? " has" : "s have"} no price.
            </b>{" "}
            The KDigital registry does not carry pricing, so imported pathways arrive unpriced.
            They stay selectable and an advisor can quote per lead — set a catalogue price here
            when one is agreed.
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {unpriced.slice(0, 6).map((p) => (
                <button
                  key={p.id}
                  onClick={() => setMode({ kind: "editing", program: p })}
                  className="rounded-full border border-state-warn/40 px-2.5 py-0.5 text-[11.5px] font-semibold text-state-warn hover:bg-state-warn/10"
                >
                  {p.shortCode ?? p.name}
                </button>
              ))}
              {unpriced.length > 6 && (
                <span className="px-1 py-0.5 text-[11.5px] text-mute">+{unpriced.length - 6} more</span>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="mb-4 flex items-center justify-between">
        <div className="text-[13px] text-mute">
          {programs.length} program{programs.length === 1 ? "" : "s"} · {programs.filter((p) => p.enabled).length} active
          {registryCount > 0 && <> · {registryCount} from the KDigital registry</>}
        </div>
        <button
          onClick={() => activeStacks.length > 0 && setMode({ kind: "creating" })}
          disabled={activeStacks.length === 0}
          title={activeStacks.length === 0 ? "Create a stack first" : ""}
          className="btn-grad disabled:opacity-50"
        >
          <Icon name="plus" size={14} strokeWidth={2.2} /> New program
        </button>
      </div>

      <div className="mb-4 rounded-[14px] border border-rule bg-paper p-3">
        <FilterBar
          fields={fields}
          state={filterState}
          onChange={setFilterState}
          placeholder="Filter programs by field…"
          totalRows={programs.length}
          filteredRows={filtered.length}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <Row hdr>
          <div>Program</div>
          <div>Family</div>
          <div className="text-right">Price</div>
          <div>Duration</div>
          <div className="text-center">Structure</div>
          <div className="text-center">Batches</div>
          <div className="text-center">Enrolments</div>
          <div className="text-right">Actions</div>
        </Row>

        {filtered.length === 0 ? (
          <div className="px-[22px] py-10 text-center text-[13px] text-mute">
            {programs.length === 0 ? "No programs yet — add your first." : "No programs match the current filter."}
          </div>
        ) : (
          filtered.map((p) => (
            <Row key={p.id} dimmed={!p.enabled}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-semibold tracking-[-.005em]">{p.name}</span>
                  {p.shortCode && (
                    <span className="mono-cap rounded bg-grad-soft px-1.5 py-0.5 text-[9.5px] font-bold tracking-[.06em] text-brand-violet">
                      {p.shortCode}
                    </span>
                  )}
                  {!p.enabled && <Pill>inactive</Pill>}
                  {p.catalogueStatus === "Retired" && <Pill tone="bad">retired</Pill>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <RegistryId id={p.registryId} />
                  {/* The official long name, only when it differs — CAT-010
                      keeps both and they are usually identical. */}
                  {p.fullName && p.fullName !== p.name && (
                    <span className="truncate text-[11.5px] text-mute" title={p.fullName}>{p.fullName}</span>
                  )}
                </div>
              </div>

              <div className="min-w-0 text-[13px] text-ink2">
                <div className="truncate">{p.family ?? p.stackName ?? <span className="text-mute">—</span>}</div>
                {p.deliveryModes && p.deliveryModes.length > 0 && (
                  <div className="mt-0.5 truncate text-[11px] text-mute">
                    {p.deliveryModes
                      .map((m) => deliveryModeLabel(normaliseDeliveryMode(m) ?? m))
                      .join(" · ")}
                  </div>
                )}
              </div>

              <div className="text-right font-mono text-[13px] text-ink2">
                {p.price
                  ? `₹${Number(p.price).toLocaleString("en-IN")}`
                  : <span className="text-state-warn" title="No catalogue price. Still sellable — an advisor quotes per lead.">not set</span>}
              </div>

              <div className="text-[13px] text-ink2">
                {p.durationValue != null && p.durationUnit
                  ? `${p.durationValue} ${p.durationUnit}`
                  : <span className="text-mute">—</span>}
              </div>

              {/* Courses and referenced programmes are different things and a
                  composite pathway has both. One number could only ever be
                  wrong about one of them. */}
              <div className="text-center text-[13px]">
                <span title={p.courses.map((c) => c.name).join(", ") || undefined}>
                  {p.courseCount > 0 ? `${p.courseCount} course${p.courseCount === 1 ? "" : "s"}` : <span className="text-mute">—</span>}
                </span>
                {p.referencedProgrammeCount > 0 && (
                  <div
                    className="mt-1"
                    title={`References: ${p.referencedProgrammes.map((r) => r.name).join(", ")}`}
                  >
                    <Pill tone="info">+{p.referencedProgrammeCount} pathways</Pill>
                  </div>
                )}
              </div>

              <div className="text-center text-[13px]">{p.batchCount > 0 ? p.batchCount : <span className="text-mute">—</span>}</div>
              <div className="text-center text-[13px]">{p.enrolmentCount > 0 ? p.enrolmentCount : <span className="text-mute">—</span>}</div>
              <div className="flex items-center justify-end gap-1.5">
                <button
                  onClick={() => setDetail(p)}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
                >
                  Structure
                </button>
                <button
                  onClick={() => setMode({ kind: "editing", program: p })}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
                >
                  Edit
                </button>
                <ToggleSwitch enabled={p.enabled} busy={busy === p.id} onClick={() => onToggle(p)} />
              </div>
            </Row>
          ))
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
          {error}
        </div>
      )}

      {mode.kind === "creating" && (
        <ProgramFormDialog
          title="New program"
          submitLabel="Create"
          stacks={activeStacks}
          courses={activeCourses}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(input) => onCreate(input)}
          busy={busy === "create"}
        />
      )}
      {mode.kind === "editing" && (
        <ProgramFormDialog
          title="Edit program"
          submitLabel="Save"
          stacks={activeStacks}
          courses={activeCourses}
          initial={mode.program}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(input) => onUpdate(mode.program, input)}
          busy={busy === mode.program.id}
        />
      )}
      {detail && <ProgramStructureDialog program={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

// ─── Structure ────────────────────────────────────────────────────────────
//
// What a pathway is actually made of. Two lists, because the registry has two
// kinds of component and flattening them loses the thing that matters: a
// composite pathway REFERENCES other pathways rather than copying their
// courses (CAT-007), and courses grouped under a specialisation stay grouped
// (CAT-008).

function ProgramStructureDialog({ program, onClose }: { program: Program; onClose: () => void }) {
  // Group by the registry's specialisation_group. Courses with none fall into
  // a single unlabelled bucket rendered first.
  const grouped = useMemo(() => {
    const buckets = new Map<string, typeof program.courses>();
    for (const c of [...program.courses].sort((a, b) => a.rank - b.rank)) {
      const key = c.specialisationGroup ?? "";
      const list = buckets.get(key) ?? [];
      list.push(c);
      buckets.set(key, list);
    }
    return [...buckets.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  }, [program]);

  return (
    <DialogShell
      title={program.name}
      subtitle={
        program.programmeType === "Composite Career Pathway"
          ? "A composite pathway. It references other pathways rather than duplicating their courses, so a learner who has completed one of them carries that credit in."
          : "The ordered components of this pathway, as published in the KDigital registry."
      }
      onClose={onClose}
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          {program.registryId && <RegistryId id={program.registryId} />}
          {program.credentialType && <Pill tone="brand">{program.credentialType}</Pill>}
          {program.catalogueVersion && <Pill>catalogue {program.catalogueVersion}</Pill>}
          {program.catalogueStatus && (
            <Pill tone={program.catalogueStatus === "Published" ? "good" : "warn"}>
              {program.catalogueStatus}
            </Pill>
          )}
        </div>

        {program.referencedProgrammes.length > 0 && (
          <section>
            <h3 className="mono-cap mb-2 text-[10px] font-semibold tracking-[.12em] text-mute">
              Referenced pathways ({program.referencedProgrammes.length})
            </h3>
            <div className="flex flex-col gap-1.5">
              {[...program.referencedProgrammes].sort((a, b) => a.rank - b.rank).map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 rounded-[10px] border border-brand-violet/25 bg-grad-soft p-2.5"
                >
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-brand-violet/15 font-mono text-[11px] font-bold text-brand-violet">
                    {r.rank + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold">{r.name}</div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <RegistryId id={r.registryId} />
                      {r.role && <span className="text-[11px] text-mute">{r.role}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <h3 className="mono-cap mb-2 text-[10px] font-semibold tracking-[.12em] text-mute">
            {program.referencedProgrammes.length > 0 ? "Its own courses" : "Courses"} ({program.courseCount})
          </h3>
          {program.courses.length === 0 ? (
            <p className="rounded-[10px] border border-rule bg-warm/30 p-3 text-[12.5px] text-mute">
              No courses attached yet.
            </p>
          ) : (
            <div className="space-y-3">
              {grouped.map(([group, courses]) => (
                <div key={group || "_"}>
                  {group && (
                    <div className="mono-cap mb-1.5 text-[9.5px] font-semibold tracking-[.1em] text-brand-violet">
                      {group}
                    </div>
                  )}
                  <div className="flex flex-col gap-1.5">
                    {courses.map((c) => (
                      <div key={c.id} className="flex items-center gap-3 rounded-[10px] border border-rule bg-paper p-2.5">
                        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-warm2 font-mono text-[11px] font-bold text-mute">
                          {c.rank + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-semibold">{c.name}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2">
                            <RegistryId id={c.registryId} />
                            {c.role && <span className="text-[11px] text-mute">{c.role}</span>}
                          </div>
                        </div>
                        {c.required === false && <Pill tone="warn">optional</Pill>}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="flex justify-end pt-1">
          <button onClick={onClose} className="btn">Close</button>
        </div>
      </div>
    </DialogShell>
  );
}

function sortPrograms(a: Program, b: Program) {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function ToggleSwitch({ enabled, busy, onClick }: { enabled: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={enabled ? "Click to deactivate (hides from new-lead dropdowns)" : "Click to reactivate"}
      className={cn(
        "relative h-[22px] w-[40px] flex-shrink-0 rounded-full transition disabled:opacity-50",
        enabled ? "bg-grad" : "bg-rule2",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all",
          enabled ? "left-[20px]" : "left-0.5",
        )}
      />
    </button>
  );
}

function Row({ hdr = false, dimmed = false, children }: { hdr?: boolean; dimmed?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid items-center gap-4 px-[22px] border-b border-rule last:border-b-0 transition",
        hdr
          ? "mono-cap py-3 text-[9.5px] font-semibold tracking-[.12em] text-mute bg-warm"
          : "py-3.5",
        dimmed && !hdr && "bg-warm/40",
      )}
      style={{ gridTemplateColumns: "2.2fr 1.2fr 100px 100px 130px 80px 100px 260px" }}
    >
      {children}
    </div>
  );
}

function ProgramFormDialog({
  title, submitLabel, stacks, courses, initial, onClose, onSubmit, busy,
}: {
  title: string; submitLabel: string;
  stacks: Stack[]; courses: Course[];
  initial?: Program;
  onClose: () => void;
  onSubmit: (input: ProgramInput) => void;
  busy: boolean;
}) {
  const [stackId, setStackId] = useState(initial?.stackId ?? stacks[0]?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [price, setPrice] = useState(initial?.price ?? "");
  const [durationValue, setDurationValue] = useState(initial?.durationValue?.toString() ?? "");
  const [durationUnit, setDurationUnit] = useState<DurationUnit>(initial?.durationUnit ?? "months");
  const [pickedCourseIds, setPickedCourseIds] = useState<Set<string>>(
    new Set(initial?.courses.map((c) => c.id) ?? []),
  );
  const [courseFilter, setCourseFilter] = useState("");

  const filteredCourses = useMemo(() => {
    const q = courseFilter.trim().toLowerCase();
    if (!q) return courses;
    return courses.filter((c) =>
      c.name.toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q),
    );
  }, [courses, courseFilter]);

  function toggleCourse(id: string) {
    setPickedCourseIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <DialogShell
      title={title}
      subtitle="A program has a stack, a price, a duration, and one or more courses."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !stackId) return;
          const dv = durationValue.trim() ? Number(durationValue.trim()) : null;
          onSubmit({
            name: name.trim(),
            stackId,
            description: description.trim() || null,
            price: price.trim() || null,
            durationValue: dv,
            durationUnit: dv != null ? durationUnit : null,
            courseIds: [...pickedCourseIds],
          });
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="Stack" required>
            <select value={stackId} onChange={(e) => setStackId(e.target.value)} className={inputCls}>
              {stacks.length === 0 && <option value="">— No active stacks —</option>}
              {stacks.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Name" required>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Full AI Stack" autoFocus />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Price (₹)">
            <input className={inputCls} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 119000" />
          </Field>
          <Field label="Duration">
            <div className="flex gap-2">
              <input
                className={cn(inputCls, "flex-1")}
                value={durationValue}
                onChange={(e) => setDurationValue(e.target.value)}
                placeholder="e.g. 6"
                inputMode="numeric"
              />
              <select
                className={cn(inputCls, "w-[110px]")}
                value={durationUnit}
                onChange={(e) => setDurationUnit(e.target.value as DurationUnit)}
              >
                <option value="weeks">weeks</option>
                <option value="months">months</option>
              </select>
            </div>
          </Field>
        </div>

        <Field label="Description">
          <textarea
            className={cn(inputCls, "min-h-[70px] resize-y")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="One-liner shown alongside the program in pickers."
          />
        </Field>

        <div>
          <span className="mono-cap mb-1.5 flex items-center justify-between text-[10px] font-semibold tracking-[.12em] text-mute">
            <span>Courses ({pickedCourseIds.size} selected)</span>
            {pickedCourseIds.size > 0 && (
              <button
                type="button"
                onClick={() => setPickedCourseIds(new Set())}
                className="text-[10px] font-semibold text-brand-violet hover:underline"
              >
                Clear
              </button>
            )}
          </span>

          <div className="mb-2 flex items-center gap-2 rounded-full border border-rule bg-warm/50 px-3 py-2 text-[13px] text-ink2 focus-within:border-brand-violet">
            <Icon name="search" size={13} strokeWidth={2} className="text-mute" />
            <input
              value={courseFilter}
              onChange={(e) => setCourseFilter(e.target.value)}
              placeholder="Filter courses…"
              className="w-full bg-transparent outline-none placeholder:text-hint"
            />
          </div>

          <div className="max-h-[240px] overflow-y-auto rounded-[10px] border border-rule bg-warm/20 p-2">
            {courses.length === 0 && (
              <div className="p-3 text-center text-[12.5px] text-mute">
                No active courses yet — create one from the Courses admin.
              </div>
            )}
            {courses.length > 0 && filteredCourses.length === 0 && (
              <div className="p-3 text-center text-[12.5px] text-mute">No courses match &quot;{courseFilter}&quot;.</div>
            )}
            <div className="flex flex-col gap-1.5">
              {filteredCourses.map((c) => {
                const checked = pickedCourseIds.has(c.id);
                return (
                  <label
                    key={c.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-[8px] border p-2 transition",
                      checked ? "border-brand-violet bg-grad-soft" : "border-rule bg-paper hover:border-rule2",
                    )}
                  >
                    <input type="checkbox" className="sr-only" checked={checked} onChange={() => toggleCourse(c.id)} />
                    <span
                      className={cn(
                        "flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[4px] border-2 transition",
                        checked ? "border-brand-violet bg-brand-violet" : "border-rule2",
                      )}
                    >
                      {checked && <Icon name="check" size={11} strokeWidth={3} className="text-white" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold tracking-[-.005em]">{c.name}</div>
                      {c.description && (
                        <div className="mt-0.5 truncate text-[11.5px] text-mute">{c.description}</div>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
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

const inputCls = "w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20";

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">
        {label}{required && <span className="ml-1 text-brand-magenta">*</span>}
      </span>
      {children}
    </label>
  );
}
