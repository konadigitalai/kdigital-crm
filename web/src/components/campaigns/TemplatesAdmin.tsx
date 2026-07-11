"use client";

// Admin surface for WhatsApp templates.
//
// Two views on one page: a list of every cached template with its
// approval status, plus a modal draft-and-submit form for `twilio/text`
// (the simplest and most common shape). Richer types (quick-reply, media,
// list-picker) still work through the Twilio Content Builder UI — this
// page is a fast path for the common case.

import { useEffect, useState } from "react";
import {
  listWaTemplates, syncWaTemplates, createWaTemplate, submitWaTemplateForApproval,
  type WaTemplate,
} from "@/lib/api";
import { StatusPill } from "./StatusPill";
import { Icon } from "@/components/ui/Icon";

export function TemplatesAdmin() {
  const [rows, setRows] = useState<WaTemplate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  async function load() {
    try { setRows(await listWaTemplates()); }
    catch (e) { setErr((e as Error).message); }
  }
  useEffect(() => { load(); }, []);

  async function sync() {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await syncWaTemplates(); await load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-end gap-2">
        <button type="button" onClick={sync} disabled={busy} className="btn">
          {busy ? "Syncing…" : "Sync from Twilio"}
        </button>
        <button type="button" onClick={() => setShowNew(true)} className="btn-grad">New template</button>
      </div>

      {err && <div className="mb-3 rounded-md border border-state-warn/30 bg-state-warn/10 p-3 text-[13px] text-state-warn">{err}</div>}

      <div className="overflow-hidden rounded-[14px] border border-rule bg-paper">
        {rows == null ? (
          <div className="p-5 text-[13px] text-mute">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-5 text-[13px] text-mute">No templates yet.</div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-rule bg-warm/40 text-left mono-cap text-[10.5px] tracking-[.05em] text-mute">
                <th className="px-4 py-2 font-semibold">Name</th>
                <th className="px-4 py-2 font-semibold">Language</th>
                <th className="px-4 py-2 font-semibold">Variables</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => <TemplateRow key={t.contentSid} tpl={t} onChanged={load} />)}
            </tbody>
          </table>
        )}
      </div>

      {showNew && (
        <NewTemplateDialog
          onClose={() => setShowNew(false)}
          onCreated={async () => { setShowNew(false); await load(); }}
        />
      )}
    </>
  );
}

function TemplateRow({ tpl, onChanged }: { tpl: WaTemplate; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState<string | null>(null);
  const [askSubmit, setAskSubmit] = useState(false);

  const canSubmit = tpl.approvalStatus === "draft" || tpl.approvalStatus === "unknown" || tpl.approvalStatus === "rejected";
  const varCount  = tpl.variables?.names?.length ?? 0;

  async function submit(category: "MARKETING" | "UTILITY" | "AUTHENTICATION", displayName: string) {
    setBusy(true); setErr(null);
    try {
      await submitWaTemplateForApproval(tpl.contentSid, category, displayName);
      onChanged();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); setAskSubmit(false); }
  }

  return (
    <>
      <tr className="border-b border-rule last:border-0 hover:bg-warm/30">
        <td className="px-4 py-3">
          <div className="font-semibold text-ink">{tpl.friendlyName}</div>
          <div className="mono-cap text-[10.5px] text-hint">{tpl.contentSid}</div>
        </td>
        <td className="px-4 py-3 text-ink2">{tpl.language ?? "—"}</td>
        <td className="px-4 py-3 text-ink2 tabular-nums">{varCount}</td>
        <td className="px-4 py-3"><StatusPill status={tpl.approvalStatus} /></td>
        <td className="px-4 py-3 text-right">
          {canSubmit && (
            <button
              type="button" onClick={() => setAskSubmit(true)} disabled={busy}
              className="rounded-md border border-rule px-2 py-1 text-[11.5px] font-semibold hover:border-brand-violet hover:text-brand-violet disabled:opacity-50"
            >
              Submit to Meta
            </button>
          )}
          {tpl.approvalStatus === "pending" && <span className="text-[12px] text-mute">Awaiting Meta…</span>}
        </td>
      </tr>
      {(err || askSubmit) && (
        <tr className="border-b border-rule bg-warm/20">
          <td colSpan={5} className="px-4 py-3">
            {err && <div className="mb-2 text-[12.5px] text-state-warn">{err}</div>}
            {askSubmit && <SubmitForm friendlyName={tpl.friendlyName} onCancel={() => setAskSubmit(false)} onSubmit={submit} busy={busy} />}
          </td>
        </tr>
      )}
    </>
  );
}

function SubmitForm({
  friendlyName, onCancel, onSubmit, busy,
}: {
  friendlyName: string;
  onCancel: () => void;
  onSubmit: (category: "MARKETING" | "UTILITY" | "AUTHENTICATION", displayName: string) => void;
  busy: boolean;
}) {
  const [category, setCategory] = useState<"MARKETING" | "UTILITY" | "AUTHENTICATION">("UTILITY");
  const [displayName, setDisplayName] = useState(friendlyName);
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <label className="mono-cap block text-[10px] text-hint">Category</label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as "MARKETING" | "UTILITY" | "AUTHENTICATION")}
          className="mt-1 rounded-md border border-rule bg-paper px-2 py-1.5 text-[12.5px]"
        >
          <option value="UTILITY">UTILITY (transactional)</option>
          <option value="MARKETING">MARKETING (promotional)</option>
          <option value="AUTHENTICATION">AUTHENTICATION (OTP)</option>
        </select>
      </div>
      <div className="flex-1 min-w-[240px]">
        <label className="mono-cap block text-[10px] text-hint">Display name (max 25 chars)</label>
        <input
          maxLength={25}
          value={displayName} onChange={(e) => setDisplayName(e.target.value)}
          className="mt-1 w-full rounded-md border border-rule bg-warm/40 px-2 py-1.5 text-[12.5px]"
        />
      </div>
      <button onClick={onCancel} disabled={busy} className="btn">Cancel</button>
      <button onClick={() => onSubmit(category, displayName)} disabled={busy || !displayName.trim()} className="btn-grad">
        {busy ? "Submitting…" : "Submit"}
      </button>
    </div>
  );
}

function NewTemplateDialog({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [friendlyName, setFriendlyName] = useState("");
  const [language, setLanguage]         = useState("en");
  const [body, setBody]                 = useState("");
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState<string | null>(null);

  // Parse {{placeholder}} tokens out of the body for the sample-vars form.
  const varNames = Array.from(new Set(
    [...body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]),
  ));
  const [samples, setSamples] = useState<Record<string, string>>({});

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await createWaTemplate({
        friendlyName: friendlyName.trim(),
        language,
        types: { "twilio/text": { body } },
        variables: Object.fromEntries(varNames.map((n) => [n, samples[n] ?? ""])),
      });
      onCreated();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="my-12 w-full max-w-[560px] rounded-2xl border border-rule bg-paper p-6 shadow-card">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="font-serif text-[22px] leading-tight tracking-[-.01em]">New template</h2>
            <p className="mt-1 text-[12.5px] text-mute">Text-only. Meta will review before it can be sent.</p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} className="rotate-45" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mono-cap block text-[10px] text-hint">Internal name</label>
            <input
              value={friendlyName} onChange={(e) => setFriendlyName(e.target.value)}
              placeholder="mba_reminder_v1"
              className="mt-1 w-full rounded-md border border-rule bg-warm/40 px-2 py-1.5 text-[12.5px]"
            />
          </div>
          <div>
            <label className="mono-cap block text-[10px] text-hint">Language</label>
            <input
              value={language} onChange={(e) => setLanguage(e.target.value)}
              placeholder="en / en_US / hi"
              className="mt-1 w-32 rounded-md border border-rule bg-warm/40 px-2 py-1.5 text-[12.5px]"
            />
          </div>
          <div>
            <label className="mono-cap block text-[10px] text-hint">
              Body — use <code className="rounded bg-warm px-1">{"{{name}}"}</code> for placeholders
            </label>
            <textarea
              value={body} onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder="Hi {{name}}, this is a reminder about {{program}} on {{date}}."
              className="mt-1 w-full resize-y rounded-md border border-rule bg-warm/40 px-2 py-1.5 text-[12.5px]"
            />
          </div>

          {varNames.length > 0 && (
            <div>
              <div className="mono-cap mb-1 text-[10px] text-hint">Sample values (used by Meta reviewers)</div>
              <div className="space-y-1.5">
                {varNames.map((n) => (
                  <div key={n} className="flex items-center gap-2">
                    <span className="mono-cap w-28 shrink-0 truncate text-[11px] text-mute">{n}</span>
                    <input
                      value={samples[n] ?? ""}
                      onChange={(e) => setSamples((prev) => ({ ...prev, [n]: e.target.value }))}
                      className="flex-1 rounded-md border border-rule bg-warm/40 px-2 py-1.5 text-[12.5px]"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {err && <div className="mt-3 rounded-md border border-state-warn/30 bg-state-warn/10 p-2 text-[12.5px] text-state-warn">{err}</div>}

        <div className="mt-5 flex items-center justify-end gap-3 border-t border-rule pt-4">
          <button onClick={onClose} disabled={busy} className="btn">Cancel</button>
          <button
            onClick={submit}
            disabled={busy || !friendlyName.trim() || !body.trim()}
            className="btn-grad disabled:opacity-60"
          >
            {busy ? "Creating…" : "Create draft"}
          </button>
        </div>
      </div>
    </div>
  );
}
