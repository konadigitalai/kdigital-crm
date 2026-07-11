"use client";

// Event-driven trigger management.
//
// Layout is a list + a "New trigger" modal. The trigger schema is
// deliberately narrow (event type + strict-equality condition + template
// + variable bindings + cooldown) so the UI stays tiny — anything more
// complex belongs in a manual campaign.

import { useEffect, useMemo, useState } from "react";
import {
  listCampaignTriggers, createCampaignTrigger, updateCampaignTrigger, deleteCampaignTrigger,
  listWaTemplates,
  type CampaignTrigger, type WaTemplate,
} from "@/lib/api";
import { Icon } from "@/components/ui/Icon";

const EVENT_TYPES: Array<{ key: string; label: string; fields: string[] }> = [
  { key: "lead.stage_changed",  label: "Lead stage changed",  fields: ["to", "from"] },
  { key: "lead.created",        label: "Lead created",        fields: ["source"]     },
  { key: "lead.rating_changed", label: "Lead rating changed", fields: ["to", "from"] },
];

export function TriggersAdmin() {
  const [rows, setRows] = useState<CampaignTrigger[] | null>(null);
  const [templates, setTemplates] = useState<WaTemplate[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  async function load() {
    try {
      const [t, tpl] = await Promise.all([
        listCampaignTriggers(),
        listWaTemplates({ onlyApproved: true }),
      ]);
      setRows(t);
      setTemplates(tpl);
    } catch (e) { setErr((e as Error).message); }
  }
  useEffect(() => { load(); }, []);

  async function toggle(id: string, enabled: boolean) {
    try { await updateCampaignTrigger(id, { enabled }); await load(); }
    catch (e) { setErr((e as Error).message); }
  }
  async function remove(id: string) {
    if (!confirm("Delete this trigger? It will stop firing immediately.")) return;
    try { await deleteCampaignTrigger(id); await load(); }
    catch (e) { setErr((e as Error).message); }
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-end gap-2">
        <button onClick={() => setShowNew(true)} className="btn-grad">New trigger</button>
      </div>

      {err && <div className="mb-3 rounded-md border border-state-warn/30 bg-state-warn/10 p-3 text-[13px] text-state-warn">{err}</div>}

      <div className="overflow-hidden rounded-[14px] border border-rule bg-paper">
        {rows == null ? (
          <div className="p-5 text-[13px] text-mute">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-5 text-[13px] text-mute">
            No triggers yet. Create one to auto-send a template on stage change or lead create.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-rule bg-warm/40 text-left mono-cap text-[10.5px] tracking-[.05em] text-mute">
                <th className="px-4 py-2 font-semibold">Name</th>
                <th className="px-4 py-2 font-semibold">Event</th>
                <th className="px-4 py-2 font-semibold">Template</th>
                <th className="px-4 py-2 font-semibold">Condition</th>
                <th className="px-4 py-2 font-semibold text-center">Cooldown (hr)</th>
                <th className="px-4 py-2 font-semibold text-center">Fires</th>
                <th className="px-4 py-2 font-semibold text-center">Enabled</th>
                <th className="px-4 py-2 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-b border-rule last:border-0">
                  <td className="px-4 py-2 font-semibold text-ink">{t.name}</td>
                  <td className="px-4 py-2 text-ink2 mono-cap text-[11px]">{t.eventType}</td>
                  <td className="px-4 py-2 text-ink2">{t.templateName ?? t.contentSid}</td>
                  <td className="px-4 py-2 text-[12px] text-mute mono-cap">
                    {Object.entries(t.condition ?? {}).map(([k, v]) => `${k}=${String(v)}`).join(", ") || "—"}
                  </td>
                  <td className="px-4 py-2 text-center tabular-nums text-ink2">{t.cooldownHours}</td>
                  <td className="px-4 py-2 text-center tabular-nums text-ink2">{t.totalFires}</td>
                  <td className="px-4 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={t.enabled}
                      onChange={(e) => toggle(t.id, e.target.checked)}
                      className="h-4 w-4 accent-brand-violet"
                    />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => remove(t.id)}
                      className="rounded-md p-1 text-mute hover:bg-warm hover:text-state-warn"
                      aria-label="Delete trigger"
                    >
                      <Icon name="plus" size={14} className="rotate-45" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showNew && (
        <NewTriggerDialog
          templates={templates}
          onClose={() => setShowNew(false)}
          onCreated={async () => { setShowNew(false); await load(); }}
        />
      )}
    </>
  );
}

function NewTriggerDialog({
  templates, onClose, onCreated,
}: {
  templates: WaTemplate[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName]           = useState("");
  const [eventType, setEventType] = useState<string>(EVENT_TYPES[0].key);
  const [condition, setCondition] = useState<Record<string, string>>({});
  const [contentSid, setContentSid] = useState("");
  const [cooldownHours, setCooldownHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState<string | null>(null);

  const tpl = useMemo(() => templates.find((t) => t.contentSid === contentSid) ?? null, [contentSid, templates]);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!tpl) return;
    const seed: Record<string, string> = {};
    for (const n of tpl.variables.names) seed[n] = tpl.variables.samples?.[n] ?? "";
    setBindings(seed);
  }, [tpl]);

  const activeFields = EVENT_TYPES.find((e) => e.key === eventType)?.fields ?? [];

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const cleanCondition: Record<string, string> = {};
      for (const k of activeFields) {
        const v = (condition[k] ?? "").trim();
        if (v) cleanCondition[k] = v;
      }
      await createCampaignTrigger({
        name: name.trim(),
        eventType,
        condition: cleanCondition,
        contentSid,
        variableBindings: bindings,
        cooldownHours,
        enabled: true,
      });
      onCreated();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="my-12 w-full max-w-[600px] rounded-2xl border border-rule bg-paper p-6 shadow-card">
        <div className="mb-4 flex items-start justify-between">
          <h2 className="font-serif text-[22px] leading-tight tracking-[-.01em]">New trigger</h2>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} className="rotate-45" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mono-cap block text-[10px] text-hint">Name</label>
            <input
              value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Send welcome on Demo Attended"
              className="mt-1 w-full rounded-md border border-rule bg-warm/40 px-2 py-1.5 text-[12.5px]"
            />
          </div>

          <div>
            <label className="mono-cap block text-[10px] text-hint">Event</label>
            <select
              value={eventType} onChange={(e) => { setEventType(e.target.value); setCondition({}); }}
              className="mt-1 w-full rounded-md border border-rule bg-paper px-2 py-1.5 text-[12.5px]"
            >
              {EVENT_TYPES.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
            </select>
          </div>

          {activeFields.length > 0 && (
            <div>
              <label className="mono-cap block text-[10px] text-hint">Condition (all must match; leave blank to match anything)</label>
              <div className="mt-1 space-y-1.5">
                {activeFields.map((f) => (
                  <div key={f} className="flex items-center gap-2">
                    <span className="mono-cap w-16 shrink-0 text-[11px] text-mute">{f}</span>
                    <input
                      value={condition[f] ?? ""}
                      onChange={(e) => setCondition((prev) => ({ ...prev, [f]: e.target.value }))}
                      placeholder="e.g. Demo Attended"
                      className="flex-1 rounded-md border border-rule bg-warm/40 px-2 py-1.5 text-[12.5px]"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="mono-cap block text-[10px] text-hint">Template</label>
            {templates.length === 0 ? (
              <div className="mt-1 rounded-md border border-state-warn/30 bg-state-warn/10 p-2 text-[12.5px] text-state-warn">
                No approved templates. Create one first.
              </div>
            ) : (
              <select
                value={contentSid} onChange={(e) => setContentSid(e.target.value)}
                className="mt-1 w-full rounded-md border border-rule bg-paper px-2 py-1.5 text-[12.5px]"
              >
                <option value="">Pick a template…</option>
                {templates.map((t) => (
                  <option key={t.contentSid} value={t.contentSid}>
                    {t.friendlyName} {t.language ? `· ${t.language}` : ""}
                  </option>
                ))}
              </select>
            )}
          </div>

          {tpl && tpl.variables.names.length > 0 && (
            <div>
              <label className="mono-cap block text-[10px] text-hint">Variables (literal or {"{{party.name}}"} style)</label>
              <div className="mt-1 space-y-1.5">
                {tpl.variables.names.map((n) => (
                  <div key={n} className="flex items-center gap-2">
                    <span className="mono-cap w-24 shrink-0 truncate text-[11px] text-mute">{n}</span>
                    <input
                      value={bindings[n] ?? ""}
                      onChange={(e) => setBindings((prev) => ({ ...prev, [n]: e.target.value }))}
                      className="flex-1 rounded-md border border-rule bg-warm/40 px-2 py-1.5 text-[12.5px]"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="mono-cap block text-[10px] text-hint">Cooldown (hours) — 0 disables the guard</label>
            <input
              type="number" min={0} max={720}
              value={cooldownHours}
              onChange={(e) => setCooldownHours(Math.max(0, Math.min(720, Number(e.target.value) || 0)))}
              className="mt-1 w-32 rounded-md border border-rule bg-warm/40 px-2 py-1.5 text-[12.5px]"
            />
          </div>
        </div>

        {err && <div className="mt-3 rounded-md border border-state-warn/30 bg-state-warn/10 p-2 text-[12.5px] text-state-warn">{err}</div>}

        <div className="mt-5 flex items-center justify-end gap-3 border-t border-rule pt-4">
          <button onClick={onClose} disabled={busy} className="btn">Cancel</button>
          <button
            onClick={submit}
            disabled={busy || !name.trim() || !contentSid}
            className="btn-grad disabled:opacity-60"
          >
            {busy ? "Creating…" : "Create + enable"}
          </button>
        </div>
      </div>
    </div>
  );
}
