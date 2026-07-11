"use client";

// New-campaign wizard.
//
// Four sections stacked in one form:
//   1. Basics       — name, template pick
//   2. Variables    — per-placeholder binding (literal OR {{field}} path)
//   3. Audience     — simple rule builder + live preview count
//   4. Schedule     — send-now / scheduled-at + rate + daily cap
//
// Submit does: POST /campaigns to save a draft, then POST /campaigns/:id/schedule.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  listWaTemplates, previewCampaignAudience, createCampaign, scheduleCampaign,
  getAudienceFields,
  type WaTemplate, type FilterState, type AudiencePreview,
} from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";

const OPERATORS: Array<{ key: string; label: string }> = [
  { key: "is",           label: "is" },
  { key: "is_not",       label: "is not" },
  { key: "contains",     label: "contains" },
  { key: "not_contains", label: "doesn't contain" },
  { key: "starts_with",  label: "starts with" },
  { key: "ends_with",    label: "ends with" },
  { key: "gt",           label: ">" },
  { key: "gte",          label: "≥" },
  { key: "lt",           label: "<" },
  { key: "lte",          label: "≤" },
  { key: "is_any_of",    label: "is any of (comma)" },
  { key: "is_none_of",   label: "is none of (comma)" },
  { key: "is_empty",     label: "is empty" },
  { key: "is_not_empty", label: "is not empty" },
];

const FIELD_PATH_SUGGESTIONS = [
  "{{party.name}}", "{{party.city}}", "{{lead.program}}", "{{lead.stage}}", "{{lead.number}}",
];

export function NewCampaignWizard() {
  const router = useRouter();

  // ── Basics ────────────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [templates, setTemplates] = useState<WaTemplate[] | null>(null);
  const [tpl, setTpl] = useState<WaTemplate | null>(null);

  useEffect(() => {
    (async () => {
      try { setTemplates(await listWaTemplates({ onlyApproved: true })); }
      catch { /* surface later in the UI via the empty-state */ }
    })();
  }, []);

  // ── Variable bindings ────────────────────────────────────────────────
  const [bindings, setBindings] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!tpl) return;
    const seed: Record<string, string> = {};
    for (const n of tpl.variables.names) {
      seed[n] = tpl.variables.samples?.[n] ?? "";
    }
    setBindings(seed);
  }, [tpl]);

  // ── Audience ─────────────────────────────────────────────────────────
  const [fields, setFields] = useState<string[]>([]);
  useEffect(() => { getAudienceFields().then(setFields).catch(() => setFields([])); }, []);

  const [audience, setAudience] = useState<FilterState>({ combinator: "and", rules: [] });
  const [preview, setPreview]   = useState<AudiencePreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  async function refreshPreview() {
    setPreviewing(true);
    setPreviewErr(null);
    try {
      const p = await previewCampaignAudience(audience);
      setPreview(p);
    } catch (e) {
      setPreviewErr((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  }

  // ── Schedule ─────────────────────────────────────────────────────────
  const [sendRatePerSec, setSendRatePerSec] = useState(5);
  const [dailyCap, setDailyCap]             = useState<string>("");
  const [scheduledAt, setScheduledAt]       = useState<string>("");   // ISO local

  // ── Submit ───────────────────────────────────────────────────────────
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState<string | null>(null);

  async function submit(scheduleNow: boolean) {
    if (!tpl)     { setErr("Pick a template");    return; }
    if (!name.trim()) { setErr("Give it a name"); return; }
    const missing = tpl.variables.names.filter((n) => !bindings[n]?.trim());
    if (missing.length > 0) { setErr(`Bind variables: ${missing.join(", ")}`); return; }
    setBusy(true); setErr(null);
    try {
      const created = await createCampaign({
        name: name.trim(),
        contentSid: tpl.contentSid,
        contentVariableBindings: bindings,
        audience,
        sendRatePerSec,
        dailyCap: dailyCap.trim() ? Number(dailyCap) : null,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
      });
      if (scheduleNow) {
        await scheduleCampaign(created.id);
      }
      router.push(`/campaigns/${created.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canSchedule =
    !!tpl && name.trim().length > 0 &&
    tpl.variables.names.every((n) => (bindings[n] ?? "").trim().length > 0);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        {/* ── Basics ── */}
        <Section title="1. Basics">
          <Field label="Campaign name">
            <input
              value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Fall 2026 · MBA Aspirants · Batch A"
              className="w-full rounded-md border border-rule bg-warm/40 px-3 py-2 text-[13.5px] focus:border-brand-violet focus:outline-none"
            />
          </Field>
          <Field label="Template">
            {templates == null && <div className="text-[12.5px] text-mute">Loading templates…</div>}
            {templates && templates.length === 0 && (
              <div className="rounded-md border border-state-warn/30 bg-state-warn/10 p-3 text-[12.5px] text-state-warn">
                No approved templates. Create one in <a href="/templates" className="underline">/templates</a> and submit for Meta approval.
              </div>
            )}
            {templates && templates.length > 0 && (
              <select
                value={tpl?.contentSid ?? ""}
                onChange={(e) => { const t = templates.find((x) => x.contentSid === e.target.value); setTpl(t ?? null); }}
                className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-[13.5px] focus:border-brand-violet focus:outline-none"
              >
                <option value="" disabled>Pick a template…</option>
                {templates.map((t) => (
                  <option key={t.contentSid} value={t.contentSid}>
                    {t.friendlyName} {t.language ? `· ${t.language}` : ""}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </Section>

        {/* ── Variables ── */}
        {tpl && tpl.variables.names.length > 0 && (
          <Section title="2. Variables">
            <p className="mb-3 text-[12.5px] text-mute">
              Bind each placeholder to either a literal string or a lead field like{" "}
              <code className="mono-cap rounded bg-warm px-1.5 py-0.5 text-[10.5px]">{"{{party.name}}"}</code>.
            </p>
            <div className="space-y-2">
              {tpl.variables.names.map((n) => (
                <div key={n} className="flex items-center gap-2">
                  <span className="mono-cap w-28 shrink-0 truncate text-[11px] text-mute" title={n}>{n}</span>
                  <input
                    value={bindings[n] ?? ""}
                    onChange={(e) => setBindings((prev) => ({ ...prev, [n]: e.target.value }))}
                    placeholder={tpl.variables.samples?.[n] ?? ""}
                    className="flex-1 rounded-md border border-rule bg-warm/40 px-2 py-1.5 text-[12.5px] focus:border-brand-violet focus:outline-none"
                  />
                </div>
              ))}
              <details className="mt-1 text-[11.5px] text-mute">
                <summary className="cursor-pointer">Available field paths</summary>
                <ul className="mt-2 grid grid-cols-2 gap-1 pl-4">
                  {FIELD_PATH_SUGGESTIONS.map((p) => (
                    <li key={p} className="mono-cap text-[11px]">{p}</li>
                  ))}
                </ul>
              </details>
            </div>
          </Section>
        )}

        {/* ── Audience ── */}
        <Section
          title="3. Audience"
          right={
            <button
              type="button"
              onClick={refreshPreview}
              disabled={previewing}
              className="btn disabled:opacity-60"
            >
              {previewing ? "Counting…" : "Refresh preview"}
            </button>
          }
        >
          <AudienceBuilder
            fields={fields}
            audience={audience}
            onChange={setAudience}
          />
          {previewErr && (
            <div className="mt-3 rounded-md border border-state-warn/30 bg-state-warn/10 p-2 text-[12.5px] text-state-warn">{previewErr}</div>
          )}
          {preview && (
            <div className="mt-3 rounded-md border border-rule bg-warm/40 p-3 text-[12.5px] text-ink2">
              <div className="mb-2 font-semibold text-ink">Matches: {preview.count.toLocaleString("en-IN")}</div>
              {preview.sample.length > 0 && (
                <ul className="space-y-0.5">
                  {preview.sample.slice(0, 5).map((r) => (
                    <li key={r.partyId} className="truncate">
                      <span className="mono-cap text-[10px] text-mute">{r.leadNumber}</span>{" · "}
                      {r.name ?? "—"} · {r.phone ?? "—"} · {r.stage ?? "—"}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Section>

        {/* ── Schedule ── */}
        <Section title="4. Schedule">
          <Field label="Send rate (msg / sec)">
            <input
              type="number" min={1} max={100}
              value={sendRatePerSec}
              onChange={(e) => setSendRatePerSec(Math.max(1, Math.min(100, Number(e.target.value) || 5)))}
              className="w-32 rounded-md border border-rule bg-warm/40 px-3 py-2 text-[13.5px]"
            />
          </Field>
          <Field label="Daily cap (blank = unlimited)">
            <input
              type="number" min={1}
              value={dailyCap} onChange={(e) => setDailyCap(e.target.value)}
              placeholder="e.g. 500"
              className="w-40 rounded-md border border-rule bg-warm/40 px-3 py-2 text-[13.5px]"
            />
          </Field>
          <Field label="Start at (local time; blank = as soon as scheduled)">
            <input
              type="datetime-local"
              value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)}
              className="rounded-md border border-rule bg-warm/40 px-3 py-2 text-[13.5px]"
            />
          </Field>
        </Section>

        {err && (
          <div className="rounded-md border border-state-warn/30 bg-state-warn/10 p-3 text-[13px] text-state-warn">{err}</div>
        )}
      </div>

      {/* ── Sidebar / actions ── */}
      <div className="lg:col-span-1">
        <div className="sticky top-24 rounded-[14px] border border-rule bg-paper p-5">
          <h3 className="font-serif text-[20px] leading-none">Ready?</h3>
          <p className="mt-2 text-[12.5px] text-mute">
            Saving a draft is safe — the send won&apos;t start until you click <b>Schedule now</b>.
          </p>
          <div className="mt-4 flex flex-col gap-2">
            <button type="button" onClick={() => submit(false)} disabled={busy || !canSchedule} className="btn disabled:opacity-60">
              Save draft
            </button>
            <button type="button" onClick={() => submit(true)}  disabled={busy || !canSchedule} className="btn-grad disabled:opacity-60">
              {busy ? "Saving…" : "Save + Schedule now"}
            </button>
          </div>
          {tpl && (
            <div className="mt-4 rounded-md border border-rule bg-warm/40 p-3 text-[12px] text-ink2">
              <div className="mono-cap mb-1 text-[10px] text-mute">Template</div>
              <div className="font-semibold text-ink">{tpl.friendlyName}</div>
              <div className="mt-1 text-[11px] text-hint">{tpl.contentSid}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Presentational bits ────────────────────────────────────────────────

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-[14px] border border-rule bg-paper p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-serif text-[22px] leading-none tracking-[-.01em]">{title}</h2>
        {right}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <label className="mono-cap mb-1 block text-[10px] tracking-[.04em] text-hint">{label}</label>
      {children}
    </div>
  );
}

function AudienceBuilder({
  fields, audience, onChange,
}: {
  fields: string[];
  audience: FilterState;
  onChange: (next: FilterState) => void;
}) {
  const addRule = () => {
    onChange({
      ...audience,
      rules: [...audience.rules, { fieldKey: fields[0] ?? "stage", operator: "is", value: "" }],
    });
  };
  const removeRule = (i: number) => onChange({ ...audience, rules: audience.rules.filter((_, idx) => idx !== i) });
  const updateRule = (i: number, patch: Partial<{ fieldKey: string; operator: string; value: unknown }>) => {
    onChange({
      ...audience,
      rules: audience.rules.map((r, idx) => idx === i ? { ...r, ...patch } : r),
    });
  };
  return (
    <>
      {audience.rules.length === 0 && (
        <div className="rounded-md border border-dashed border-rule2 p-3 text-[12.5px] text-mute">
          No rules — the campaign will target every live lead.
        </div>
      )}
      <div className="space-y-2">
        {audience.rules.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <select
              value={r.fieldKey}
              onChange={(e) => updateRule(i, { fieldKey: e.target.value })}
              className="w-40 rounded-md border border-rule bg-paper px-2 py-1.5 text-[12.5px]"
            >
              {fields.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <select
              value={r.operator}
              onChange={(e) => updateRule(i, { operator: e.target.value })}
              className="w-40 rounded-md border border-rule bg-paper px-2 py-1.5 text-[12.5px]"
            >
              {OPERATORS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            {(r.operator === "is_any_of" || r.operator === "is_none_of") ? (
              <input
                type="text"
                value={Array.isArray(r.value) ? r.value.join(", ") : String(r.value ?? "")}
                onChange={(e) => updateRule(i, { value: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                placeholder="a, b, c"
                className="flex-1 rounded-md border border-rule bg-warm/40 px-2 py-1.5 text-[12.5px]"
              />
            ) : r.operator !== "is_empty" && r.operator !== "is_not_empty" ? (
              <input
                type="text"
                value={String(r.value ?? "")}
                onChange={(e) => updateRule(i, { value: e.target.value })}
                className="flex-1 rounded-md border border-rule bg-warm/40 px-2 py-1.5 text-[12.5px]"
              />
            ) : (
              <div className="flex-1" />
            )}
            <button
              type="button" onClick={() => removeRule(i)}
              className="rounded-md p-1.5 text-mute hover:bg-warm hover:text-state-warn"
              aria-label="Remove rule"
            >
              <Icon name="plus" size={14} className="rotate-45" />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button type="button" onClick={addRule} className="btn">Add rule</button>
        {audience.rules.length > 1 && (
          <label className="text-[12px] text-mute">
            Combine with{" "}
            <select
              value={audience.combinator}
              onChange={(e) => onChange({ ...audience, combinator: e.target.value as "and" | "or" })}
              className={cn("rounded-md border border-rule bg-paper px-2 py-1 text-[12px]")}
            >
              <option value="and">AND</option>
              <option value="or">OR</option>
            </select>
          </label>
        )}
      </div>
    </>
  );
}
