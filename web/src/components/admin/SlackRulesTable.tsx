"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  createSlackRule,
  deleteSlackRule,
  getSlackDeliveries,
  testSlackRule,
  updateSlackRule,
} from "@/lib/api";
import type { CatalogResponse, SlackDelivery, SlackEventType, SlackRule } from "@/lib/types";

type EventOption = CatalogResponse["slackEvents"][number];

type Mode =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "editing"; rule: SlackRule };

const EVENT_LABELS: Record<SlackEventType, string> = {
  "lead.created": "Lead created",
  "case.opened":  "Case opened",
  "case.closed":  "Case closed",
};

export function SlackRulesTable({
  initial,
  deliveries: initialDeliveries,
  eventTypes,
  canManage,
}: {
  initial: SlackRule[];
  deliveries: SlackDelivery[];
  eventTypes: EventOption[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [rules, setRules] = useState<SlackRule[]>(initial);
  const [deliveries, setDeliveries] = useState<SlackDelivery[]>(initialDeliveries);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testFlash, setTestFlash] = useState<string | null>(null);

  function reload() { router.refresh(); }

  async function refreshDeliveries() {
    try {
      const next = await getSlackDeliveries(20);
      setDeliveries(next);
    } catch {
      /* non-fatal */
    }
  }

  async function onCreate(input: SlackRuleFormValue) {
    setBusy("create");
    setError(null);
    try {
      const created = await createSlackRule({
        name: input.name,
        eventType: input.eventType,
        enabled: input.enabled,
        webhookUrl: input.webhookUrl,
        channel: input.channel || null,
        template: input.template || null,
        filter: input.filter,
      });
      setRules((all) => [...all, created]);
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onSaveEdit(rule: SlackRule, input: SlackRuleFormValue) {
    setBusy(rule.id);
    setError(null);
    try {
      const updated = await updateSlackRule(rule.id, {
        name: input.name,
        eventType: input.eventType,
        enabled: input.enabled,
        webhookUrl: input.webhookUrl,
        channel: input.channel || null,
        template: input.template || null,
        filter: input.filter,
      });
      setRules((all) => all.map((x) => (x.id === rule.id ? updated : x)));
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onToggleEnabled(rule: SlackRule) {
    if (!canManage) return;
    setBusy(rule.id);
    setError(null);
    const next = !rule.enabled;
    setRules((all) => all.map((x) => (x.id === rule.id ? { ...x, enabled: next } : x))); // optimistic
    try {
      await updateSlackRule(rule.id, { enabled: next });
    } catch (err) {
      // rollback
      setRules((all) => all.map((x) => (x.id === rule.id ? { ...x, enabled: !next } : x)));
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(rule: SlackRule) {
    if (!confirm(`Delete rule "${rule.name}"? This cannot be undone.`)) return;
    setBusy(rule.id);
    setError(null);
    try {
      await deleteSlackRule(rule.id);
      setRules((all) => all.filter((x) => x.id !== rule.id));
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onTest(rule: SlackRule) {
    setBusy(rule.id);
    setError(null);
    setTestFlash(null);
    try {
      const r = await testSlackRule(rule.id);
      const status = r.lastDelivery?.status ?? (r.ok ? "ok" : "error");
      const httpStatus = r.lastDelivery?.httpStatus ?? null;
      setTestFlash(
        status === "ok"
          ? `✓ Test sent for "${rule.name}" — Slack accepted (HTTP ${httpStatus ?? "?"}).`
          : `✗ Test failed for "${rule.name}" — HTTP ${httpStatus ?? "?"}: ${r.lastDelivery?.response ?? "no response"}`,
      );
      await refreshDeliveries();
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
          {rules.length} rule{rules.length === 1 ? "" : "s"}
        </div>
        {canManage && (
          <button onClick={() => setMode({ kind: "creating" })} className="btn-grad">
            <Icon name="plus" size={14} strokeWidth={2.2} /> New rule
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <Row hdr>
          <div>Rule</div>
          <div>Event</div>
          <div>Channel</div>
          <div className="text-center">Enabled</div>
          <div className="text-right">Actions</div>
        </Row>

        {rules.length === 0 ? (
          <div className="px-[22px] py-10 text-center text-[13px] text-mute">
            No Slack rules yet.{canManage && " Click \"New rule\" to add one."}
          </div>
        ) : (
          rules.map((rule) => (
            <Row key={rule.id}>
              <div className="min-w-0">
                <div className="text-[14px] font-semibold tracking-[-.005em]">{rule.name}</div>
                <div className="mono-cap mt-0.5 truncate text-[10px] tracking-[.04em] text-mute">
                  {rule.webhookUrl ? maskWebhook(rule.webhookUrl) : "no webhook"}
                </div>
              </div>
              <div className="text-[13px]">{EVENT_LABELS[rule.eventType] ?? rule.eventType}</div>
              <div className="truncate text-[13px] text-ink2">
                {rule.channel || <span className="text-hint">—</span>}
              </div>
              <div className="text-center">
                <button
                  type="button"
                  disabled={!canManage || busy === rule.id}
                  onClick={() => onToggleEnabled(rule)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold tracking-wide",
                    rule.enabled
                      ? "border-state-ok/40 bg-state-ok/10 text-state-ok"
                      : "border-rule bg-warm2 text-mute",
                    !canManage && "cursor-not-allowed opacity-60",
                  )}
                >
                  {rule.enabled ? "ON" : "OFF"}
                </button>
              </div>
              <div className="flex items-center justify-end gap-1.5">
                <button
                  onClick={() => onTest(rule)}
                  disabled={!canManage || busy === rule.id}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet disabled:opacity-40"
                >
                  Test
                </button>
                <button
                  onClick={() => setMode({ kind: "editing", rule })}
                  disabled={!canManage}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet disabled:opacity-40"
                >
                  Edit
                </button>
                <button
                  onClick={() => onDelete(rule)}
                  disabled={!canManage || busy === rule.id}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-state-warn hover:border-state-warn disabled:opacity-40"
                >
                  Delete
                </button>
              </div>
            </Row>
          ))
        )}
      </div>

      {testFlash && (
        <div className="mt-4 rounded-lg border border-rule bg-warm2 px-3 py-2 text-[12.5px] text-ink2">
          {testFlash}
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
          {error}
        </div>
      )}

      {/* Recent deliveries */}
      <div className="mt-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-serif text-[22px] tracking-[-.005em]">Recent deliveries</h2>
          <span className="mono-cap text-[10px] tracking-[.04em] text-hint">
            Latest 20 attempts (success + failure)
          </span>
        </div>
        <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
          <DeliveryRow hdr>
            <div>Status</div>
            <div>Event</div>
            <div>Sent</div>
            <div>Response</div>
          </DeliveryRow>
          {deliveries.length === 0 ? (
            <div className="px-[22px] py-8 text-center text-[13px] text-mute">No deliveries yet.</div>
          ) : (
            deliveries.map((d) => (
              <DeliveryRow key={d.id}>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-[7px] w-[7px] flex-shrink-0 rounded-full",
                      d.status === "ok" ? "bg-state-ok" : "bg-state-warn",
                    )}
                  />
                  <span className="text-[12.5px] capitalize text-ink2">
                    {d.status}
                    {d.httpStatus ? ` · ${d.httpStatus}` : ""}
                  </span>
                </div>
                <div className="text-[13px]">{EVENT_LABELS[d.eventType] ?? d.eventType}</div>
                <div className="text-[12.5px] text-mute">{formatWhen(d.sentAt)}</div>
                <div className="truncate text-[12.5px] text-mute" title={d.response ?? ""}>
                  {d.response ?? "—"}
                </div>
              </DeliveryRow>
            ))
          )}
        </div>
      </div>

      {mode.kind === "creating" && (
        <SlackRuleFormDialog
          title="New Slack rule"
          submitLabel="Create"
          eventTypes={eventTypes}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={onCreate}
          busy={busy === "create"}
        />
      )}
      {mode.kind === "editing" && (
        <SlackRuleFormDialog
          title="Edit Slack rule"
          submitLabel="Save"
          eventTypes={eventTypes}
          initial={mode.rule}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(v) => onSaveEdit(mode.rule, v)}
          busy={busy === mode.rule.id}
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
      style={{ gridTemplateColumns: "2fr 130px 150px 90px 230px" }}
    >
      {children}
    </div>
  );
}

function DeliveryRow({
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
        hdr ? "mono-cap py-3 text-[9.5px] font-semibold tracking-[.12em] text-mute bg-warm" : "py-3",
      )}
      style={{ gridTemplateColumns: "120px 130px 160px 1fr" }}
    >
      {children}
    </div>
  );
}

// ─── Dialog ────────────────────────────────────────────────────────────────

interface SlackRuleFormValue {
  name: string;
  eventType: SlackEventType;
  enabled: boolean;
  webhookUrl: string;
  channel: string;
  template: string;
  filter: Record<string, unknown>;
}

function SlackRuleFormDialog({
  title,
  submitLabel,
  eventTypes,
  initial,
  onClose,
  onSubmit,
  busy,
}: {
  title: string;
  submitLabel: string;
  eventTypes: EventOption[];
  initial?: SlackRule;
  onClose: () => void;
  onSubmit: (v: SlackRuleFormValue) => void;
  busy: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [eventType, setEventType] = useState<SlackEventType>(
    initial?.eventType ?? eventTypes[0]?.type ?? "lead.created",
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [webhookUrl, setWebhookUrl] = useState(initial?.webhookUrl ?? "");
  const [channel, setChannel] = useState(initial?.channel ?? "");
  const [template, setTemplate] = useState(initial?.template ?? "");
  const [filterText, setFilterText] = useState(
    initial?.filter ? JSON.stringify(initial.filter, null, 2) : "",
  );
  const [localError, setLocalError] = useState<string | null>(null);

  const eventHint = useMemo(
    () => eventTypes.find((e) => e.type === eventType)?.hint,
    [eventType, eventTypes],
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (!name.trim()) return setLocalError("Name is required.");
    if (!webhookUrl.trim()) return setLocalError("Webhook URL is required.");
    if (!/^https:\/\/hooks\.slack\.com\/services\//.test(webhookUrl.trim())) {
      return setLocalError("Webhook URL must start with https://hooks.slack.com/services/");
    }
    let filter: Record<string, unknown> = {};
    if (filterText.trim()) {
      try {
        const parsed = JSON.parse(filterText);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("filter must be a JSON object");
        }
        filter = parsed as Record<string, unknown>;
      } catch (err) {
        return setLocalError(`Filter JSON is invalid: ${(err as Error).message}`);
      }
    }
    onSubmit({
      name: name.trim(),
      eventType,
      enabled,
      webhookUrl: webhookUrl.trim(),
      channel: channel.trim(),
      template,
      filter,
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="my-12 w-full max-w-[680px] rounded-2xl border border-rule bg-paper p-7 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[26px] font-normal leading-tight tracking-[-.01em]">{title}</h2>
            <p className="mt-1 text-[13px] leading-[1.5] text-mute">
              When the event fires (and the filter matches, if you set one), Slack will get a message at the webhook URL below.
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" required>
              <input
                className={inputCls}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. New leads → #sales-leads"
                autoFocus
              />
            </Field>
            <Field label="Event" required>
              <select
                className={inputCls}
                value={eventType}
                onChange={(e) => setEventType(e.target.value as SlackEventType)}
              >
                {eventTypes.map((evt) => (
                  <option key={evt.type} value={evt.type}>{evt.label}</option>
                ))}
              </select>
              {eventHint && (
                <span className="mono-cap mt-1 block text-[10px] tracking-[.04em] text-hint">{eventHint}</span>
              )}
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

          <div className="grid grid-cols-2 gap-4">
            <Field label="Channel (FYI label)">
              <input
                className={inputCls}
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                placeholder="#sales-leads"
              />
            </Field>
            <Field label="Status">
              <label className="flex h-[42px] items-center gap-2 rounded-[10px] border border-rule bg-paper px-3 text-[13.5px] text-ink">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-brand-violet"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span>Enabled — fire on matching events</span>
              </label>
            </Field>
          </div>

          <Field label="Filter (optional JSON)">
            <textarea
              className={cn(inputCls, "font-mono text-[12px]")}
              rows={3}
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder='e.g. {"category":["billing","refund"]} or {"priority_lte":2}'
            />
            <span className="mono-cap mt-1 block text-[10px] tracking-[.04em] text-hint">
              Equality, array membership, and <code className="font-mono">_lte</code> on numeric fields are supported. Leave empty to match every event.
            </span>
          </Field>

          <Field label="Message template (optional)">
            <textarea
              className={cn(inputCls, "font-mono text-[12px]")}
              rows={3}
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder="e.g. New {{stage}} lead {{number}}: {{name}} ({{program}})"
            />
            <span className="mono-cap mt-1 block text-[10px] tracking-[.04em] text-hint">
              Use <code className="font-mono">{`{{var}}`}</code> for substitution. Leave empty for the default block-formatted message.
            </span>
          </Field>

          {localError && (
            <div className="rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
              {localError}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 border-t border-rule pt-4">
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
  // Show host + last 4 chars of secret only.
  try {
    const u = new URL(url);
    const tail = u.pathname.slice(-4);
    return `${u.host}/…/${tail}`;
  } catch {
    return url.slice(0, 20) + "…";
  }
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
  }
  return d.toLocaleString("en-IN", {
    day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
  });
}
