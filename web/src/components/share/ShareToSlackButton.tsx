"use client";

// "Share to Slack" button + dialog. Drop into any record page (lead,
// learner, case).
//
// UX flow (2026-07-07 rework):
//   1. Click the button → dialog opens on the "destination picker" step.
//   2. Pick "Channel" or "Person". Search box + list.
//   3. Once a target is picked → preview + notes + Send.
//
// Legacy fallback: if the workspace has no bot token yet, the dialog
// skips straight to the preview and posts via the pre-configured
// webhook. That way an admin who hasn't set up bot-based sharing yet
// still gets the old behaviour.

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  getSharePreview, getSlackDirectory, getSlackWorkspace, shareToSlack,
  type SlackDirectoryChannel, type SlackDirectoryUser,
} from "@/lib/api";
import type { ShareSurface, SlackSharePreview } from "@/lib/types";

type Destination = { kind: "channel" | "user"; id: string; name: string };

export function ShareToSlackButton({
  surface,
  recordId,
  label = "Share to Slack",
  className,
}: {
  surface: ShareSurface;
  recordId: string;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-[9px] border border-rule bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-ink2 transition hover:border-brand-violet hover:text-brand-violet",
          className,
        )}
      >
        <Icon name="send" size={12} strokeWidth={2.2} />
        {label}
      </button>
      {open && (
        <ShareToSlackDialog
          surface={surface}
          recordId={recordId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// ─── Dialog with three stages: pick-kind → pick-target → preview+send ──

type Stage =
  | { name: "loading-workspace" }
  | { name: "pick-kind" }
  | { name: "pick-target"; kind: "channel" | "user" }
  | { name: "preview"; destination: Destination | null } // null = legacy webhook
  | { name: "done"; destinationLabel: string };

function ShareToSlackDialog({
  surface,
  recordId,
  onClose,
}: {
  surface: ShareSurface;
  recordId: string;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ name: "loading-workspace" });
  const [hasBotToken, setHasBotToken] = useState(false);

  // Determine on mount whether bot-based sharing is available.
  useEffect(() => {
    let cancelled = false;
    getSlackWorkspace()
      .then((r) => {
        if (cancelled) return;
        const bot = !!r.workspace?.hasToken;
        setHasBotToken(bot);
        setStage(bot ? { name: "pick-kind" } : { name: "preview", destination: null });
      })
      .catch(() => { if (!cancelled) setStage({ name: "preview", destination: null }); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="my-12 w-full max-w-[640px] rounded-2xl border border-rule bg-paper p-7 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[24px] font-normal leading-tight tracking-[-.01em]">Share to Slack</h2>
            <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">
              {stage.name === "pick-kind" && "Pick where this goes — a channel or a person."}
              {stage.name === "pick-target" && `Pick a ${stage.kind === "channel" ? "channel" : "person"}.`}
              {stage.name === "preview" && (stage.destination ? "Review and send." : "Sending to the channel configured by your admin.")}
              {stage.name === "loading-workspace" && "Preparing…"}
              {stage.name === "done" && "Sent."}
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>

        {stage.name === "loading-workspace" && (
          <div className="my-10 text-center text-[13px] text-mute">Loading…</div>
        )}

        {stage.name === "pick-kind" && (
          <PickKind onPick={(kind) => setStage({ name: "pick-target", kind })} />
        )}

        {stage.name === "pick-target" && (
          <PickTarget
            kind={stage.kind}
            onBack={() => setStage({ name: "pick-kind" })}
            onPick={(dest) => setStage({ name: "preview", destination: dest })}
          />
        )}

        {stage.name === "preview" && (
          <PreviewAndSend
            surface={surface}
            recordId={recordId}
            destination={stage.destination}
            onBack={hasBotToken ? () => setStage({ name: "pick-kind" }) : null}
            onClose={onClose}
            onDone={(label) => setStage({ name: "done", destinationLabel: label })}
          />
        )}

        {stage.name === "done" && (
          <div className="my-6 rounded-[12px] border border-state-ok/30 bg-state-ok/10 p-4 text-center">
            <Icon name="check" size={20} strokeWidth={2.2} className="mx-auto mb-2 text-state-ok" />
            <div className="text-[14px] font-semibold text-ink">Shared to Slack</div>
            <div className="mt-1 text-[12.5px] text-mute">Your message is in {stage.destinationLabel}.</div>
            <button
              type="button"
              onClick={onClose}
              className="mt-4 rounded-md border border-rule bg-paper px-4 py-1.5 text-[12.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Step 1: pick Channel or Person ────────────────────────────────────

function PickKind({ onPick }: { onPick: (kind: "channel" | "user") => void }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <PickerTile
        onClick={() => onPick("channel")}
        icon={<Icon name="chat" size={22} strokeWidth={1.8} />}
        title="Channel"
        subtitle="Public or private channel the bot is in"
      />
      <PickerTile
        onClick={() => onPick("user")}
        icon={<Icon name="users" size={22} strokeWidth={1.8} />}
        title="Person"
        subtitle="Send as a direct message"
      />
    </div>
  );
}

function PickerTile({
  onClick, icon, title, subtitle,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-start gap-2 rounded-[14px] border border-rule bg-paper p-5 text-left transition hover:border-brand-violet hover:bg-brand-violet/[.04]"
    >
      <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-warm2 text-ink2">{icon}</span>
      <div>
        <div className="text-[14.5px] font-semibold text-ink">{title}</div>
        <div className="mt-0.5 text-[12px] text-mute">{subtitle}</div>
      </div>
    </button>
  );
}

// ─── Step 2: pick a specific channel or person ─────────────────────────

function PickTarget({
  kind, onPick, onBack,
}: {
  kind: "channel" | "user";
  onPick: (dest: Destination) => void;
  onBack: () => void;
}) {
  const [items, setItems] = useState<(SlackDirectoryChannel | SlackDirectoryUser)[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    getSlackDirectory(kind)
      .then((r) => { if (!cancelled) setItems(r.items as typeof items); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [kind]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter((it) => {
      const hay = kind === "channel"
        ? `${(it as SlackDirectoryChannel).name} ${(it as SlackDirectoryChannel).topic ?? ""}`
        : `${(it as SlackDirectoryUser).name} ${(it as SlackDirectoryUser).label ?? ""} ${(it as SlackDirectoryUser).email ?? ""}`;
      return hay.toLowerCase().includes(s);
    });
  }, [q, items, kind]);

  return (
    <>
      <div className="mb-3 flex items-center gap-2 rounded-[12px] border border-rule bg-paper px-3 py-2 focus-within:border-brand-violet focus-within:ring-2 focus-within:ring-brand-violet/20">
        <Icon name="search" size={14} strokeWidth={2} className="text-mute" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={kind === "channel" ? "Search channels…" : "Search people by name or email…"}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-hint outline-none"
        />
      </div>

      {loading && (
        <div className="my-8 text-center text-[13px] text-mute">Loading Slack directory…</div>
      )}
      {error && (
        <div className="my-4 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
          {error} — try refreshing the directory in Admin → Integrations → Slack.
        </div>
      )}

      {!loading && !error && (
        <div className="max-h-[360px] overflow-y-auto rounded-[12px] border border-rule">
          {filtered.length === 0 ? (
            <div className="p-6 text-center text-[12.5px] text-mute">
              No matches. If a {kind} is missing, refresh the directory in Admin → Integrations → Slack.
            </div>
          ) : (
            filtered.map((it) => (
              kind === "channel"
                ? <ChannelRow key={it.id} row={it as SlackDirectoryChannel} onPick={(d) => onPick(d)} />
                : <UserRow key={it.id} row={it as SlackDirectoryUser} onPick={(d) => onPick(d)} />
            ))
          )}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        <button type="button" onClick={onBack} className="text-[12.5px] font-semibold text-mute hover:text-ink">
          ← Back
        </button>
        <span className="mono-cap text-[10px] tracking-[.06em] text-hint">{filtered.length} of {items.length}</span>
      </div>
    </>
  );
}

function ChannelRow({ row, onPick }: { row: SlackDirectoryChannel; onPick: (d: Destination) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick({ kind: "channel", id: row.id, name: `#${row.name}` })}
      className="flex w-full items-center gap-3 border-b border-rule/50 px-4 py-2.5 text-left last:border-b-0 hover:bg-warm/60"
    >
      <span className={cn(
        "grid h-7 w-7 flex-shrink-0 place-items-center rounded-full text-[11px] font-bold",
        row.isMember ? "bg-brand-violet/10 text-brand-violet" : "bg-warm2 text-mute",
      )}>
        {row.isPrivate ? "🔒" : "#"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-ink">#{row.name}</span>
          {row.isPrivate && <span className="mono-cap text-[9px] tracking-[.06em] text-hint">PRIVATE</span>}
          {!row.isMember && !row.isPrivate && <span className="mono-cap text-[9px] tracking-[.06em] text-mute">auto-join</span>}
          {!row.isMember && row.isPrivate && <span className="mono-cap text-[9px] tracking-[.06em] text-state-warn">bot not a member</span>}
        </div>
        {row.topic && <div className="mt-0.5 truncate text-[11.5px] text-mute">{row.topic}</div>}
      </div>
    </button>
  );
}

function UserRow({ row, onPick }: { row: SlackDirectoryUser; onPick: (d: Destination) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick({ kind: "user", id: row.id, name: `@${row.label}` })}
      className="flex w-full items-center gap-3 border-b border-rule/50 px-4 py-2.5 text-left last:border-b-0 hover:bg-warm/60"
    >
      <div className="grid h-8 w-8 flex-shrink-0 place-items-center overflow-hidden rounded-full bg-warm2 text-[10px] font-bold text-ink2">
        {row.imageUrl
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={row.imageUrl} alt="" className="h-8 w-8 object-cover" />
          : (row.label ?? row.name).slice(0, 2).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-ink">{row.label}</div>
        <div className="mt-0.5 truncate text-[11.5px] text-mute">
          @{row.name}{row.email ? ` · ${row.email}` : ""}
        </div>
      </div>
    </button>
  );
}

// ─── Step 3: preview + notes + send ────────────────────────────────────

function PreviewAndSend({
  surface, recordId, destination, onBack, onClose, onDone,
}: {
  surface: ShareSurface;
  recordId: string;
  destination: Destination | null;
  onBack: (() => void) | null;
  onClose: () => void;
  onDone: (destinationLabel: string) => void;
}) {
  const [preview, setPreview] = useState<SlackSharePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setLoadError(null);
    getSharePreview(surface, recordId)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e: Error) => { if (!cancelled) setLoadError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [surface, recordId]);

  async function onSend() {
    setBusy(true);
    setSendError(null);
    try {
      await shareToSlack(surface, recordId, notes.trim() || null, destination ?? undefined);
      onDone(destination?.name ?? preview?.target.channel ?? "the channel");
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {loading && (
        <div className="my-10 text-center text-[13px] text-mute">Loading preview…</div>
      )}

      {loadError && (
        <div className="my-4 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
          {loadError}
        </div>
      )}

      {preview && !loadError && (
        <>
          <div className="mb-3 flex items-center gap-2 rounded-[10px] border border-rule bg-warm/40 px-3 py-2 text-[12.5px]">
            <span className="mono-cap text-[9.5px] font-semibold tracking-[.12em] text-mute">SENDING TO</span>
            <span className="font-semibold text-ink">
              {destination?.name ?? preview.target.channel ?? "(default channel)"}
            </span>
          </div>

          <div className="mb-4 rounded-[12px] border border-rule bg-warm/40 p-4">
            <div className="mono-cap mb-2 text-[9.5px] font-semibold tracking-[.12em] text-mute">Preview</div>
            <div className="font-serif text-[16px] leading-tight tracking-[-.01em]">
              {preview.preview.text}
            </div>
            <FieldsGrid preview={preview} />
          </div>

          <label className="mb-4 block">
            <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">
              Add notes (optional)
            </span>
            <textarea
              className="w-full resize-y rounded-[10px] border border-rule bg-paper p-3 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
              rows={3}
              placeholder="Add context — e.g. 'High-intent, follow up by Friday'"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <span className="mono-cap mt-1 block text-[10px] tracking-[.04em] text-hint">
              Notes appear at the bottom of the message, attributed to your name.
            </span>
          </label>

          {sendError && (
            <div className="mb-3 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
              {sendError}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-rule pt-4">
            {onBack ? (
              <button type="button" onClick={onBack} disabled={busy} className="text-[12.5px] font-semibold text-mute hover:text-ink">
                ← Change destination
              </button>
            ) : <span />}
            <div className="flex items-center gap-3">
              <button type="button" onClick={onClose} disabled={busy} className="btn">Cancel</button>
              <button type="button" onClick={onSend} disabled={busy} className="btn-grad disabled:opacity-60">
                {busy ? "Sending…" : "Send to Slack"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ─── shared: render the section-block fields as a grid ─────────────────

function FieldsGrid({ preview }: { preview: SlackSharePreview }) {
  const blocks = preview.preview.blocks as Array<Record<string, unknown>>;
  const fieldRows: { label: string; value: string }[] = [];
  for (const blk of blocks) {
    const fields = blk.fields as Array<{ text: string }> | undefined;
    if (!Array.isArray(fields)) continue;
    for (const f of fields) {
      const txt = String(f.text ?? "");
      const idx = txt.indexOf("\n");
      if (idx <= 0) continue;
      const label = txt.slice(0, idx).replace(/^\*+|\*+$/g, "");
      const value = txt.slice(idx + 1);
      fieldRows.push({ label, value });
    }
  }
  if (fieldRows.length === 0) return null;
  return (
    <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2.5">
      {fieldRows.map((f, i) => (
        <div key={i} className="min-w-0">
          <div className="mono-cap text-[9.5px] font-semibold tracking-[.06em] text-mute">{f.label}</div>
          <div className="truncate text-[13px] text-ink">{f.value}</div>
        </div>
      ))}
    </div>
  );
}
