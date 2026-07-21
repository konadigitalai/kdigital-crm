"use client";

// Case detail — redesigned as a card-based record page in the same idiom as
// the batch detail page (web/src/components/batch/BatchDetail.tsx): a big
// serif header + action row, an Edify Agent next-best-action banner, a
// systemic-issue banner when the case is linked to a wider pattern, then a
// CASE / LINKED / OUTCOME card trio in the main column with a controls rail
// beside it. Money (refunds, P&L) is out of scope for this pass.
//
// All the mutation plumbing below (patch/reopen/escalate/comment/close) is
// unchanged from the previous layout — only the visual structure moved.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  addCaseComment, escalateCase, getCatalog, reopenCase, updateCase,
} from "@/lib/api";
import { StatusPill, STATUS_LABEL } from "./StatusPill";
import { SeverityChip } from "./SeverityChip";
import { PRIORITY_LABEL } from "./PriorityChip";
import { CloseCaseDialog } from "./CloseCaseDialog";
import { ShareToSlackButton } from "@/components/share/ShareToSlackButton";
import { NbaBanner } from "./NbaBanner";
import { SystemicBanner } from "./SystemicBanner";
import type {
  CaseCategory, CaseDetail as CaseDetailType,
  CasePriority, CaseSlaState, CaseStatus,
} from "@/lib/types";

const STATUSES_ALL: CaseStatus[] = ["open", "in_progress", "pending", "resolved"];

const CATEGORY_LABEL_MAP: Record<CaseCategory, string> = {
  billing: "Billing",
  technical: "Technical",
  content_lms: "Content / LMS",
  onboarding: "Onboarding",
  cohort_batch: "Cohort / Batch",
  refund: "Refund",
  certificate: "Certificate",
  data_privacy: "Data / Privacy",
  other: "Other",
};

const pillBtnCls = "inline-flex items-center gap-1.5 rounded-full border border-rule bg-paper px-3.5 py-1.5 text-[12.5px] font-semibold text-ink2 transition hover:border-rule2 hover:text-ink disabled:opacity-50";

export function CaseDetailView({ data }: { data: CaseDetailType }) {
  const router = useRouter();
  const t = data.case;
  const isClosed = t.status === "closed";
  const isResolved = t.status === "resolved";
  const isTerminal = isClosed || isResolved || t.status === "cancelled";
  const canWrite = !isTerminal;

  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof getCatalog>> | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);

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

  async function escalate() {
    setBusy(true); setError(null);
    try {
      await escalateCase(t.number);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function focusReply() {
    commentRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    commentRef.current?.focus();
  }

  const overdue = !!t.dueAt && !isTerminal && new Date(t.dueAt).getTime() < Date.now();
  const sla = slaLabel(t.slaState, t.slaMinutes);
  const subLine = [
    t.partyName ?? t.requesterName,
    titleCase(t.requesterKind),
    t.severity,
    t.displayStatus,
    sla,
  ].filter(Boolean).join(" · ");

  return (
    <div>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-serif text-[32px] font-normal leading-tight tracking-[-.01em]">
            {t.number} — {t.typeLabel ?? t.subject}
          </h1>
          <div className="mt-1.5 truncate font-mono text-[12px] tracking-[.02em] text-mute">
            {subLine}
          </div>
          {t.description && (
            <p className="mt-2.5 max-w-[70ch] whitespace-pre-wrap text-[13.5px] leading-[1.5] text-ink2">
              {t.description}
            </p>
          )}
        </div>
        <Link
          href="/cases"
          className="mono-cap mt-1.5 flex-shrink-0 text-[11px] font-semibold tracking-[.08em] text-mute transition hover:text-ink"
        >
          ← Back
        </Link>
      </div>

      {/* ── Action row ──────────────────────────────────────────────────── */}
      <div className="mb-6 flex flex-wrap items-center gap-2.5">
        <button type="button" onClick={focusReply} disabled={isTerminal} className="btn-grad disabled:opacity-50">
          <Icon name="reply" size={14} strokeWidth={2} />
          Reply
        </button>
        <button type="button" onClick={() => setCloseOpen(true)} disabled={busy || isTerminal} className={pillBtnCls}>
          <Icon name="plus" size={13} strokeWidth={2} className="rotate-45" />
          Decline
        </button>
        <button type="button" onClick={escalate} disabled={busy || isTerminal} className={pillBtnCls}>
          <Icon name="spark" size={13} strokeWidth={2} />
          Escalate
        </button>
        <button type="button" onClick={() => setCloseOpen(true)} disabled={busy || isTerminal} className={pillBtnCls}>
          <Icon name="check" size={13} strokeWidth={2} />
          Resolve
        </button>
      </div>

      {data.nba && <NbaBanner nba={data.nba} />}
      {t.systemicRef && <SystemicBanner text={t.systemicRef} />}

      {error && (
        <div className="mb-5 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
          {error}
        </div>
      )}

      {/* ── Two-column layout ──────────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            {/* CASE */}
            <div className="acard">
              <SectionLabel>Case</SectionLabel>
              <div className="flex flex-col">
                <Row
                  k="Opened"
                  v={`${ageLabel(t.createdAt)} · ${t.channel ?? "—"} · ${t.raisedBy ? `${t.raisedBy}-raised` : "—"}`}
                />
                <RowNode k="First response">
                  {t.firstResponseAt ? (
                    <span className="inline-flex items-center gap-1 font-semibold text-state-ok">
                      {firstResponseLabel(t.createdAt, t.firstResponseAt)}
                      <Icon name="check" size={12} strokeWidth={2.4} />
                    </span>
                  ) : (
                    <span className="text-hint">—</span>
                  )}
                </RowNode>
                <RowNode k="Resolution due">
                  <span className={cn("font-semibold", overdue ? "text-state-warn" : "text-ink")}>
                    {dueLabel(t.dueAt)}
                  </span>
                </RowNode>
                <Row k="Reopened" v={String(t.reopenCount)} />
              </div>
            </div>

            {/* LINKED */}
            <div className="acard">
              <SectionLabel>Linked</SectionLabel>
              <div className="flex flex-col">
                <RowNode k="Enrollment">
                  {t.aboutKind === "enrolment" && t.aboutHref && t.aboutLabel ? (
                    <Link href={t.aboutHref} className="font-semibold text-brand-violet hover:underline">
                      {t.aboutLabel}
                    </Link>
                  ) : (
                    <span className="text-hint">—</span>
                  )}
                </RowNode>
                <Row k="Batch" v="—" muted />
                <Row k="Payment" v="—" muted />
                <RowNode k="Record">
                  {data.linked ? (
                    <Link href={data.linked.href} className="font-semibold text-brand-violet hover:underline">
                      {data.linked.label} →
                    </Link>
                  ) : (
                    <span className="text-hint">—</span>
                  )}
                </RowNode>
              </div>
            </div>
          </div>

          {/* OUTCOME · REQUIRED TO CLOSE */}
          <div className="acard">
            <SectionLabel>Outcome · Required to close</SectionLabel>
            <div className="flex flex-col">
              <div className="flex items-center justify-between gap-4 border-b border-dashed border-rule py-[9px] text-[13px]">
                <span className="flex-shrink-0 font-medium text-mute">Root cause</span>
                <div className="w-[65%] max-w-[380px]">
                  <InlineText
                    value={t.rootCause}
                    placeholder="Add a root cause…"
                    disabled={busy || !canWrite}
                    onCommit={(v) => patch({ rootCause: v })}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between gap-4 border-b border-dashed border-rule py-[9px] text-[13px]">
                <span className="flex-shrink-0 font-medium text-mute">Preventable</span>
                <div className="flex items-center gap-1.5">
                  {([true, false] as const).map((v) => {
                    const active = t.preventable === v;
                    return (
                      <button
                        key={String(v)}
                        type="button"
                        disabled={busy || !canWrite}
                        onClick={() => patch({ preventable: v })}
                        className={cn(
                          "rounded-full px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-50",
                          active ? "border border-transparent bg-ink text-white" : "border border-rule bg-paper text-ink2 hover:border-rule2",
                        )}
                      >
                        {v ? "Yes" : "No"}
                      </button>
                    );
                  })}
                  {t.preventable === null && <span className="text-[11px] text-hint">Not set</span>}
                </div>
              </div>
              <div className="flex items-center justify-between gap-4 py-[9px] text-[13px]">
                <span className="flex-shrink-0 font-medium text-mute">Systemic ref</span>
                <div className="w-[65%] max-w-[380px]">
                  <InlineText
                    value={t.systemicRef}
                    placeholder="e.g. SYS-2026-04"
                    disabled={busy || !canWrite}
                    onCommit={(v) => patch({ systemicRef: v })}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Timeline + comment */}
          <section className="acard">
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="font-serif text-[20px] tracking-[-.01em]">Activity</h2>
              <span className="text-[11px] text-mute">{data.timeline.length} event{data.timeline.length === 1 ? "" : "s"}</span>
            </div>
            <Timeline rows={data.timeline} />
            {!isTerminal && <CommentBox number={t.number} textareaRef={commentRef} />}
          </section>
        </div>

        {/* ── Right rail ──────────────────────────────────────────────── */}
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

          <RailCard label="Status">
            <div className="mb-2"><StatusPill status={t.status} size="sm" /></div>
            <select
              disabled={busy || isTerminal}
              value={t.status}
              onChange={(e) => patch({ status: e.target.value })}
              className={selectCls}
            >
              {STATUSES_ALL.map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
              {isClosed && <option value="closed">{STATUS_LABEL.closed}</option>}
              {t.status === "cancelled" && <option value="cancelled">{STATUS_LABEL.cancelled}</option>}
            </select>
            {!isTerminal && t.status !== "open" && (
              <p className="mt-1 text-[10.5px] text-hint">Use "Close case" above to mark closed (resolution required).</p>
            )}
          </RailCard>

          <RailCard label="Severity">
            <div className="mb-2"><SeverityChip severity={t.severity} size="sm" /></div>
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
      </div>

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

// ─── Small shared card bits ─────────────────────────────────────────────────

const selectCls = "w-full rounded-[10px] border border-rule bg-paper px-3 py-2 text-[13px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20 disabled:opacity-60";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mono-cap mb-4 text-[10px] font-semibold tracking-[.14em] text-mute">
      {children}
    </div>
  );
}

function Row({ k, v, muted }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-dashed border-rule py-[9px] text-[13px] last:border-b-0">
      <span className="font-medium text-mute">{k}</span>
      <span className={cn("text-right font-semibold", muted ? "text-hint" : "text-ink")}>{v}</span>
    </div>
  );
}

function RowNode({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-dashed border-rule py-[9px] text-[13px] last:border-b-0">
      <span className="font-medium text-mute">{k}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function RailCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-rule bg-paper p-4">
      <div className="mono-cap mb-2 text-[9.5px] font-semibold tracking-[.12em] text-mute">{label}</div>
      {children}
    </div>
  );
}

function InlineText({
  value, placeholder, disabled, onCommit,
}: {
  value: string | null;
  placeholder?: string;
  disabled?: boolean;
  onCommit: (v: string | null) => void;
}) {
  const [local, setLocal] = useState(value ?? "");
  useEffect(() => { setLocal(value ?? ""); }, [value]);
  return (
    <input
      type="text"
      disabled={disabled}
      value={local}
      placeholder={placeholder}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        const v = local.trim() || null;
        if (v !== (value ?? null)) onCommit(v);
      }}
      className="w-full rounded-[8px] border border-rule bg-paper px-2.5 py-1.5 text-right text-[13px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20 disabled:opacity-60"
    />
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

function CommentBox({
  number, textareaRef,
}: {
  number: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
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
        ref={textareaRef}
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

// ─── Formatting helpers ─────────────────────────────────────────────────────

function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** "3h" / "42m" — coarse duration, no minute remainder once past an hour
 *  (matches the mockup's "3h left" / "BREACHED 2h", not "3h 12m left"). */
function fmtDur(totalMinutes: number): string {
  const mins = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(mins / 60);
  if (h > 0) return `${h}h`;
  return `${mins}m`;
}

/** SLA countdown/breach label for the header sub-line. Empty string when
 *  there's nothing worth saying (no SLA, or already met). */
function slaLabel(state: CaseSlaState, minutes: number | null): string {
  if (state === "paused") return "Paused";
  if (state === "none" || state === "met" || minutes == null) return "";
  const dur = fmtDur(Math.abs(minutes));
  if (state === "breached") return `BREACHED ${dur}`;
  return `${dur} left`;
}

/** "2h ago" / "3d ago" — coarse age since the case was opened. */
function ageLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "in 3 days" / "overdue" / "—" for the Resolution-due row. */
function dueLabel(dueAt: string | null): string {
  if (!dueAt) return "—";
  const ms = new Date(dueAt).getTime() - Date.now();
  if (ms < 0) return "overdue";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/** "42 min" / "1h 20m" — elapsed time from open to first response. */
function firstResponseLabel(createdAt: string, firstResponseAt: string): string {
  const ms = new Date(firstResponseAt).getTime() - new Date(createdAt).getTime();
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
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
