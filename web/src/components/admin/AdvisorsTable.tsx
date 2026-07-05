"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { createAdvisor, updateAdvisor } from "@/lib/api";
import type { Advisor, AdvisorInput, AdvisorRole } from "@/lib/types";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField } from "@/components/filter/types";

function buildFields(): FilterField[] {
  const ROLES: { value: AdvisorRole; label: string }[] = [
    { value: "admin",   label: "Admin"   },
    { value: "advisor", label: "Advisor" },
  ];
  return [
    { key: "name",   label: "Name",   type: "text",   get: (a: Advisor) => a.name },
    { key: "email",  label: "Email",  type: "text",   get: (a: Advisor) => a.email },
    { key: "phone",  label: "Phone",  type: "text",   get: (a: Advisor) => a.phone },
    { key: "role",   label: "Role",   type: "enum",   options: ROLES.map((r) => ({ value: r.value, label: r.label })), get: (a: Advisor) => a.role },
    { key: "active", label: "Active", type: "boolean", get: (a: Advisor) => a.active },
    { key: "leads",  label: "Leads",  type: "number", get: (a: Advisor) => a.leadCount },
  ];
}

type Mode =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "editing"; advisor: Advisor };

export function AdvisorsTable({ initial }: { initial: Advisor[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<Advisor[]>(initial);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields = useMemo(() => buildFields(), []);
  const [filtered, filterState, setFilterState] = useFilter(rows, fields);

  function reload() { router.refresh(); }

  async function onCreate(input: AdvisorInput) {
    setBusy("create"); setError(null);
    try {
      const created = await createAdvisor(input);
      setRows((r) => [...r, created].sort(sortAdvisors));
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onUpdate(a: Advisor, patch: Parameters<typeof updateAdvisor>[1]) {
    setBusy(a.id); setError(null);
    try {
      const updated = await updateAdvisor(a.id, patch);
      setRows((r) => r.map((x) => (x.id === a.id ? { ...x, ...updated } : x)).sort(sortAdvisors));
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onToggle(a: Advisor) {
    setBusy(a.id); setError(null);
    try {
      const updated = await updateAdvisor(a.id, { active: !a.active });
      setRows((r) => r.map((x) => (x.id === a.id ? { ...x, ...updated } : x)).sort(sortAdvisors));
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
          {rows.length} advisor{rows.length === 1 ? "" : "s"} · {rows.filter((a) => a.active).length} active
        </div>
        <button onClick={() => setMode({ kind: "creating" })} className="btn-grad">
          <Icon name="plus" size={14} strokeWidth={2.2} /> New advisor
        </button>
      </div>

      <div className="mb-4 rounded-[14px] border border-rule bg-paper p-3">
        <FilterBar
          fields={fields}
          state={filterState}
          onChange={setFilterState}
          placeholder="Filter advisors by field…"
          totalRows={rows.length}
          filteredRows={filtered.length}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <Row hdr>
          <div>Name</div>
          <div>Email</div>
          <div>Phone</div>
          <div>Role</div>
          <div className="text-center">Leads</div>
          <div>Login</div>
          <div className="text-right">Actions</div>
        </Row>
        {filtered.length === 0 ? (
          <div className="px-[22px] py-10 text-center text-[13px] text-mute">
            {rows.length === 0 ? "No advisors yet — add your first." : "No advisors match the current filter."}
          </div>
        ) : (
          filtered.map((a) => (
            <Row key={a.id} dimmed={!a.active}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold tracking-[-.005em]">{a.name ?? "—"}</span>
                  {!a.active && (
                    <span className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[9px] font-semibold text-mute">inactive</span>
                  )}
                </div>
              </div>
              <div className="text-[13px] text-ink2 truncate" title={a.email}>{a.email}</div>
              <div className="font-mono text-[12.5px] text-ink2">{a.phone ?? <span className="text-mute">—</span>}</div>
              <div className="text-[13px] text-ink2 capitalize">{a.role}</div>
              <div className="text-center text-[13px]">{a.leadCount > 0 ? a.leadCount : <span className="text-mute">—</span>}</div>
              <div className="text-[12px]">
                {a.auth0Sub
                  ? <span className="mono-cap rounded-full bg-[rgba(46,158,106,.10)] px-2 py-0.5 text-[9px] font-semibold text-state-ok">signed in</span>
                  : <span className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[9px] font-semibold text-mute">invited</span>}
              </div>
              <div className="flex items-center justify-end gap-1.5">
                <button
                  onClick={() => setMode({ kind: "editing", advisor: a })}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
                >
                  Edit
                </button>
                <ToggleSwitch enabled={a.active} busy={busy === a.id} onClick={() => onToggle(a)} />
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
        <AdvisorFormDialog
          title="New advisor"
          submitLabel="Add advisor"
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={onCreate}
          busy={busy === "create"}
        />
      )}
      {mode.kind === "editing" && (
        <AdvisorFormDialog
          title="Edit advisor"
          submitLabel="Save"
          initial={mode.advisor}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(input) => onUpdate(mode.advisor, {
            name:  input.name,
            phone: input.phone ?? null,
            role:  input.role,
          })}
          busy={busy === mode.advisor.id}
        />
      )}
    </>
  );
}

function sortAdvisors(a: Advisor, b: Advisor) {
  if (a.active !== b.active) return a.active ? -1 : 1;
  return (a.name ?? a.email).localeCompare(b.name ?? b.email);
}

function Row({ hdr = false, dimmed = false, children }: { hdr?: boolean; dimmed?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid items-center gap-4 px-[22px] border-b border-rule last:border-b-0 transition",
        hdr ? "mono-cap py-3 text-[9.5px] font-semibold tracking-[.12em] text-mute bg-warm" : "py-3.5",
        dimmed && !hdr && "bg-warm/40",
      )}
      style={{ gridTemplateColumns: "1.4fr 2fr 1.2fr 100px 80px 100px 180px" }}
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
      title={enabled ? "Click to deactivate (hides from Advisor picker)" : "Click to reactivate"}
      className={cn(
        "relative h-[22px] w-[40px] flex-shrink-0 rounded-full transition disabled:opacity-50",
        enabled ? "bg-grad" : "bg-rule2",
      )}
    >
      <span className={cn("absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all", enabled ? "left-[20px]" : "left-0.5")} />
    </button>
  );
}

function AdvisorFormDialog({
  title, submitLabel, initial, onClose, onSubmit, busy,
}: {
  title: string; submitLabel: string;
  initial?: Advisor;
  onClose: () => void;
  onSubmit: (input: AdvisorInput) => void;
  busy: boolean;
}) {
  const [name,  setName]  = useState(initial?.name  ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [role,  setRole]  = useState<AdvisorRole>(initial?.role ?? "advisor");
  const emailEditable = !initial; // don't allow email edits post-create — that's the identity key

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="my-12 w-full max-w-[560px] rounded-2xl border border-rule bg-paper p-7 shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[26px] font-normal leading-tight tracking-[-.01em]">{title}</h2>
            <p className="mt-1 text-[13px] text-mute">
              Advisors can be assigned leads immediately. They can sign in once they authenticate through Auth0 using the same email.
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !email.trim()) return;
            onSubmit({
              name:  name.trim(),
              email: email.trim(),
              phone: phone.trim() || null,
              role,
            });
          }}
          className="space-y-4"
        >
          <Field label="Full name" required>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya N." autoFocus />
          </Field>
          <Field label="Email" required>
            <input
              className={inputCls}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="advisor@yourdomain.com"
              disabled={!emailEditable}
            />
            {!emailEditable && (
              <span className="mt-1 block text-[11px] text-mute">Email is the identity key and can&apos;t be changed once set.</span>
            )}
          </Field>
          <Field label="Phone">
            <input className={inputCls} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" />
          </Field>
          <Field label="Role" required>
            <div className="flex gap-2">
              {(["advisor", "admin"] as const).map((r) => (
                <button
                  type="button"
                  key={r}
                  onClick={() => setRole(r)}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-[12px] font-semibold capitalize transition",
                    role === r ? "border border-transparent bg-ink text-white" : "border border-rule bg-paper text-ink2 hover:border-rule2",
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
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

const inputCls = "w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20 disabled:bg-warm";

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
