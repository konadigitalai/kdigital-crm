"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { createStack, updateStack } from "@/lib/api";
import type { Stack } from "@/lib/types";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField } from "@/components/filter/types";

function buildFields(): FilterField[] {
  return [
    { key: "name",         label: "Name",        type: "text",   get: (s: Stack) => s.name },
    { key: "description",  label: "Description", type: "text",   get: (s: Stack) => s.description },
    { key: "enabled",      label: "Active",      type: "boolean",get: (s: Stack) => s.enabled },
    { key: "programCount", label: "Programs",    type: "number", get: (s: Stack) => s.programCount },
  ];
}

type Mode =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "editing"; stack: Stack };

export function StacksTable({ initial }: { initial: Stack[] }) {
  const router = useRouter();
  const [stacks, setStacks] = useState<Stack[]>(initial);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields = useMemo(() => buildFields(), []);
  const [filtered, filterState, setFilterState] = useFilter(stacks, fields);

  function reload() { router.refresh(); }

  async function onCreate(name: string, description: string | null) {
    setBusy("create"); setError(null);
    try {
      const created = await createStack({ name, description });
      setStacks((all) => [...all, created].sort(sortStacks));
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onUpdate(s: Stack, name: string, description: string | null) {
    setBusy(s.id); setError(null);
    try {
      const updated = await updateStack(s.id, { name, description });
      setStacks((all) => all.map((x) => (x.id === s.id ? { ...x, ...updated } : x)).sort(sortStacks));
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onToggle(s: Stack) {
    setBusy(s.id); setError(null);
    try {
      const updated = await updateStack(s.id, { enabled: !s.enabled });
      setStacks((all) => all.map((x) => (x.id === s.id ? { ...x, ...updated } : x)).sort(sortStacks));
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
          {stacks.length} stack{stacks.length === 1 ? "" : "s"} · {stacks.filter((s) => s.enabled).length} active
        </div>
        <button onClick={() => setMode({ kind: "creating" })} className="btn-grad">
          <Icon name="plus" size={14} strokeWidth={2.2} /> New stack
        </button>
      </div>

      <div className="mb-4 rounded-[14px] border border-rule bg-paper p-3">
        <FilterBar
          fields={fields}
          state={filterState}
          onChange={setFilterState}
          placeholder="Filter stacks by field…"
          totalRows={stacks.length}
          filteredRows={filtered.length}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <Row hdr>
          <div>Stack</div>
          <div>Description</div>
          <div className="text-center">Programs</div>
          <div className="text-right">Actions</div>
        </Row>
        {filtered.length === 0 ? (
          <div className="px-[22px] py-10 text-center text-[13px] text-mute">
            {stacks.length === 0 ? "No stacks yet — add your first." : "No stacks match the current filter."}
          </div>
        ) : (
          filtered.map((s) => (
            <Row key={s.id} dimmed={!s.enabled}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold tracking-[-.005em]">{s.name}</span>
                  {!s.enabled && (
                    <span className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[9px] font-semibold text-mute">inactive</span>
                  )}
                </div>
              </div>
              <div className="min-w-0 truncate text-[13px] text-ink2">
                {s.description ?? <span className="text-mute">—</span>}
              </div>
              <div className="text-center text-[13px]">
                {s.programCount > 0 ? s.programCount : <span className="text-mute">—</span>}
              </div>
              <div className="flex items-center justify-end gap-1.5">
                <button
                  onClick={() => setMode({ kind: "editing", stack: s })}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
                >
                  Edit
                </button>
                <ToggleSwitch enabled={s.enabled} busy={busy === s.id} onClick={() => onToggle(s)} />
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
        <StackFormDialog
          title="New stack"
          submitLabel="Create"
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={onCreate}
          busy={busy === "create"}
        />
      )}
      {mode.kind === "editing" && (
        <StackFormDialog
          title="Edit stack"
          submitLabel="Save"
          initialName={mode.stack.name}
          initialDescription={mode.stack.description ?? ""}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(name, description) => onUpdate(mode.stack, name, description)}
          busy={busy === mode.stack.id}
        />
      )}
    </>
  );
}

function sortStacks(a: Stack, b: Stack) {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function Row({ hdr = false, dimmed = false, children }: { hdr?: boolean; dimmed?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid items-center gap-4 px-[22px] border-b border-rule last:border-b-0 transition",
        hdr ? "mono-cap py-3 text-[9.5px] font-semibold tracking-[.12em] text-mute bg-warm" : "py-3.5",
        dimmed && !hdr && "bg-warm/40",
      )}
      style={{ gridTemplateColumns: "1.6fr 2.4fr 110px 200px" }}
    >
      {children}
    </div>
  );
}

function ToggleSwitch({ enabled, busy, onClick }: { enabled: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={enabled ? "Click to deactivate" : "Click to reactivate"}
      className={cn(
        "relative h-[22px] w-[40px] flex-shrink-0 rounded-full transition disabled:opacity-50",
        enabled ? "bg-grad" : "bg-rule2",
      )}
    >
      <span className={cn("absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all", enabled ? "left-[20px]" : "left-0.5")} />
    </button>
  );
}

function StackFormDialog({
  title, submitLabel, initialName = "", initialDescription = "", onClose, onSubmit, busy,
}: {
  title: string; submitLabel: string;
  initialName?: string; initialDescription?: string;
  onClose: () => void;
  onSubmit: (name: string, description: string | null) => void;
  busy: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="my-12 w-full max-w-[560px] rounded-2xl border border-rule bg-paper p-7 shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[26px] font-normal leading-tight tracking-[-.01em]">{title}</h2>
            <p className="mt-1 text-[13px] text-mute">A stack is the top-level bucket every program belongs to.</p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            onSubmit(name.trim(), description.trim() || null);
          }}
          className="space-y-4"
        >
          <Field label="Name" required>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. AI Stack" autoFocus />
          </Field>
          <Field label="Description">
            <textarea
              className={cn(inputCls, "min-h-[80px] resize-y")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short summary shown in program pickers."
            />
          </Field>
          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn">Cancel</button>
            <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">
              {busy ? "Saving…" : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
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
