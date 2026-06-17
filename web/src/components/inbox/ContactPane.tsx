"use client";

// Right-pane contact summary. Owns the assignment menu, status menu,
// tag picker, and "Promote to lead" action.

import Link from "next/link";
import { useState } from "react";
import type {
  AdminUser, CurrentUser, WaConversationDetail,
  WaConversationStatus, WaTag,
} from "@/lib/types";
import { Icon } from "@/components/ui/Icon";

export function ContactPane({
  thread,
  allTags,
  users,
  currentUser,
  canSend,
  canManageTags,
  onAssign,
  onChangeStatus,
  onAddTag,
  onRemoveTag,
  onPromoteToLead,
}: {
  thread: WaConversationDetail;
  allTags: WaTag[];
  users: AdminUser[];
  currentUser: CurrentUser | null;
  canSend: boolean;
  canManageTags: boolean;
  onAssign: (userId: string | null) => void | Promise<void>;
  onChangeStatus: (status: WaConversationStatus) => void | Promise<void>;
  onAddTag: (tagId: string) => void | Promise<void>;
  onRemoveTag: (tagId: string) => void | Promise<void>;
  onPromoteToLead: () => Promise<{ ok: boolean; number: string; alreadyLead: boolean } | null>;
}) {
  const c = thread.conversation;
  const initials = (c.partyName ?? "?").trim().slice(0, 2).toUpperCase();
  const phone = `${c.partyPhoneCc ?? ""} ${c.partyPhone ?? ""}`.trim();

  const tagIds = new Set(thread.tags.map((t) => t.id));
  const availableTags = allTags.filter((t) => !tagIds.has(t.id));

  const [busy, setBusy] = useState<"promote" | null>(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);

  async function promote() {
    setBusy("promote");
    setFlash(null);
    const r = await onPromoteToLead();
    setBusy(null);
    if (!r) return;
    setFlash(r.alreadyLead
      ? { kind: "warn", text: `Already a lead — ${r.number}` }
      : { kind: "ok", text: `Promoted — ${r.number}` });
  }

  return (
    <div className="flex flex-col gap-4 p-5">
      {/* Identity */}
      <div className="flex items-start gap-3">
        <div className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-2xl bg-grad-violet text-[15px] font-bold text-white">
          {initials}
        </div>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold tracking-[-.005em]">{c.partyName}</div>
          {phone && <div className="mono-cap mt-0.5 text-[10.5px] tracking-[.04em] text-mute">{phone}</div>}
          {c.partyEmail && <div className="mt-0.5 text-[12px] text-mute">{c.partyEmail}</div>}
          {c.partyCity && <div className="mt-0.5 text-[12px] text-mute">{c.partyCity}</div>}
        </div>
      </div>

      {/* Linked CRM record */}
      {(c.leadNumber || c.isLearner) && (
        <div className="rounded-xl border border-rule bg-warm/30 p-3 text-[12.5px]">
          <div className="mono-cap mb-1 text-[9.5px] font-semibold tracking-[.12em] text-mute">Linked record</div>
          {c.leadNumber && (
            <Link href={`/records/${encodeURIComponent(c.leadNumber)}`} className="font-mono font-semibold text-brand-violet hover:underline">
              {c.leadNumber}
            </Link>
          )}
          {c.isLearner && (
            <Link href={`/learners/${encodeURIComponent(c.partyId)}`} className="ml-2 inline-flex items-center gap-1 rounded-full bg-state-ok/10 px-2 py-0.5 text-[10px] font-semibold text-state-ok">
              learner
            </Link>
          )}
        </div>
      )}

      {/* Tags */}
      <Section label="Tags">
        <div className="flex flex-wrap gap-1.5">
          {thread.tags.length === 0 && <span className="text-[12px] text-mute">No tags</span>}
          {thread.tags.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={!canSend}
              onClick={() => onRemoveTag(t.id)}
              title={canSend ? "Click to remove" : undefined}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold text-white transition hover:opacity-80 disabled:cursor-default disabled:opacity-100"
              style={{ backgroundColor: t.color }}
            >
              {t.name}
              {canSend && <span className="text-white/70">×</span>}
            </button>
          ))}
        </div>
        {canSend && availableTags.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[11.5px] font-semibold text-brand-violet hover:underline">+ Add tag</summary>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {availableTags.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onAddTag(t.id)}
                  className="inline-flex items-center gap-1 rounded-full border border-rule bg-paper px-2 py-0.5 text-[11px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.color }} />
                  {t.name}
                </button>
              ))}
            </div>
          </details>
        )}
        {canManageTags && allTags.length === 0 && (
          <div className="mt-1 text-[11px] text-mute">
            No tags exist yet — create them in Admin → Integrations → WhatsApp.
          </div>
        )}
      </Section>

      {/* Assignment */}
      <Section label="Assignee">
        <div className="flex items-center gap-2">
          <select
            disabled={!canSend}
            value={c.assignedUserId ?? ""}
            onChange={(e) => onAssign(e.target.value || null)}
            className="flex-1 rounded-md border border-rule bg-paper px-2.5 py-1 text-[12.5px] text-ink focus:border-brand-violet focus:outline-none disabled:opacity-60"
          >
            <option value="">— unassigned —</option>
            {currentUser && !users.find((u) => u.id === currentUser.id) && (
              <option value={currentUser.id}>{currentUser.name} (you)</option>
            )}
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ?? u.email}
                {u.id === currentUser?.id ? " (you)" : ""}
              </option>
            ))}
          </select>
          {canSend && c.assignedUserId !== currentUser?.id && currentUser && (
            <button
              type="button"
              onClick={() => onAssign(currentUser.id)}
              className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
            >
              Claim
            </button>
          )}
        </div>
      </Section>

      {/* Status */}
      <Section label="Status">
        <div className="flex gap-1.5">
          {(["open", "pending", "closed"] as const).map((s) => (
            <button
              key={s}
              type="button"
              disabled={!canSend}
              onClick={() => onChangeStatus(s)}
              className={
                "flex-1 rounded-md border px-2 py-1 text-[11.5px] font-semibold capitalize transition disabled:opacity-60 " +
                (c.status === s
                  ? "border-brand-violet bg-brand-violet/10 text-brand-violet"
                  : "border-rule bg-paper text-mute hover:border-rule2 hover:text-ink")
              }
            >
              {s}
            </button>
          ))}
        </div>
      </Section>

      {/* Promote to lead */}
      {canSend && !c.leadNumber && !c.isLearner && (
        <Section label="Pipeline">
          <button
            type="button"
            onClick={promote}
            disabled={busy === "promote"}
            className="inline-flex items-center gap-1.5 rounded-md border border-brand-violet bg-brand-violet/10 px-3 py-1.5 text-[12px] font-semibold text-brand-violet transition hover:bg-brand-violet hover:text-white disabled:opacity-60"
          >
            <Icon name="arrow-right" size={12} strokeWidth={2.4} />
            {busy === "promote" ? "Promoting…" : "Promote to lead"}
          </button>
          {flash && (
            <div
              className={
                "mt-2 rounded-md px-2.5 py-1.5 text-[12px] " +
                (flash.kind === "ok" ? "bg-state-ok/10 text-state-ok" : "bg-state-amber/10 text-state-amber")
              }
            >
              {flash.text}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mono-cap mb-1.5 text-[9.5px] font-semibold tracking-[.12em] text-mute">{label}</div>
      {children}
    </div>
  );
}
