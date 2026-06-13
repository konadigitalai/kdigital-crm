"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  activateClient,
  createClient,
  deactivateClient,
  getCatalog,
  getClientAssignments,
  setClientAssignments,
  updateClient,
} from "@/lib/api";
import type { CatalogResponse, Client, ClientMember } from "@/lib/types";

type Mode =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "editing"; client: Client }
  | { kind: "assigning"; client: Client };

export function ClientsTable({ initial }: { initial: Client[] }) {
  const router = useRouter();
  const [clients, setClients] = useState<Client[]>(initial);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reload() { router.refresh(); }

  async function onCreate(input: { name: string; code: string | null; description: string | null }) {
    setBusy("create"); setError(null);
    try {
      const created = await createClient(input);
      setClients((c) => [created, ...c]);
      setMode({ kind: "idle" });
      reload();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }
  async function onUpdate(c: Client, input: { name: string; code: string | null; description: string | null }) {
    setBusy(c.id); setError(null);
    try {
      const updated = await updateClient(c.id, input);
      setClients((all) => all.map((x) => (x.id === c.id ? { ...x, ...updated } : x)));
      setMode({ kind: "idle" });
      reload();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }
  async function onToggle(c: Client) {
    setBusy(c.id); setError(null);
    try {
      if (c.active) await deactivateClient(c.id);
      else await activateClient(c.id);
      setClients((all) => all.map((x) => (x.id === c.id ? { ...x, active: !x.active } : x)));
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[13px] text-mute">
          {clients.length} client{clients.length === 1 ? "" : "s"} · {clients.filter((c) => c.active).length} active
        </div>
        <button onClick={() => setMode({ kind: "creating" })} className="btn-grad">
          <Icon name="plus" size={14} strokeWidth={2.2} /> New client
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <Row hdr>
          <div>Client</div>
          <div>Code</div>
          <div className="text-center">Members</div>
          <div className="text-right">Actions</div>
        </Row>
        {clients.length === 0 ? (
          <div className="px-[22px] py-10 text-center text-[13px] text-mute">No clients yet — add your first.</div>
        ) : (
          clients.map((c) => (
            <Row key={c.id} dimmed={!c.active}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold tracking-[-.005em]">{c.name}</span>
                  {!c.active && <span className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[9px] font-semibold text-mute">inactive</span>}
                </div>
                {c.description && <div className="mt-0.5 text-[12px] text-mute">{c.description}</div>}
              </div>
              <div className="font-mono text-[12px] text-ink2">{c.code ?? <span className="text-mute">—</span>}</div>
              <div className="text-center text-[13px]">
                {c.memberCount && c.memberCount > 0 ? (
                  <span className="rounded-full bg-warm2 px-2 py-0.5 text-[11px] font-semibold text-ink2">{c.memberCount}</span>
                ) : (
                  <span className="text-mute">—</span>
                )}
              </div>
              <div className="flex items-center justify-end gap-1.5">
                <button
                  onClick={() => setMode({ kind: "assigning", client: c })}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
                >
                  Assignments
                </button>
                <button
                  onClick={() => setMode({ kind: "editing", client: c })}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
                >
                  Edit
                </button>
                <Toggle on={c.active} busy={busy === c.id} onClick={() => onToggle(c)} />
              </div>
            </Row>
          ))
        )}
      </div>

      {error && <div className="mt-3 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">{error}</div>}

      {mode.kind === "creating" && (
        <ClientFormDialog title="New client" submitLabel="Create" onClose={() => setMode({ kind: "idle" })} onSubmit={onCreate} busy={busy === "create"} />
      )}
      {mode.kind === "editing" && (
        <ClientFormDialog
          title="Edit client" submitLabel="Save"
          initial={{ name: mode.client.name, code: mode.client.code ?? "", description: mode.client.description ?? "" }}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(input) => onUpdate(mode.client, input)}
          busy={busy === mode.client.id}
        />
      )}
      {mode.kind === "assigning" && (
        <AssignmentsDialog
          client={mode.client}
          onClose={() => setMode({ kind: "idle" })}
          onSaved={(count) => {
            setClients((all) => all.map((x) => (x.id === mode.client.id ? { ...x, memberCount: count } : x)));
            setMode({ kind: "idle" });
            reload();
          }}
        />
      )}
    </>
  );
}

function Toggle({ on, busy, onClick }: { on: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={on ? "Click to deactivate" : "Click to activate"}
      className={cn("relative h-[22px] w-[40px] flex-shrink-0 rounded-full transition disabled:opacity-50", on ? "bg-grad" : "bg-rule2")}
    >
      <span className={cn("absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all", on ? "left-[20px]" : "left-0.5")} />
    </button>
  );
}

function Row({ hdr = false, dimmed = false, children }: { hdr?: boolean; dimmed?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid items-center gap-4 px-[22px] border-b border-rule last:border-b-0",
        hdr ? "mono-cap py-3 text-[9.5px] font-semibold tracking-[.12em] text-mute bg-warm" : "py-3.5",
        dimmed && !hdr && "bg-warm/40",
      )}
      style={{ gridTemplateColumns: "2.5fr 100px 90px 280px" }}
    >
      {children}
    </div>
  );
}

function ClientFormDialog({
  title, submitLabel, initial, onClose, onSubmit, busy,
}: {
  title: string;
  submitLabel: string;
  initial?: { name: string; code: string; description: string };
  onClose: () => void;
  onSubmit: (input: { name: string; code: string | null; description: string | null }) => void;
  busy: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [code, setCode] = useState(initial?.code ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");

  return (
    <Dialog title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onSubmit({ name: name.trim(), code: code.trim() || null, description: description.trim() || null });
        }}
        className="space-y-3"
      >
        <Field label="Name" required>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Acme Corp" />
        </Field>
        <Field label="Code">
          <input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} placeholder="ACME" />
        </Field>
        <Field label="Description">
          <textarea className={cn(inputCls, "min-h-[60px] resize-y")} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">{busy ? "Saving…" : submitLabel}</button>
        </div>
      </form>
    </Dialog>
  );
}

function AssignmentsDialog({ client, onClose, onSaved }: { client: Client; onClose: () => void; onSaved: (count: number) => void }) {
  const [employees, setEmployees] = useState<{ id: string; name: string; email: string; role: string }[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getCatalog(), getClientAssignments(client.id)])
      .then(([cat, members]: [CatalogResponse, ClientMember[]]) => {
        setEmployees(cat.employees);
        setPicked(new Set(members.map((m) => m.id)));
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, [client.id]);

  function toggle(id: string) {
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      const ids = Array.from(picked);
      await setClientAssignments(client.id, ids);
      onSaved(ids.length);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <Dialog title={`Assignments · ${client.name}`} subtitle="Pick which employees can log time against this client." onClose={onClose}>
      {loading ? (
        <div className="text-[13px] text-mute">Loading…</div>
      ) : (
        <>
          <div className="grid max-h-[320px] grid-cols-2 gap-1.5 overflow-y-auto rounded-[10px] border border-rule bg-warm/40 p-2">
            {employees.map((e) => (
              <label key={e.id} className="flex items-center gap-2 rounded p-1.5 text-[12.5px] hover:bg-warm">
                <input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e.id)} />
                <div className="min-w-0">
                  <div className="truncate font-semibold">{e.name}</div>
                  <div className="mono-cap mt-0.5 truncate text-[9px] tracking-[.04em] text-mute">{e.role}</div>
                </div>
              </label>
            ))}
          </div>
          {err && <div className="mt-3 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">{err}</div>}
          <div className="mt-4 flex items-center justify-end gap-2">
            <button onClick={onClose} className="btn">Cancel</button>
            <button onClick={save} disabled={busy} className="btn-grad disabled:opacity-60">
              {busy ? "Saving…" : `Save (${picked.size})`}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}

function Dialog({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="my-12 w-full max-w-[560px] rounded-2xl border border-rule bg-paper p-6 shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[24px] font-normal leading-tight">{title}</h2>
            {subtitle && <p className="mt-1 text-[13px] text-mute">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputCls = "w-full rounded-[10px] border border-rule bg-paper px-3 py-2 text-[13px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20";

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mono-cap mb-1 block text-[10px] font-semibold tracking-[.12em] text-mute">
        {label}{required && <span className="ml-1 text-brand-magenta">*</span>}
      </span>
      {children}
    </label>
  );
}
