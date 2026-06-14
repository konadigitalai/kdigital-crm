"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  addCaseComment, getCatalog, reopenCase, updateCase,
} from "@/lib/api";
import { StatusPill, STATUS_LABEL } from "./StatusPill";
import { PriorityChip, PRIORITY_LABEL } from "./PriorityChip";
import { CloseCaseDialog } from "./CloseCaseDialog";
import { ShareToSlackButton } from "@/components/share/ShareToSlackButton";
import type {
  CatalogResponse, CaseCategory, CaseDetail as CaseDetailType,
  CasePriority, CaseStatus,
} from "@/lib/types";

const STATUSES_NON_TERMINAL: CaseStatus[] = ["open", "in_progress", "pending"];
const STATUSES_ALL: CaseStatus[] = ["open", "in_progress", "pending", "resolved"];

const CATEGORY_LABEL_MAP: Record<CaseCategory, string> = {
  billing: "Billing",
  technical: "Technical",
  content_lms: "Content / LMS",
  onboarding: "Onboarding",
  cohort_batch: "Cohort / Batch",
  refund: "Refund",
  certificate: "Certificate",
  other: "Other",
};

export function CaseDetailView({ data }: { data: CaseDetailType }) {
  const router = useRouter();
  const t = data.case;
  const isClosed = t.status === "closed";
  const isResolved = t.status === "resolved";
  const isTerminal = isClosed || isResolved || t.status === "cancelled";

  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { getCatalog().then(setCatalog).catch(() => {}); }, []);

  async function patch(body: Parameters<typeof updateCase>[1]) {
    setBusy(true); setError(null);
    try {
      await updateCase(t.number, body);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reopen() {
    setBusy(true); setError(null);
    try {
      await reopenCase(t.number);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const overdue = !!t.dueAt && !isTerminal && new Date(t.dueAt).getTime() < Date.now();

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      {/* LEFT — body + timeline + comment */}
      <div className="space-y-6">
        <header className="rounded-2xl border border-rule bg-paper p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="mono-cap mb-1 flex items-center gap-2 text-[10px] tracking-[.12em] text-mute">
                <span className="font-mono text-[11px] tracking-[.04em] text-mute">{t.number}</span>
                <span className="text-hint">·</span>
                <span>{CATEGORY_LABEL_MAP[t.category]}</span>
                {data.linked && (
                  <>
                    <span className="text-hint">·</span>
                    <Link href={data.linked.href} className="text-brand-violet hover:underline">
                      Linked to {data.linked.label} →
                    </Link>
                  </>
                )}
              </div>
              <h1 className="font-serif text-[32px] font-normal leading-tight tracking-[-.01em]">{t.subject}</h1>
              {t.description && (
                <p className="mt-3 whitespace-pre-wrap text-[14px] leading-[1.5] text-ink2">{t.description}</p>
              )}
            </div>
            <div className="flex flex-col items-end gap-2">
              <StatusPill status={t.status} />
              <PriorityChip priority={t.priority} />
            </div>
          </div>
        </header>

        {/* Requester */}
        <section className="rounded-2xl border border-rule bg-paper p-5">
          <div className="mono-cap mb-3 text-[10px] font-semibold tracking-[.12em] text-mute">Requester</div>
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-full bg-grad text-[12px] font-bold text-white">
              {initialsOf(t.requesterName)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold text-ink">{t.requesterName}</div>
              <div className="mt-0.5 grid grid-cols-1 gap-1 text-[12.5px] text-ink2 sm:grid-cols-2">
                <a href={`mailto:${t.requesterEmail}`} className="truncate hover:text-brand-violet">{t.requesterEmail}</a>
                <a href={`tel:${t.requesterPhone}`} className="truncate hover:text-brand-violet">{t.requesterPhone}</a>
              </div>
              <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-warm2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-mute">
                {t.requesterKind === "lead" ? "Lead" : t.requesterKind === "learner" ? "Learner" : "External"}
              </div>
            </div>
          </div>
        </section>

        {/* Resolution panel — only when resolved/closed */}
        {(isClosed || isResolved) && t.resolution && (
          <section className="rounded-2xl border border-state-ok/30 bg-[rgba(46,158,106,.04)] p-5">
            <div className="mono-cap mb-2 text-[10px] font-semibold tracking-[.12em] text-state-ok">
              {isClosed ? "Resolution · Closed" : "Resolution"}
            </div>
            <div className="text-[14px] leading-[1.5] text-ink2 whitespace-pre-wrap">{t.resolution}</div>
            {t.resolutionCode && (
              <div className="mt-3 inline-flex items-center gap-1 rounded-full border border-state-ok/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-state-ok">
                {t.resolutionCode.replace("_", " ")}
              </div>
            )}
          </section>
        )}

        {/* Timeline */}
        <section className="rounded-2xl border border-rule bg-paper p-5">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="font-serif text-[20px] tracking-[-.01em]">Activity</h2>
            <span className="text-[11px] text-mute">{data.timeline.length} event{data.timeline.length === 1 ? "" : "s"}</span>
          </div>
          <Timeline rows={data.timeline} />
          {!isTerminal && <CommentBox number={t.number} />}
        </section>
      </div>

      {/* RIGHT — controls */}
      <aside className="space-y-4">
        {!isTerminal ? (
          <button
            onClick={() => setCloseOpen(true)}
            disabled={busy}
            className="btn-grad w-full disabled:opacity-60"
          >
            <Icon name="check" size={14} strokeWidth={2} />
            Close case
          </button>
        ) : (
          <button onClick={reopen} disabled={busy} className="btn w-full disabled:opacity-50">
            Reopen
          </button>
        )}

        <ShareToSlackButton surface="cases" recordId={t.number} className="w-full justify-center" />

        {error && (
          <div className="rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
            {error}
          </div>
        )}

        <RailCard label="Status">
          <select
            disabled={busy || isTerminal}
            value={t.status}
            onChange={(e) => patch({ status: e.target.value })}
            className={selectCls}
          >
            {STATUSES_ALL.map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
            {/* Read-only options (never selectable here, only displayed if currently set) */}
            {isClosed && <option value="closed">{STATUS_LABEL.closed}</option>}
            {t.status === "cancelled" && <option value="cancelled">{STATUS_LABEL.cancelled}</option>}
          </select>
          {!isTerminal && t.status !== "open" && (
            <p className="mt-1 text-[10.5px] text-hint">Use "Close case" above to mark closed (resolution required).</p>
          )}
        </RailCard>

        <RailCard label="Priority">
          <div className="flex flex-wrap gap-1.5">
            {[1, 2, 3, 4].map((p) => {
              const active = t.priority === p;
              return (
                <button
                  key={p}
                  type="button"
                  disabled={busy || isTerminal}
                  onClick={() => patch({ priority: p })}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-50",
                    active ? "border border-transparent bg-ink text-white" : "border border-rule bg-paper text-ink2 hover:border-rule2",
                  )}
                >
                  {PRIORITY_LABEL[p as CasePriority]}
                </button>
              );
            })}
          </div>
        </RailCard>

        <RailCard label="Assignee">
          <select
            disabled={busy || isTerminal}
            value={t.assigneeId ?? ""}
            onChange={(e) => patch({ assigneeId: e.target.value || null })}
            className={selectCls}
          >
            <option value="">— unassigned —</option>
            {catalog?.employees.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}{u.role !== "service_rep" ? ` · ${u.role}` : ""}
              </option>
            ))}
          </select>
        </RailCard>

        <RailCard label="Category">
          <select
            disabled={busy || isTerminal}
            value={t.category}
            onChange={(e) => patch({ category: e.target.value })}
            className={selectCls}
          >
            {catalog?.caseCategories.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            )) ?? <option value={t.category}>{CATEGORY_LABEL_MAP[t.category]}</option>}
          </select>
        </RailCard>

        <RailCard label="Due by">
          <DateInput
            value={t.dueAt}
            disabled={busy || isTerminal}
            highlight={overdue}
            onCommit={(v) => patch({ dueAt: v })}
          />
        </RailCard>

        <RailCard label="Reminder">
          <DateInput
            value={t.remindAt}
            disabled={busy || isTerminal}
            onCommit={(v) => patch({ remindAt: v })}
          />
        </RailCard>

        <div className="rounded-2xl border border-rule bg-paper p-4 text-[11.5px] leading-relaxed text-mute">
          <div className="mono-cap mb-2 text-[9.5px] font-semibold tracking-[.12em]">Audit</div>
          {t.createdByName && <div>Created by <span className="font-semibold text-ink">{t.createdByName}</span></div>}
          <div>Created · {fmtDateTime(t.createdAt)}</div>
          <div>Updated · {fmtDateTime(t.updatedAt)}</div>
          {t.resolvedAt && <div>Resolved · {fmtDateTime(t.resolvedAt)}</div>}
          {t.closedAt && <div>Closed · {fmtDateTime(t.closedAt)}</div>}
        </div>
      </aside>

      {closeOpen && (
        <CloseCaseDialog
          number={t.number}
          catalog={catalog}
          onClose={() => setCloseOpen(false)}
        />
      )}
    </div>
  );
}

const selectCls = "w-full rounded-[10px] border border-rule bg-paper px-3 py-2 text-[13px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20 disabled:opacity-60";

function RailCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-rule bg-paper p-4">
      <div className="mono-cap mb-2 text-[9.5px] font-semibold tracking-[.12em] text-mute">{label}</div>
      {children}
    </div>
  );
}

function DateInput({
  value, disabled, highlight = false, onCommit,
}: {
  value: string | null;
  disabled?: boolean;
  highlight?: boolean;
  onCommit: (iso: string | null) => void;
}) {
  const [local, setLocal] = useState(toLocalInput(value));
  useEffect(() => { setLocal(toLocalInput(value)); }, [value]);
  return (
    <div className="space-y-1">
      <input
        type="datetime-local"
        disabled={disabled}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          const newIso = local ? new Date(local).toISOString() : null;
          if (newIso !== value) onCommit(newIso);
        }}
        className={cn(
          "w-full rounded-[10px] border border-rule bg-paper px-3 py-2 text-[13px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20 disabled:opacity-60",
          highlight && "border-brand-magenta/40 text-brand-magenta",
        )}
      />
      {value && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onCommit(null)}
          className="text-[10.5px] text-mute hover:text-brand-magenta"
        >
          Clear
        </button>
      )}
    </div>
  );
}

function CommentBox({ number }: { number: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!text.trim()) return;
    setBusy(true); setError(null);
    try {
      await addCaseComment(number, text.trim());
      setText("");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 rounded-xl border border-rule bg-warm p-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a comment — context, an update, what you tried…"
        className="w-full resize-y bg-transparent text-[13.5px] leading-relaxed text-ink placeholder:text-hint focus:outline-none"
        rows={3}
      />
      <div className="mt-2 flex items-center justify-between">
        {error ? <span className="text-[11px] text-state-warn">{error}</span> : <span className="text-[11px] text-hint">Comments are immutable once posted.</span>}
        <button
          onClick={send}
          disabled={!text.trim() || busy}
          className="btn-grad disabled:opacity-50"
        >
          {busy ? "Posting…" : "Post comment"}
        </button>
      </div>
    </div>
  );
}

function Timeline({ rows }: { rows: CaseDetailType["timeline"] }) {
  if (!rows.length) {
    return <div className="rounded-lg border border-dashed border-rule p-6 text-center text-[12px] text-hint">No activity yet.</div>;
  }
  return (
    <ol className="relative space-y-3 border-l border-rule pl-5">
      {rows.map((row, i) => {
        const tone = toneFor(row.verb);
        return (
          <li key={row.id ?? i} className="relative">
            <span className={cn(
              "absolute -left-[26px] top-1.5 grid h-4 w-4 place-items-center rounded-full ring-2 ring-paper",
              tone.bg,
            )}>
              <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} />
            </span>
            <div className="rounded-lg border border-rule bg-paper p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] font-semibold text-ink">{row.actorName}</span>
                <span className="text-[10.5px] text-hint">{fmtTimelineTs(row.ts)}</span>
              </div>
              <div className="mt-0.5 mono-cap text-[9.5px] tracking-[.12em] text-mute">{row.verb}</div>
              <div className="mt-1.5 whitespace-pre-wrap text-[13px] leading-[1.45] text-ink2">{row.detail}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function toneFor(verb: string): { bg: string; dot: string } {
  switch (verb) {
    case "Closed":   return { bg: "bg-[rgba(46,158,106,.10)]",  dot: "bg-state-ok" };
    case "Resolved": return { bg: "bg-[rgba(46,158,106,.10)]",  dot: "bg-state-ok" };
    case "Reopened": return { bg: "bg-[rgba(31,63,207,.10)]",   dot: "bg-brand-blue" };
    case "Assigned": return { bg: "bg-[rgba(107,31,184,.10)]",  dot: "bg-brand-violet" };
    case "Status":   return { bg: "bg-[rgba(107,31,184,.10)]",  dot: "bg-brand-violet" };
    case "Priority": return { bg: "bg-[rgba(199,25,122,.10)]",  dot: "bg-brand-magenta" };
    case "Comment":  return { bg: "bg-warm2",                   dot: "bg-mute" };
    case "Due":      return { bg: "bg-[rgba(224,138,30,.12)]",  dot: "bg-state-amber" };
    case "Reminder": return { bg: "bg-[rgba(224,138,30,.12)]",  dot: "bg-state-amber" };
    default:         return { bg: "bg-warm",                    dot: "bg-mute" };
  }
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  // Convert to YYYY-MM-DDTHH:MM in local time for the datetime-local input.
  const tzOffset = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tzOffset).toISOString().slice(0, 16);
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
}

function fmtTimelineTs(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
}
