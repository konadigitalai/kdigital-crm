"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { createProgram, updateProgram } from "@/lib/api";
import type { Program } from "@/lib/types";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField } from "@/components/filter/types";

function buildFields(rows: Program[]): FilterField[] {
  const tracks = [...new Set(rows.map((r) => r.track).filter(Boolean))] as string[];
  return [
    { key: "name",          label: "Name",        type: "text",   get: (p: Program) => p.name },
    { key: "track",         label: "Track",       type: "enum",   options: tracks.map((t) => ({ value: t, label: t })), get: (p: Program) => p.track },
    { key: "price",         label: "Price",       type: "number", get: (p: Program) => p.price ? Number(p.price) : null },
    { key: "enabled",       label: "Active",      type: "boolean", get: (p: Program) => p.enabled },
    { key: "leadCount",     label: "Leads",       type: "number", get: (p: Program) => p.leadCount },
    { key: "courseCount",   label: "Courses",     type: "number", get: (p: Program) => p.courseCount },
    { key: "batchCount",    label: "Batches",     type: "number", get: (p: Program) => p.batchCount },
    { key: "enrolmentCount",label: "Enrolments",  type: "number", get: (p: Program) => p.enrolmentCount },
  ];
}

type Mode =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "editing"; program: Program };

export function ProgramsTable({ initial }: { initial: Program[] }) {
  const router = useRouter();
  const [programs, setPrograms] = useState<Program[]>(initial);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields = useMemo(() => buildFields(programs), [programs]);
  const [filtered, filterState, setFilterState] = useFilter(programs, fields);

  function reload() { router.refresh(); }

  async function onCreate(name: string, track: string | null, price: string | null) {
    setBusy("create"); setError(null);
    try {
      const created = await createProgram({ name, track: track ?? undefined, price: price ?? undefined });
      setPrograms((p) => [
        ...p,
        { ...created, price, enabled: true, leadCount: 0, courseCount: 0, batchCount: 0, enrolmentCount: 0 },
      ].sort(sortPrograms));
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onUpdate(p: Program, name: string, track: string | null, price: string | null) {
    setBusy(p.id); setError(null);
    try {
      const updated = await updateProgram(p.id, { name, track, price });
      setPrograms((all) =>
        all.map((x) => (x.id === p.id ? { ...x, ...updated } : x)).sort(sortPrograms)
      );
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onToggleEnabled(p: Program) {
    setBusy(p.id); setError(null);
    try {
      const updated = await updateProgram(p.id, { enabled: !p.enabled });
      setPrograms((all) =>
        all.map((x) => (x.id === p.id ? { ...x, ...updated } : x)).sort(sortPrograms)
      );
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[13px] text-mute">
          {programs.length} program{programs.length === 1 ? "" : "s"} ·{" "}
          {programs.filter((p) => p.enabled).length} active
        </div>
        <button onClick={() => setMode({ kind: "creating" })} className="btn-grad">
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
          <div className="text-right">Price</div>
          <div className="text-center">Leads</div>
          <div className="text-center">Courses</div>
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
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold tracking-[-.005em]">{p.name}</span>
                  {!p.enabled && (
                    <span className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[9px] font-semibold text-mute">
                      inactive
                    </span>
                  )}
                </div>
                {p.track && (
                  <div className="mono-cap mt-0.5 text-[9.5px] tracking-[.04em] text-mute">{p.track}</div>
                )}
              </div>
              <div className="text-right font-mono text-[13px] text-ink2">
                {p.price ? `₹${Number(p.price).toLocaleString("en-IN")}` : <span className="text-mute">—</span>}
              </div>
              <div className="text-center text-[13px]">
                {p.leadCount > 0 ? (
                  <span className="rounded-full bg-[rgba(199,25,122,.1)] px-2 py-0.5 font-mono text-[11px] font-semibold text-brand-magenta">
                    {p.leadCount}
                  </span>
                ) : (
                  <span className="text-mute">—</span>
                )}
              </div>
              <div className="text-center text-[13px]">{p.courseCount > 0 ? p.courseCount : <span className="text-mute">—</span>}</div>
              <div className="text-center text-[13px]">{p.batchCount > 0 ? p.batchCount : <span className="text-mute">—</span>}</div>
              <div className="text-center text-[13px]">{p.enrolmentCount > 0 ? p.enrolmentCount : <span className="text-mute">—</span>}</div>
              <div className="flex items-center justify-end gap-1.5">
                <button
                  onClick={() => setMode({ kind: "editing", program: p })}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
                >
                  Edit
                </button>
                <ToggleSwitch
                  enabled={p.enabled}
                  busy={busy === p.id}
                  onClick={() => onToggleEnabled(p)}
                />
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
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(name, track, price) => onCreate(name, track, price)}
          busy={busy === "create"}
        />
      )}
      {mode.kind === "editing" && (
        <ProgramFormDialog
          title="Edit program"
          submitLabel="Save"
          initialName={mode.program.name}
          initialTrack={mode.program.track ?? ""}
          initialPrice={mode.program.price ?? ""}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(name, track, price) => onUpdate(mode.program, name, track, price)}
          busy={busy === mode.program.id}
        />
      )}
    </>
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
      style={{ gridTemplateColumns: "2.4fr 110px 80px 90px 90px 110px 200px" }}
    >
      {children}
    </div>
  );
}

function DialogShell({
  title, subtitle, onClose, children,
}: {
  title: string; subtitle?: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="my-12 w-full max-w-[560px] rounded-2xl border border-rule bg-paper p-7 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[26px] font-normal leading-tight tracking-[-.01em]">{title}</h2>
            {subtitle && <p className="mt-1 text-[13px] leading-[1.5] text-mute">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ProgramFormDialog({
  title, submitLabel, initialName = "", initialTrack = "", initialPrice = "", onClose, onSubmit, busy,
}: {
  title: string; submitLabel: string;
  initialName?: string; initialTrack?: string; initialPrice?: string;
  onClose: () => void;
  onSubmit: (name: string, track: string | null, price: string | null) => void;
  busy: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [track, setTrack] = useState(initialTrack);
  const [price, setPrice] = useState(initialPrice);
  return (
    <DialogShell title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onSubmit(name.trim(), track.trim() || null, price.trim() || null);
        }}
        className="space-y-4"
      >
        <Field label="Name" required>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cloud Engineering · AWS" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Track">
            <input className={inputCls} value={track} onChange={(e) => setTrack(e.target.value)} placeholder="e.g. Engineering" />
          </Field>
          <Field label="Price (₹)">
            <input className={inputCls} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 119000" />
          </Field>
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
