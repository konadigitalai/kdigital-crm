"use client";

// Quick-send modal for a lead. Header button on the record page.
// Two send modes:
//   1. Free-form — SMS or WhatsApp inside the 24h session window.
//   2. Template — WhatsApp only, pick a Meta-approved template and fill in
//      any placeholders. Required for outbound outside the WhatsApp session.
// Shares no state with the Inbox — this fires a one-off /twilio/send.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  sendTwMessageToLead,
  listWaTemplates,
  syncWaTemplates,
  type WaTemplate,
} from "@/lib/api";
import type { MediaAsset, TwChannel } from "@/lib/types";
import { AttachmentPicker } from "@/components/media/AttachmentPicker";
import { StagedStrip } from "@/components/media/StagedStrip";

type SendMode = "freeform" | "template";

export function SendMessageButton({
  leadNumber,
  leadPhone,
  canUpload = false,
  canAddToLibrary = false,
  className,
}: {
  leadNumber: string;
  leadPhone: string | null | undefined;
  canUpload?: boolean;
  canAddToLibrary?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!leadPhone}
        title={leadPhone ? "" : "No phone number on this lead"}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-[9px] border border-rule bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-ink2 transition",
          leadPhone
            ? "hover:border-brand-violet hover:text-brand-violet"
            : "cursor-not-allowed opacity-50",
          className,
        )}
      >
        <Icon name="message-square" size={12} strokeWidth={2.2} />
        Send message
      </button>
      {open && leadPhone && (
        <SendMessageDialog
          leadNumber={leadNumber}
          leadPhone={leadPhone}
          canUpload={canUpload}
          canAddToLibrary={canAddToLibrary}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function SendMessageDialog({
  leadNumber, leadPhone, canUpload, canAddToLibrary, onClose,
}: {
  leadNumber: string;
  leadPhone: string;
  canUpload: boolean;
  canAddToLibrary: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [channel, setChannel] = useState<TwChannel>("whatsapp");
  const [mode, setMode] = useState<SendMode>("freeform");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | { channel: TwChannel; providerMessageId: string | null }>(null);
  const [staged, setStaged] = useState<MediaAsset[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Template state
  const [templates, setTemplates] = useState<WaTemplate[] | null>(null);
  const [templatesErr, setTemplatesErr] = useState<string | null>(null);
  const [selectedTpl, setSelectedTpl] = useState<WaTemplate | null>(null);
  const [tplVars, setTplVars] = useState<Record<string, string>>({});
  const [syncing, setSyncing] = useState(false);

  // Templates are WhatsApp-only. If the user flips to SMS while in template
  // mode, snap them back to freeform.
  useEffect(() => {
    if (channel === "sms" && mode === "template") setMode("freeform");
  }, [channel, mode]);

  // Load templates lazily — only when Template mode is chosen.
  useEffect(() => {
    if (mode !== "template" || templates !== null) return;
    (async () => {
      try {
        const list = await listWaTemplates({ onlyApproved: true });
        setTemplates(list);
      } catch (err) {
        setTemplatesErr((err as Error).message);
      }
    })();
  }, [mode, templates]);

  async function refreshTemplates() {
    if (syncing) return;
    setSyncing(true);
    setTemplatesErr(null);
    try {
      await syncWaTemplates();
      const list = await listWaTemplates({ onlyApproved: true });
      setTemplates(list);
    } catch (err) {
      setTemplatesErr((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  function pickTemplate(tpl: WaTemplate) {
    setSelectedTpl(tpl);
    // Seed the variable map from Twilio's sample values so the preview
    // doesn't render empty placeholders on first load.
    const seed: Record<string, string> = {};
    for (const name of tpl.variables.names) {
      seed[name] = tpl.variables.samples?.[name] ?? "";
    }
    setTplVars(seed);
  }

  async function submit() {
    if (busy) return;
    if (mode === "template") {
      if (!selectedTpl) { setError("Pick a template first"); return; }
      // Every declared variable must have a value — Twilio errors on
      // undefined placeholders with a cryptic template rejection.
      const missing = selectedTpl.variables.names.filter((n) => !tplVars[n]?.trim());
      if (missing.length > 0) {
        setError(`Fill in: ${missing.join(", ")}`);
        return;
      }
    } else {
      const text = body.trim();
      if (!text && staged.length === 0) return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await sendTwMessageToLead(
        mode === "template" && selectedTpl
          ? {
              channel: "whatsapp",
              to: leadNumber,
              body: "",
              contentSid: selectedTpl.contentSid,
              contentVariables: tplVars,
            }
          : {
              channel,
              to: leadNumber,
              body: body.trim(),
              mediaAssetIds: staged.map((a) => a.id),
            },
      );
      if (!r.ok) {
        setError(r.errorMessage ?? `Send failed${r.errorCode ? ` (${r.errorCode})` : ""}`);
        return;
      }
      setDone({ channel: mode === "template" ? "whatsapp" : channel, providerMessageId: r.providerMessageId });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Preview: render the first available type block with placeholders swapped.
  function templatePreview(tpl: WaTemplate, vars: Record<string, string>): string {
    const firstBody = extractTemplateBody(tpl);
    if (!firstBody) return "";
    return firstBody.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, k) => vars[k.trim()] || `{{${k.trim()}}}`);
  }

  const canSubmit =
    !busy &&
    (mode === "template"
      ? !!selectedTpl && selectedTpl.variables.names.every((n) => (tplVars[n] ?? "").trim().length > 0)
      : body.trim().length > 0 || staged.length > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="my-12 w-full max-w-[560px] rounded-2xl border border-rule bg-paper p-6 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[22px] font-normal leading-tight tracking-[-.01em]">Send message</h2>
            <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">
              To {leadPhone} · {leadNumber}
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>

        {done ? (
          <div className="rounded-[12px] border border-state-ok/30 bg-state-ok/10 p-4 text-center">
            <Icon name="check" size={20} strokeWidth={2.2} className="mx-auto mb-2 text-state-ok" />
            <div className="text-[14px] font-semibold text-ink">Message sent</div>
            <div className="mt-1 text-[12.5px] text-mute">
              via Twilio {done.channel === "whatsapp" ? "WhatsApp" : "SMS"}
              {done.providerMessageId ? ` · ${done.providerMessageId}` : ""}.
            </div>
            <button
              type="button"
              onClick={onClose}
              className="mt-4 rounded-md border border-rule bg-paper px-4 py-1.5 text-[12.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <div className="inline-flex rounded-full border border-rule bg-paper p-1 text-[12.5px]">
                <ChannelToggle active={channel === "whatsapp"} onClick={() => setChannel("whatsapp")}>WhatsApp</ChannelToggle>
                <ChannelToggle active={channel === "sms"}      onClick={() => setChannel("sms")}>SMS</ChannelToggle>
              </div>
              {channel === "whatsapp" && (
                <div className="inline-flex rounded-full border border-rule bg-paper p-1 text-[12.5px]">
                  <ChannelToggle active={mode === "freeform"} onClick={() => setMode("freeform")}>Free-form</ChannelToggle>
                  <ChannelToggle active={mode === "template"} onClick={() => setMode("template")}>Template</ChannelToggle>
                </div>
              )}
            </div>

            {mode === "freeform" ? (
              <>
                <textarea
                  autoFocus
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={4}
                  placeholder={channel === "whatsapp"
                    ? "Hi — following up on your enquiry. Do you have 5 minutes for a quick call?"
                    : "Hi — following up on your enquiry."}
                  className="w-full resize-y rounded-[10px] border border-rule bg-warm/40 p-3 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
                />
                <p className="mono-cap mt-1 text-[10px] tracking-[.04em] text-hint">
                  {channel === "whatsapp"
                    ? "Free-form only works inside a 24h window from the customer's last reply. Outside that, use a template."
                    : "Standard SMS. Character limits and cost per segment apply on the Twilio side."}
                </p>

                {staged.length > 0 && (
                  <StagedStrip
                    assets={staged}
                    onRemove={(id) => setStaged((prev) => prev.filter((a) => a.id !== id))}
                    className="mt-3"
                  />
                )}

                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPickerOpen(true)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12px] font-semibold text-ink2 transition hover:border-brand-violet hover:text-brand-violet"
                  >
                    <Icon name="plus" size={12} strokeWidth={2.2} />
                    Attach file
                  </button>
                  <span className="mono-cap text-[10px] tracking-[.04em] text-hint">
                    Up to 10 attachments per message.
                  </span>
                </div>
              </>
            ) : (
              <TemplateEditor
                templates={templates}
                templatesErr={templatesErr}
                selected={selectedTpl}
                onPick={pickTemplate}
                vars={tplVars}
                onVarsChange={setTplVars}
                onRefresh={refreshTemplates}
                syncing={syncing}
                previewFor={templatePreview}
              />
            )}

            {error && (
              <div className="mt-3 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
                {error}
              </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-3 border-t border-rule pt-4">
              <button type="button" onClick={onClose} disabled={busy} className="btn">Cancel</button>
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className="btn-grad disabled:opacity-60"
              >
                {busy
                  ? "Sending…"
                  : mode === "template"
                    ? "Send template"
                    : `Send ${channel === "whatsapp" ? "WhatsApp" : "SMS"}`}
              </button>
            </div>
          </>
        )}
      </div>
      {pickerOpen && (
        <AttachmentPicker
          channel={channel}
          canUpload={canUpload}
          canAddToLibrary={canAddToLibrary}
          onSelected={(asset) => {
            if (staged.length >= 10) {
              setError("You can attach at most 10 files per message.");
            } else if (!staged.some((a) => a.id === asset.id)) {
              setStaged((prev) => [...prev, asset]);
            }
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function TemplateEditor({
  templates, templatesErr, selected, onPick, vars, onVarsChange, onRefresh, syncing, previewFor,
}: {
  templates: WaTemplate[] | null;
  templatesErr: string | null;
  selected: WaTemplate | null;
  onPick: (tpl: WaTemplate) => void;
  vars: Record<string, string>;
  onVarsChange: (next: Record<string, string>) => void;
  onRefresh: () => void;
  syncing: boolean;
  previewFor: (tpl: WaTemplate, vars: Record<string, string>) => string;
}) {
  if (templatesErr) {
    return (
      <div className="rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
        Couldn't load templates: {templatesErr}
        <button type="button" onClick={onRefresh} className="ml-2 underline">Retry</button>
      </div>
    );
  }
  if (templates === null) {
    return <div className="text-[12.5px] text-mute">Loading templates…</div>;
  }
  if (templates.length === 0) {
    return (
      <div className="rounded-lg border border-rule bg-warm/40 p-3 text-[12.5px] text-mute">
        No approved templates on the account yet.{" "}
        <button type="button" onClick={onRefresh} disabled={syncing} className="underline">
          {syncing ? "Syncing…" : "Refresh from Twilio"}
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div>
        <label className="mono-cap block text-[10px] tracking-[.04em] text-hint">Template</label>
        <div className="mt-1 flex items-center gap-2">
          <select
            value={selected?.contentSid ?? ""}
            onChange={(e) => {
              const tpl = templates.find((t) => t.contentSid === e.target.value);
              if (tpl) onPick(tpl);
            }}
            className="w-full rounded-[10px] border border-rule bg-paper px-3 py-2 text-[13px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
          >
            <option value="" disabled>Pick a template…</option>
            {templates.map((t) => (
              <option key={t.contentSid} value={t.contentSid}>
                {t.friendlyName} {t.language ? `· ${t.language}` : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onRefresh}
            disabled={syncing}
            title="Re-sync from Twilio Content Builder"
            className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper px-2 py-1.5 text-[11px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet disabled:opacity-50"
          >
            {syncing ? "…" : "Sync"}
          </button>
        </div>
      </div>

      {selected && selected.variables.names.length > 0 && (
        <div>
          <label className="mono-cap block text-[10px] tracking-[.04em] text-hint">Variables</label>
          <div className="mt-1 space-y-1.5">
            {selected.variables.names.map((name) => (
              <div key={name} className="flex items-center gap-2">
                <span className="mono-cap w-28 shrink-0 truncate text-[11px] text-mute" title={name}>{name}</span>
                <input
                  type="text"
                  value={vars[name] ?? ""}
                  onChange={(e) => onVarsChange({ ...vars, [name]: e.target.value })}
                  placeholder={selected.variables.samples?.[name] ?? ""}
                  className="flex-1 rounded-md border border-rule bg-warm/40 px-2 py-1.5 text-[12.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {selected && (
        <div>
          <label className="mono-cap block text-[10px] tracking-[.04em] text-hint">Preview</label>
          <div className="mt-1 whitespace-pre-wrap rounded-[10px] border border-rule bg-warm/40 p-3 text-[13px] text-ink">
            {previewFor(selected, vars) || <span className="text-mute">(no body)</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function ChannelToggle({
  active, onClick, children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-semibold transition",
        active ? "bg-ink text-white" : "text-ink2 hover:bg-warm",
      )}
    >
      {children}
    </button>
  );
}

/** Best-effort body extractor for the small number of template shapes we
 *  actually surface. Falls back to empty string if the type doesn't have a
 *  clear "body" — Meta's own approval UI is the canonical preview anyway. */
function extractTemplateBody(tpl: WaTemplate): string {
  const types = tpl.types ?? {};
  for (const t of Object.values(types)) {
    if (t && typeof t === "object" && "body" in t && typeof (t as { body?: unknown }).body === "string") {
      return String((t as { body: string }).body);
    }
  }
  return "";
}
