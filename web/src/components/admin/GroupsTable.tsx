"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { createGroup, deleteGroup, setGroupPermissions, updateGroup } from "@/lib/api";
import type { ModuleAccess, PermissionPreset, UserGroupSummary } from "@/lib/types";

type Mode =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "editing"; group: UserGroupSummary };

export function GroupsTable({
  initial,
  modules,
  presets,
}: {
  initial: UserGroupSummary[];
  modules: ModuleAccess[];
  presets: PermissionPreset[];
}) {
  const router = useRouter();
  const [groups, setGroups] = useState<UserGroupSummary[]>(initial);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reload() { router.refresh(); }

  async function onCreate(name: string, description: string, permissions: string[]) {
    setBusy("create");
    setError(null);
    try {
      await createGroup({ name, description: description || undefined, permissions });
      reload();
      setMode({ kind: "idle" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onSaveEdit(
    g: UserGroupSummary,
    name: string,
    description: string,
    permissions: string[],
  ) {
    setBusy(g.id);
    setError(null);
    try {
      if (name !== g.name || (description ?? "") !== (g.description ?? "")) {
        await updateGroup(g.id, { name, description: description || null });
      }
      const samePerms =
        permissions.length === g.permissions.length &&
        permissions.every((p) => g.permissions.includes(p));
      if (!samePerms) await setGroupPermissions(g.id, permissions);
      setGroups((all) =>
        all.map((x) =>
          x.id === g.id ? { ...x, name, description: description || null, permissions } : x,
        ),
      );
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(g: UserGroupSummary) {
    if (!confirm(`Delete group "${g.name}"? This cannot be undone.`)) return;
    setBusy(g.id);
    setError(null);
    try {
      await deleteGroup(g.id);
      setGroups((all) => all.filter((x) => x.id !== g.id));
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
          {groups.length} group{groups.length === 1 ? "" : "s"}
        </div>
        <button onClick={() => setMode({ kind: "creating" })} className="btn-grad">
          <Icon name="plus" size={14} strokeWidth={2.2} /> New group
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <Row hdr>
          <div>Group</div>
          <div className="text-center">Members</div>
          <div className="text-center">Permissions</div>
          <div className="text-right">Actions</div>
        </Row>

        {groups.length === 0 ? (
          <div className="px-[22px] py-10 text-center text-[13px] text-mute">No groups yet.</div>
        ) : (
          groups.map((g) => (
            <Row key={g.id}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold tracking-[-.005em]">{g.name}</span>
                  {g.is_system && (
                    <span className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[9px] font-semibold text-mute">
                      system
                    </span>
                  )}
                </div>
                {g.description && (
                  <div className="mono-cap mt-0.5 text-[10px] tracking-[.04em] text-mute">
                    {g.description}
                  </div>
                )}
              </div>
              <div className="text-center text-[13px]">{g.member_count}</div>
              <div className="text-center text-[13px]">{g.permissions.length}</div>
              <div className="flex items-center justify-end gap-1.5">
                <button
                  onClick={() => setMode({ kind: "editing", group: g })}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
                >
                  Edit
                </button>
                <button
                  onClick={() => onDelete(g)}
                  disabled={g.is_system || busy === g.id}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-state-warn hover:border-state-warn disabled:opacity-40"
                >
                  Delete
                </button>
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
        <GroupFormDialog
          title="New group"
          submitLabel="Create"
          modules={modules}
          presets={presets}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(name, description, perms) => onCreate(name, description, perms)}
          busy={busy === "create"}
        />
      )}
      {mode.kind === "editing" && (
        <GroupFormDialog
          title="Edit group"
          submitLabel="Save"
          modules={modules}
          presets={presets}
          initialName={mode.group.name}
          initialDescription={mode.group.description ?? ""}
          initialPerms={mode.group.permissions}
          isAdministratorsGroup={mode.group.name === "Administrators"}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(name, description, perms) =>
            onSaveEdit(mode.group, name, description, perms)
          }
          busy={busy === mode.group.id}
        />
      )}
    </>
  );
}

function Row({
  hdr = false,
  children,
}: {
  hdr?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid items-center gap-4 px-[22px] border-b border-rule last:border-b-0",
        hdr ? "mono-cap py-3 text-[9.5px] font-semibold tracking-[.12em] text-mute bg-warm" : "py-3.5",
      )}
      style={{ gridTemplateColumns: "3fr 110px 130px 200px" }}
    >
      {children}
    </div>
  );
}

function DialogShell({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="my-12 w-full max-w-[760px] rounded-2xl border border-rule bg-paper p-7 shadow-card"
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

function GroupFormDialog({
  title,
  submitLabel,
  modules,
  presets,
  initialName = "",
  initialDescription = "",
  initialPerms = [],
  isAdministratorsGroup = false,
  onClose,
  onSubmit,
  busy,
}: {
  title: string;
  submitLabel: string;
  modules: ModuleAccess[];
  presets: PermissionPreset[];
  initialName?: string;
  initialDescription?: string;
  initialPerms?: string[];
  isAdministratorsGroup?: boolean;
  onClose: () => void;
  onSubmit: (name: string, description: string, perms: string[]) => void;
  busy: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [perms, setPerms] = useState<Set<string>>(new Set(initialPerms));

  // Permissions that don't fit into any module — shown in an "Other" group so
  // nothing is silently dropped if the API catalog adds something new.
  const knownByModule = useMemo(() => {
    const all = new Set<string>();
    for (const m of modules) for (const lvl of m.levels) all.add(lvl.permission);
    return all;
  }, [modules]);
  const orphanPerms = Array.from(perms).filter((p) => !knownByModule.has(p));

  function toggle(p: string) {
    setPerms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  function applyPreset(preset: PermissionPreset) {
    setPerms(new Set(preset.permissions));
  }

  function selectAllInModule(m: ModuleAccess) {
    setPerms((prev) => {
      const next = new Set(prev);
      const allOn = m.levels.every((lvl) => next.has(lvl.permission));
      for (const lvl of m.levels) {
        if (allOn) next.delete(lvl.permission);
        else next.add(lvl.permission);
      }
      return next;
    });
  }

  return (
    <DialogShell
      title={title}
      subtitle={
        isAdministratorsGroup
          ? "This is the Administrators system group. The 'users.manage' permission cannot be removed (otherwise the tenant would lock itself out)."
          : "Tick which modules this group has access to. A user's effective access is the union of every group they belong to."
      }
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onSubmit(name.trim(), description.trim(), Array.from(perms));
        }}
        className="space-y-5"
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name" required>
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isAdministratorsGroup}
              autoFocus={!isAdministratorsGroup}
              placeholder="e.g. Reporting Analysts"
            />
          </Field>
          <Field label="Description">
            <input
              className={inputCls}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </Field>
        </div>

        {/* Quick-fill presets */}
        <div>
          <div className="mono-cap mb-2 block text-[10px] font-semibold tracking-[.12em] text-mute">
            Quick presets
          </div>
          <div className="flex flex-wrap gap-2">
            {presets.map((preset) => (
              <button
                key={preset.key}
                type="button"
                onClick={() => applyPreset(preset)}
                title={preset.description}
                className="rounded-full border border-rule bg-warm2 px-3 py-1.5 text-[12px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
              >
                {preset.name}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPerms(new Set())}
              className="rounded-full border border-rule bg-paper px-3 py-1.5 text-[12px] font-semibold text-mute hover:border-state-warn hover:text-state-warn"
            >
              Clear all
            </button>
          </div>
          <div className="mono-cap mt-1.5 text-[10px] tracking-[.04em] text-hint">
            Click a preset to fill in the boxes below — you can still tweak before saving.
          </div>
        </div>

        {/* Module table */}
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <span className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">
              Module access
            </span>
            <span className="mono-cap text-[10px] tracking-[.04em] text-hint">
              {perms.size} permission{perms.size === 1 ? "" : "s"} on
            </span>
          </div>
          <div className="overflow-hidden rounded-[10px] border border-rule">
            <table className="w-full border-collapse">
              <thead className="bg-warm/60 text-[10.5px] uppercase tracking-[.1em] text-mute">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Module</th>
                  <th className="px-3 py-2 text-right font-semibold">Access levels</th>
                </tr>
              </thead>
              <tbody>
                {modules.map((m) => {
                  const allChecked = m.levels.every((lvl) => perms.has(lvl.permission));
                  const someChecked = !allChecked && m.levels.some((lvl) => perms.has(lvl.permission));
                  return (
                    <tr key={m.key} className="border-t border-rule align-top">
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => selectAllInModule(m)}
                            className={cn(
                              "h-4 w-4 flex-shrink-0 rounded border text-white",
                              allChecked
                                ? "border-brand-violet bg-brand-violet"
                                : someChecked
                                  ? "border-brand-violet bg-brand-violet/30"
                                  : "border-rule2 bg-paper hover:border-brand-violet",
                            )}
                            title={allChecked ? "Disable all" : "Enable all"}
                          >
                            {allChecked && (
                              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="3" className="h-full w-full p-0.5">
                                <path d="M4 11l4 4 8-9" />
                              </svg>
                            )}
                            {someChecked && (
                              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="3" className="h-full w-full p-0.5">
                                <path d="M5 10h10" />
                              </svg>
                            )}
                          </button>
                          <div className="flex flex-col">
                            <span className="text-[13px] font-semibold text-ink">{m.label}</span>
                            {m.description && (
                              <span className="text-[11.5px] leading-snug text-mute">{m.description}</span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap items-center justify-end gap-3">
                          {m.levels.map((lvl) => {
                            const locked =
                              isAdministratorsGroup && lvl.permission === "users.manage";
                            const checked = perms.has(lvl.permission);
                            return (
                              <label
                                key={lvl.permission}
                                className={cn(
                                  "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium",
                                  checked
                                    ? "border-brand-violet bg-brand-violet/8 text-brand-violet"
                                    : "border-rule bg-paper text-ink2 hover:border-rule2",
                                  locked && "opacity-60",
                                )}
                              >
                                <input
                                  type="checkbox"
                                  className="h-3 w-3 accent-brand-violet"
                                  checked={checked}
                                  disabled={locked}
                                  onChange={() => toggle(lvl.permission)}
                                />
                                <span>{lvl.label}</span>
                              </label>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {orphanPerms.length > 0 && (
            <div className="mono-cap mt-2 text-[10px] tracking-[.04em] text-hint">
              Other permissions on this group: {orphanPerms.join(", ")}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-rule pt-4">
          <button type="button" onClick={onClose} className="btn">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">
            {busy ? "Saving…" : submitLabel}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

const inputCls =
  "w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20 disabled:bg-warm/40 disabled:text-mute";

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">
        {label}
        {required && <span className="ml-1 text-brand-magenta">*</span>}
      </span>
      {children}
    </label>
  );
}
