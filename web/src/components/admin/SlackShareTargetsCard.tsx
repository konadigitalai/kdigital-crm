"use client";

// Admin config for Slack manual share targets — one card per surface
// (leads / learners / cases). Each card has: enabled toggle, channel
// label, webhook URL, optional header template, and a checkbox grid of
// fields (whitelist of what gets included in the rendered message).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { deleteSlackShareTarget, upsertSlackShareTarget } from "@/lib/api";
import type { ShareSurface, SlackShareTarget } from "@/lib/types";

const SURFACE_LABELS: Record<ShareSurface, { title: string; hint: string }> = {
  leads:    { title: "Leads",    hint: "Sales pipeline records — lead pages." },
  learners: { title: "Learners", hint: "Enrolled learner profiles." },
  cases:    { title: "Cases",    hint: "Support cases — case detail page." },
};

export function SlackShareTargetsCard({
  initialTargets,
  fields,
  canManage,
}: {
  initialTargets: SlackShareTarget[];
  fields: Record<ShareSurface, { key: string; label: string }[]>;
  canManage: boolean;
}) {
  const [targets, setTargets] = useState<Record<ShareSurface, SlackShareTarget>>(() => {
    const m: Record<string, SlackShareTarget> = {};
    for (const t of initialTargets) m[t.surface] = t;
    return m as Record<ShareSurface, SlackShareTarget>;
  });

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {(Object.keys(SURFACE_LABELS) as ShareSurface[]).map((surface) => (
        <SurfaceCard
          key={surface}
          surface={surface}
          target={targets[surface]}
          allFields={fields[surface] ?? []}
          canManage={canManage}
          onSaved={(next) => setTargets((all) => ({ ...all, [surface]: next }))}
          onCleared={() =>
            setTargets((all) => ({
              ...all,
              [surface]: {
                ...all[surface],
                id: null,
                enabled: false,
                channel: null,
                webhookUrl: null,
              },
            }))
          }
        />
      ))}
    </div>
  );
}

function SurfaceCard({
  surface,
  target,
  allFields,
  canManage,
  onSaved,
  onCleared,
}: {
  surface: ShareSurface;
  target: SlackShareTarget;
  allFields: { key: string; label: string }[];
  canManage: boolean;
  onSaved: (next: SlackShareTarget) => void;
  onCleared: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const meta = SURFACE_LABELS[surface];

  return (
    <div className="rounded-2xl border border-rule bg-paper p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="font-serif text-[20px] tracking-[-.005em]">{meta.title}</div>
          <div className="mt-0.5 text-[12px] text-mute">{meta.hint}</div>
        </div>
        <span
          className={cn(
            "mono-cap rounded-full border px-2 py-0.5 text-[9.5px] font-semibold tracking-[.06em]",
            target.enabled && target.webhookUrl
              ? "border-state-ok/40 bg-state-ok/10 text-state-ok"
              : "border-rule bg-warm2 text-mute",
          )}
        >
          {target.enabled && target.webhookUrl ? "ON" : "OFF"}
        </span>
      </div>

      <div className="space-y-2.5 text-[13px]">
        <Row label="Channel" value={target.channel ?? <span className="text-hint">— not set —</span>} />
        <Row
          label="Webhook"
          value={target.webhookUrl ? maskWebhook(target.webhookUrl) : <span className="text-hint">— not set —</span>}
        />
        <Row
          label="Fields"
          value={
            target.fieldKeys.length > 0
              ? `${target.fieldKeys.length} of ${allFields.length}`
              : <span className="text-hint">none</span>
          }
        />
      </div>

      {canManage && (
        <div className="mt-4 flex justify-end gap-2">
          {target.id && (
            <button
              type="button"
              onClick={async () => {
                if (!confirm(`Clear Slack share config for ${meta.title}?`)) return;
                await deleteSlackShareTarget(surface);
                onCleared();
                router.refresh();
              }}
              className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-state-warn hover:border-state-warn"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
          >
            {target.id ? "Edit" : "Set up"}
          </button>
        </div>
      )}

      {editing && (
        <EditDialog
          surface={surface}
          target={target}
          allFields={allFields}
          onClose={() => setEditing(false)}
          onSaved={(next) => {
            onSaved(next);
            setEditing(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-dashed border-rule py-1.5 last:border-b-0">
      <span className="font-medium text-mute">{label}</span>
      <span className="min-w-0 truncate text-right text-ink">{value}</span>
    </div>
  );
}

function EditDialog({
  surface,
  target,
  allFields,
  onClose,
  onSaved,
}: {
  surface: ShareSurface;
  target: SlackShareTarget;
  allFields: { key: string; label: string }[];
  onClose: () => void;
  onSaved: (t: SlackShareTarget) => void;
}) {
  const [enabled, setEnabled]       = useState(target.enabled);
  const [channel, setChannel]       = useState(target.channel ?? "");
  const [webhookUrl, setWebhookUrl] = useState(target.webhookUrl ?? "");
  const [fieldKeys, setFieldKeys]   = useState<Set<string>>(() => new Set(target.fieldKeys));
  const [busy, setBusy]             = useState(false);
  const [error, setError]           = useState<string | null>(null);

  function toggleField(k: string) {
    setFieldKeys((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  }

  async function save() {
    setError(null);
    if (!webhookUrl.trim()) return setError("Webhook URL is required.");
    if (!/^https:\/\/hooks\.slack\.com\/services\//.test(webhookUrl.trim())) {
      return setError("Webhook URL must start with https://hooks.slack.com/services/");
    }
    if (fieldKeys.size === 0) {
      return setError("Pick at least one field — otherwise the message would be empty.");
    }
    setBusy(true);
    try {
      const next = await upsertSlackShareTarget({
        surface,
        enabled,
        webhookUrl: webhookUrl.trim(),
        channel: channel.trim() || null,
        fieldKeys: Array.from(fieldKeys),
      });
      onSaved(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const meta = SURFACE_LABELS[surface];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="my-12 w-full max-w-[700px] rounded-2xl border border-rule bg-paper p-7 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[24px] font-normal leading-tight tracking-[-.01em]">{meta.title} → Slack</h2>
            <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">{meta.hint}</p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>

        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Status">
              <label className="flex h-[42px] items-center gap-2 rounded-[10px] border border-rule bg-paper px-3 text-[13.5px] text-ink">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-brand-violet"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span>Enabled</span>
              </label>
            </Field>
            <Field label="Channel (FYI label)">
              <input
                className={inputCls}
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                placeholder="#sales-leads"
              />
            </Field>
          </div>

          <Field label="Webhook URL" required>
            <input
              className={inputCls}
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://hooks.slack.com/services/T0…/B0…/…"
            />
            <span className="mono-cap mt-1 block text-[10px] tracking-[.04em] text-hint">
              Generate one in your Slack app's "Incoming Webhooks" config. The channel is set there, not here.
            </span>
          </Field>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">
                Fields to include
              </span>
              <span className="mono-cap text-[10px] tracking-[.04em] text-hint">
                {fieldKeys.size} of {allFields.length} selected
              </span>
            </div>
            <div className="grid max-h-[260px] grid-cols-2 gap-1.5 overflow-y-auto rounded-[10px] border border-rule bg-warm/30 p-3">
              {allFields.map((f) => {
                const on = fieldKeys.has(f.key);
                return (
                  <label
                    key={f.key}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12.5px] transition",
                      on
                        ? "border-brand-violet/40 bg-brand-violet/[.06] text-ink"
                        : "border-rule bg-paper text-ink2 hover:border-rule2",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-brand-violet"
                      checked={on}
                      onChange={() => toggleField(f.key)}
                    />
                    <span>{f.label}</span>
                  </label>
                );
              })}
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 border-t border-rule pt-4">
            <button type="button" onClick={onClose} className="btn">Cancel</button>
            <button type="button" onClick={save} disabled={busy} className="btn-grad disabled:opacity-60">
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
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

function maskWebhook(url: string): string {
  try {
    const u = new URL(url);
    const tail = u.pathname.slice(-4);
    return `${u.host}/…/${tail}`;
  } catch {
    return url.slice(0, 20) + "…";
  }
}
