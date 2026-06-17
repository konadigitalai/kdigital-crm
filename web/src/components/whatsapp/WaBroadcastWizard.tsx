"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { WaTemplate } from "@/lib/types";
import { addWaBroadcastRecipients, createWaBroadcast } from "@/lib/api";

// Phone-list parsing for the CSV / paste path. Accepts:
// - comma, newline, semicolon-separated entries
// - one E.164 number per "row" or "phone, var1, var2, ..." for variables
function parsePastedRecipients(raw: string, variableCount: number): { phone: string; variables?: Record<string, string> }[] {
  const out: { phone: string; variables?: Record<string, string> }[] = [];
  const rows = raw.split(/\r?\n+/).map((s) => s.trim()).filter(Boolean);
  for (const row of rows) {
    const parts = row.split(/[,\t;]+/).map((s) => s.trim());
    const phone = parts[0];
    if (!phone) continue;
    if (variableCount === 0 || parts.length === 1) { out.push({ phone }); continue; }
    const variables: Record<string, string> = {};
    for (let i = 1; i <= variableCount; i++) {
      if (parts[i]) variables[String(i)] = parts[i];
    }
    out.push({ phone, variables });
  }
  return out;
}

export function WaBroadcastWizard({
  approvedTemplates,
}: { approvedTemplates: WaTemplate[] }) {
  const router = useRouter();

  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState(approvedTemplates[0]?.id ?? "");
  const [defaultVars, setDefaultVars] = useState<Record<string, string>>({});
  const [scheduledAt, setScheduledAt] = useState<string>(""); // datetime-local string
  const [recipientsText, setRecipientsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const tpl = useMemo(() => approvedTemplates.find((t) => t.id === templateId), [approvedTemplates, templateId]);

  const preview = useMemo(() => {
    if (!tpl) return "";
    return tpl.bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, idx) => defaultVars[String(idx)] ?? `{{${idx}}}`);
  }, [tpl, defaultVars]);

  const parsedRecipients = useMemo(
    () => parsePastedRecipients(recipientsText, tpl?.variableCount ?? 0),
    [recipientsText, tpl?.variableCount],
  );

  async function handleCreate(opts: { sendNow: boolean }) {
    if (!tpl) { setErr("Pick a template"); return; }
    if (!name.trim()) { setErr("Give the broadcast a name"); return; }
    if (parsedRecipients.length === 0) { setErr("Add at least one recipient phone"); return; }

    setBusy(true); setErr(null);
    try {
      const { id } = await createWaBroadcast({
        name: name.trim(),
        templateId: tpl.id,
        defaultVariables: defaultVars,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
      });
      await addWaBroadcastRecipients(id, { entries: parsedRecipients });
      if (opts.sendNow) {
        const { sendWaBroadcast } = await import("@/lib/api");
        await sendWaBroadcast(id);
      }
      router.push(`/whatsapp/broadcasts/${id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  if (approvedTemplates.length === 0) {
    return (
      <div className="rounded-[14px] border border-state-amber/40 bg-state-amber/5 p-6 text-[13.5px] text-state-amber">
        No approved templates yet. Sync templates from{" "}
        <a href="/admin/integrations/whatsapp" className="font-semibold underline">Admin → Integrations → WhatsApp</a>{" "}
        before creating a broadcast.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
      <div className="space-y-6">
        {/* Step 1: name + template */}
        <section className="rounded-[14px] border border-rule bg-paper p-6">
          <h2 className="mb-4 text-[16px] font-semibold text-ink">1. Name + template</h2>
          <label className="mb-3 block">
            <span className="mono-cap mb-1 block text-[10px] font-semibold tracking-[.1em] text-mute">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="June re-engagement"
              className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-[13.5px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20" />
          </label>
          <label className="block">
            <span className="mono-cap mb-1 block text-[10px] font-semibold tracking-[.1em] text-mute">Template</span>
            <select value={templateId} onChange={(e) => { setTemplateId(e.target.value); setDefaultVars({}); }}
              className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-[13px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20">
              {approvedTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.templateName} · {t.language} · {t.category}</option>
              ))}
            </select>
          </label>
        </section>

        {/* Step 2: default variables */}
        {tpl && tpl.variableCount > 0 && (
          <section className="rounded-[14px] border border-rule bg-paper p-6">
            <h2 className="mb-2 text-[16px] font-semibold text-ink">2. Default variables</h2>
            <p className="mb-4 text-[12.5px] text-mute">
              Used for any recipient who doesn't provide their own value. Per-recipient overrides come from columns in the recipients block below.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {Array.from({ length: tpl.variableCount }, (_, i) => i + 1).map((idx) => (
                <label key={idx} className="block">
                  <span className="mono-cap mb-0.5 block text-[10px] font-semibold tracking-[.1em] text-mute">{`{{${idx}}}`}</span>
                  <input value={defaultVars[String(idx)] ?? ""}
                    onChange={(e) => setDefaultVars((p) => ({ ...p, [String(idx)]: e.target.value }))}
                    className="w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12.5px] text-ink focus:border-brand-violet focus:outline-none" />
                </label>
              ))}
            </div>
          </section>
        )}

        {/* Step 3: recipients */}
        <section className="rounded-[14px] border border-rule bg-paper p-6">
          <h2 className="mb-2 text-[16px] font-semibold text-ink">3. Recipients</h2>
          <p className="mb-2 text-[12.5px] text-mute">
            One per line. Use E.164 format (e.g. <code className="font-mono">+919876543210</code>).
            {tpl && tpl.variableCount > 0 && (
              <> Append <code className="font-mono">,var1,var2…</code> to override defaults: <code className="font-mono">+91…,Aarav,2 PM</code>.</>
            )}
          </p>
          <textarea value={recipientsText} onChange={(e) => setRecipientsText(e.target.value)}
            rows={8}
            placeholder={"+919876543210\n+919812345678,Aarav,Tomorrow"}
            className="w-full rounded-md border border-rule bg-paper px-3 py-2 font-mono text-[12.5px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20" />
          <div className="mt-2 text-[12px] text-mute">
            <b className="text-ink">{parsedRecipients.length}</b> recipient{parsedRecipients.length === 1 ? "" : "s"} parsed.
          </div>
        </section>

        {/* Step 4: schedule */}
        <section className="rounded-[14px] border border-rule bg-paper p-6">
          <h2 className="mb-2 text-[16px] font-semibold text-ink">4. Schedule</h2>
          <p className="mb-2 text-[12.5px] text-mute">Leave blank to send immediately when you click Send. Otherwise, the worker picks it up at the chosen time.</p>
          <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)}
            className="rounded-md border border-rule bg-paper px-3 py-2 text-[13px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20" />
        </section>

        {err && <div className="rounded-md border border-state-bad/40 bg-state-bad/5 px-3 py-2 text-[12.5px] text-state-bad">{err}</div>}

        <div className="flex items-center justify-end gap-2">
          <button onClick={() => handleCreate({ sendNow: false })} disabled={busy}
            className="rounded-md border border-rule bg-paper px-4 py-2 text-[13px] font-semibold text-ink hover:border-rule2 disabled:opacity-50">
            {busy ? "Saving…" : "Save as draft"}
          </button>
          <button onClick={() => handleCreate({ sendNow: !scheduledAt })} disabled={busy}
            className="rounded-md bg-brand-violet px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
            {busy ? "Working…" : scheduledAt ? "Schedule" : "Send now"}
          </button>
        </div>
      </div>

      {/* Live preview */}
      <aside>
        <div className="sticky top-[80px] rounded-[14px] border border-rule bg-paper p-6">
          <h3 className="mb-3 text-[14px] font-semibold text-ink">Preview</h3>
          {tpl ? (
            <>
              <div className="mb-3 text-[11px] text-hint">Template body with variables filled with defaults.</div>
              <div className="rounded-md border border-rule bg-warm/40 p-3 text-[12.5px] leading-[1.45] text-ink whitespace-pre-line">
                {preview}
              </div>
              {tpl.footerText && <div className="mt-2 text-[11px] italic text-mute">{tpl.footerText}</div>}
            </>
          ) : <div className="text-[13px] text-mute">Select a template.</div>}
        </div>
      </aside>
    </div>
  );
}
