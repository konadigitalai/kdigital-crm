"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  WaActionType, WaAutomationAction, WaAutomationListItem, WaAutomationTrigger,
  WaTag, WaTemplate, WaTriggerType,
} from "@/lib/types";
import { createWaAutomation, deleteWaAutomation, updateWaAutomation } from "@/lib/api";

const TRIGGER_TYPES: { value: WaTriggerType; label: string; help: string }[] = [
  { value: "inbound_message_keyword", label: "Inbound message keyword", help: "Fires when a customer sends a message containing a keyword or matching a regex." },
  { value: "new_contact",             label: "New contact",             help: "Fires the first time we see a phone number on WhatsApp." },
  { value: "lead_created",            label: "Lead created",            help: "Fires when a lead is created in the CRM (any source, optional source filter)." },
];

const ACTION_TYPES: { value: WaActionType; label: string }[] = [
  { value: "send_template", label: "Send template" },
  { value: "send_text",     label: "Send text (24h window only)" },
  { value: "add_tag",       label: "Add tag" },
  { value: "assign_user",   label: "Assign to user" },
  { value: "set_status",    label: "Set conversation status" },
];

interface UserOption { id: string; name: string | null }

export function WaAutomationEditor({
  initial, templates, tags, users, mode,
}: {
  initial?: WaAutomationListItem;
  templates: WaTemplate[];
  tags: WaTag[];
  users: UserOption[];
  mode: "new" | "edit";
}) {
  const router = useRouter();
  const approvedTemplates = useMemo(() => templates.filter((t) => t.status === "approved"), [templates]);

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [trigger, setTrigger] = useState<WaAutomationTrigger>(initial?.trigger ?? { type: "inbound_message_keyword", config: { keyword: "" } });
  const [actions, setActions] = useState<WaAutomationAction[]>(initial?.actions ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function setTriggerType(type: WaTriggerType) {
    if (type === "inbound_message_keyword") setTrigger({ type, config: { keyword: "", caseSensitive: false } });
    else if (type === "lead_created") setTrigger({ type, config: { source: "" } });
    else setTrigger({ type, config: {} });
  }

  function addAction(type: WaActionType) {
    const initCfg: Record<string, unknown> = (() => {
      switch (type) {
        case "send_template": return { templateId: approvedTemplates[0]?.id ?? "", variables: {} };
        case "send_text":     return { body: "" };
        case "add_tag":       return { tagId: tags[0]?.id ?? "" };
        case "assign_user":   return { userId: users[0]?.id ?? "" };
        case "set_status":    return { status: "open" };
      }
    })();
    setActions((p) => [...p, { type, config: initCfg }]);
  }

  function updateAction(idx: number, patch: Partial<WaAutomationAction>) {
    setActions((p) => p.map((a, i) => (i === idx ? { ...a, ...patch, config: { ...a.config, ...(patch.config ?? {}) } } : a)));
  }
  function removeAction(idx: number) {
    setActions((p) => p.filter((_, i) => i !== idx));
  }
  function move(idx: number, dir: -1 | 1) {
    setActions((p) => {
      const next = [...p];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return p;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }

  async function handleSave() {
    setBusy(true); setErr(null);
    try {
      if (!name.trim()) { setErr("Name is required"); return; }
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        trigger,
        actions,
        enabled,
      };
      if (mode === "new") {
        const { id } = await createWaAutomation(payload);
        router.push(`/whatsapp/automations/${id}`);
      } else if (initial) {
        await updateWaAutomation(initial.id, payload);
        router.refresh();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!initial) return;
    if (!confirm("Delete this automation? Past runs are kept for audit but won't be visible.")) return;
    setBusy(true); setErr(null);
    try {
      await deleteWaAutomation(initial.id);
      router.push("/whatsapp/automations");
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Identity */}
      <section className="rounded-[14px] border border-rule bg-paper p-6">
        <h2 className="mb-4 text-[16px] font-semibold text-ink">Identity</h2>
        <label className="mb-3 block">
          <span className="mono-cap mb-1 block text-[10px] font-semibold tracking-[.1em] text-mute">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120}
            placeholder="Auto-reply on pricing keyword"
            className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-[13.5px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20" />
        </label>
        <label className="mb-3 block">
          <span className="mono-cap mb-1 block text-[10px] font-semibold tracking-[.1em] text-mute">Description (optional)</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-[13.5px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20" />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="text-[13px] text-ink">Enabled</span>
          <span className="text-[12px] text-mute">— disabled automations are saved but won't fire.</span>
        </label>
      </section>

      {/* Trigger */}
      <section className="rounded-[14px] border border-rule bg-paper p-6">
        <h2 className="mb-1 text-[16px] font-semibold text-ink">Trigger</h2>
        <p className="mb-4 text-[12.5px] text-mute">Pick what kicks off the automation.</p>
        <div className="space-y-2">
          {TRIGGER_TYPES.map((t) => (
            <label key={t.value} className={
              "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition " +
              (trigger.type === t.value ? "border-brand-violet bg-brand-violet/5" : "border-rule bg-paper hover:border-rule2")
            }>
              <input type="radio" name="trigger-type" value={t.value} checked={trigger.type === t.value}
                onChange={() => setTriggerType(t.value)} className="mt-1" />
              <div>
                <div className="text-[13px] font-semibold text-ink">{t.label}</div>
                <div className="text-[12px] text-mute">{t.help}</div>
              </div>
            </label>
          ))}
        </div>

        {/* Trigger config */}
        {trigger.type === "inbound_message_keyword" && (
          <div className="mt-4 grid grid-cols-1 gap-3 rounded-md border border-rule bg-warm/30 p-3 sm:grid-cols-2">
            <label className="block">
              <span className="mono-cap mb-1 block text-[10px] font-semibold tracking-[.1em] text-mute">Keyword (substring match)</span>
              <input value={String(trigger.config?.keyword ?? "")}
                onChange={(e) => setTrigger({ type: "inbound_message_keyword", config: { ...trigger.config, keyword: e.target.value } })}
                placeholder="price"
                className="w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12.5px] text-ink focus:border-brand-violet focus:outline-none" />
            </label>
            <label className="block">
              <span className="mono-cap mb-1 block text-[10px] font-semibold tracking-[.1em] text-mute">Or regex (advanced)</span>
              <input value={String(trigger.config?.regex ?? "")}
                onChange={(e) => setTrigger({ type: "inbound_message_keyword", config: { ...trigger.config, regex: e.target.value } })}
                placeholder="\\b(price|cost|fee)\\b"
                className="w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 font-mono text-[12.5px] text-ink focus:border-brand-violet focus:outline-none" />
            </label>
            <label className="col-span-full flex items-center gap-2">
              <input type="checkbox" checked={!!trigger.config?.caseSensitive}
                onChange={(e) => setTrigger({ type: "inbound_message_keyword", config: { ...trigger.config, caseSensitive: e.target.checked } })} />
              <span className="text-[12.5px] text-ink">Case-sensitive</span>
            </label>
          </div>
        )}
        {trigger.type === "lead_created" && (
          <div className="mt-4 rounded-md border border-rule bg-warm/30 p-3">
            <label className="block">
              <span className="mono-cap mb-1 block text-[10px] font-semibold tracking-[.1em] text-mute">Source filter (optional)</span>
              <input value={String(trigger.config?.source ?? "")}
                onChange={(e) => setTrigger({ type: "lead_created", config: { source: e.target.value } })}
                placeholder="whatsapp, website, referral, …"
                className="w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12.5px] text-ink focus:border-brand-violet focus:outline-none" />
              <span className="mt-1 block text-[11px] text-hint">Leave blank to fire on every lead created.</span>
            </label>
          </div>
        )}
      </section>

      {/* Actions */}
      <section className="rounded-[14px] border border-rule bg-paper p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold text-ink">Actions</h2>
          <span className="text-[12px] text-mute">Run in order. A single failure won't stop the rest.</span>
        </div>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {ACTION_TYPES.map((t) => (
            <button key={t.value} onClick={() => addAction(t.value)}
              className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink hover:border-rule2">
              + {t.label}
            </button>
          ))}
        </div>

        {actions.length === 0 ? (
          <div className="rounded-md border border-dashed border-rule bg-warm/30 px-4 py-6 text-center text-[12.5px] text-mute">
            Add at least one action above.
          </div>
        ) : (
          <ol className="space-y-2">
            {actions.map((a, i) => (
              <li key={i} className="rounded-md border border-rule bg-warm/30 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded-md bg-brand-violet/15 px-2 py-0.5 text-[10.5px] font-semibold text-brand-violet">
                    {i + 1}
                  </span>
                  <span className="text-[12.5px] font-semibold text-ink">
                    {ACTION_TYPES.find((t) => t.value === a.type)?.label ?? a.type}
                  </span>
                  <span className="ml-auto flex items-center gap-1">
                    <button onClick={() => move(i, -1)} disabled={i === 0}
                      className="rounded-md border border-rule bg-paper px-2 py-0.5 text-[11px] font-semibold text-ink hover:border-rule2 disabled:opacity-30">↑</button>
                    <button onClick={() => move(i, +1)} disabled={i === actions.length - 1}
                      className="rounded-md border border-rule bg-paper px-2 py-0.5 text-[11px] font-semibold text-ink hover:border-rule2 disabled:opacity-30">↓</button>
                    <button onClick={() => removeAction(i)}
                      className="rounded-md border border-state-bad/40 bg-state-bad/5 px-2 py-0.5 text-[11px] font-semibold text-state-bad hover:bg-state-bad/10">
                      Remove
                    </button>
                  </span>
                </div>
                <ActionConfig action={a} idx={i} update={updateAction} templates={approvedTemplates} tags={tags} users={users} />
              </li>
            ))}
          </ol>
        )}
      </section>

      {err && <div className="rounded-md border border-state-bad/40 bg-state-bad/5 px-3 py-2 text-[12.5px] text-state-bad">{err}</div>}

      <div className="flex items-center justify-end gap-2">
        {mode === "edit" && initial && (
          <button onClick={handleDelete} disabled={busy}
            className="mr-auto rounded-md border border-state-bad/40 bg-state-bad/5 px-3 py-2 text-[13px] font-semibold text-state-bad hover:bg-state-bad/10 disabled:opacity-50">
            Delete
          </button>
        )}
        <button onClick={handleSave} disabled={busy}
          className="rounded-md bg-brand-violet px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
          {busy ? "Saving…" : mode === "new" ? "Create" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

// ─── Per-action config UI ──────────────────────────────────────────────

function ActionConfig({
  action, idx, update, templates, tags, users,
}: {
  action: WaAutomationAction;
  idx: number;
  update: (i: number, patch: Partial<WaAutomationAction>) => void;
  templates: WaTemplate[];
  tags: WaTag[];
  users: UserOption[];
}) {
  const cfg = action.config;
  if (action.type === "send_template") {
    const tpl = templates.find((t) => t.id === cfg.templateId);
    return (
      <div className="space-y-2">
        <label className="block">
          <span className="mono-cap mb-1 block text-[10px] font-semibold tracking-[.1em] text-mute">Template</span>
          <select value={String(cfg.templateId ?? "")}
            onChange={(e) => update(idx, { config: { templateId: e.target.value, variables: {} } })}
            className="w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12.5px] text-ink focus:border-brand-violet focus:outline-none">
            {templates.length === 0 && <option value="">No approved templates</option>}
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.templateName} · {t.language} · {t.category}</option>
            ))}
          </select>
        </label>
        {tpl && tpl.variableCount > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {Array.from({ length: tpl.variableCount }, (_, i) => i + 1).map((vIdx) => (
              <label key={vIdx} className="block">
                <span className="mono-cap mb-0.5 block text-[10px] font-semibold tracking-[.1em] text-mute">{`{{${vIdx}}}`}</span>
                <input value={String((cfg.variables as Record<string, string> | undefined)?.[String(vIdx)] ?? "")}
                  onChange={(e) => update(idx, { config: { variables: { ...(cfg.variables as Record<string, string> | undefined ?? {}), [String(vIdx)]: e.target.value } } })}
                  className="w-full rounded-md border border-rule bg-paper px-2.5 py-1 text-[12.5px] text-ink focus:border-brand-violet focus:outline-none" />
              </label>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (action.type === "send_text") {
    return (
      <label className="block">
        <span className="mono-cap mb-1 block text-[10px] font-semibold tracking-[.1em] text-mute">Body</span>
        <textarea value={String(cfg.body ?? "")} rows={3}
          onChange={(e) => update(idx, { config: { body: e.target.value } })}
          placeholder="Thanks — an advisor will be with you shortly."
          className="w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12.5px] text-ink focus:border-brand-violet focus:outline-none" />
        <span className="mt-1 block text-[11px] text-hint">Only sent when the conversation is in the 24h window. Otherwise the action skips with an error.</span>
      </label>
    );
  }
  if (action.type === "add_tag") {
    return (
      <label className="block">
        <span className="mono-cap mb-1 block text-[10px] font-semibold tracking-[.1em] text-mute">Tag</span>
        <select value={String(cfg.tagId ?? "")} onChange={(e) => update(idx, { config: { tagId: e.target.value } })}
          className="w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12.5px] text-ink focus:border-brand-violet focus:outline-none">
          {tags.length === 0 && <option value="">No tags — create one in Admin → Integrations → WhatsApp</option>}
          {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
    );
  }
  if (action.type === "assign_user") {
    return (
      <label className="block">
        <span className="mono-cap mb-1 block text-[10px] font-semibold tracking-[.1em] text-mute">User</span>
        <select value={String(cfg.userId ?? "")} onChange={(e) => update(idx, { config: { userId: e.target.value } })}
          className="w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12.5px] text-ink focus:border-brand-violet focus:outline-none">
          <option value="">Unassigned</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name ?? u.id}</option>)}
        </select>
      </label>
    );
  }
  if (action.type === "set_status") {
    return (
      <label className="block">
        <span className="mono-cap mb-1 block text-[10px] font-semibold tracking-[.1em] text-mute">Status</span>
        <select value={String(cfg.status ?? "open")} onChange={(e) => update(idx, { config: { status: e.target.value } })}
          className="w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12.5px] text-ink focus:border-brand-violet focus:outline-none">
          <option value="open">open</option>
          <option value="pending">pending</option>
          <option value="closed">closed</option>
        </select>
      </label>
    );
  }
  return null;
}
