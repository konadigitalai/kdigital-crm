"use client";

import Link from "next/link";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField } from "@/components/filter/types";
import { StatusPill } from "./StatusPill";
import { PriorityChip } from "./PriorityChip";
import { cn } from "@/lib/cn";
import type { Case, CaseCategory, CaseStatus } from "@/lib/types";

const STATUS_OPTS = [
  { value: "open",        label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "pending",     label: "Pending" },
  { value: "resolved",    label: "Resolved" },
  { value: "closed",      label: "Closed" },
  { value: "cancelled",   label: "Cancelled" },
];
const PRIORITY_OPTS = [
  { value: "1", label: "Urgent" },
  { value: "2", label: "High"   },
  { value: "3", label: "Medium" },
  { value: "4", label: "Low"    },
];
const CATEGORY_OPTS = [
  { value: "billing",      label: "Billing" },
  { value: "technical",    label: "Technical" },
  { value: "content_lms",  label: "Content / LMS" },
  { value: "onboarding",   label: "Onboarding" },
  { value: "cohort_batch", label: "Cohort / Batch" },
  { value: "refund",       label: "Refund" },
  { value: "certificate",  label: "Certificate" },
  { value: "other",        label: "Other" },
];
const KIND_OPTS = [
  { value: "lead",     label: "Lead" },
  { value: "learner",  label: "Learner" },
  { value: "external", label: "External" },
];

const CATEGORY_LABEL: Record<CaseCategory, string> = Object.fromEntries(
  CATEGORY_OPTS.map((c) => [c.value, c.label]),
) as Record<CaseCategory, string>;

function buildFields(): FilterField[] {
  return [
    { key: "number",        label: "Case #",     type: "text",   get: (t: Case) => t.number },
    { key: "subject",       label: "Subject",    type: "text",   get: (t: Case) => t.subject },
    { key: "requesterName", label: "Requester",  type: "text",   get: (t: Case) => t.requesterName },
    { key: "requesterEmail",label: "Email",      type: "text",   get: (t: Case) => t.requesterEmail },
    { key: "status",        label: "Status",     type: "enum",   options: STATUS_OPTS,   get: (t: Case) => t.status },
    { key: "priority",      label: "Priority",   type: "enum",   options: PRIORITY_OPTS, get: (t: Case) => String(t.priority) },
    { key: "category",      label: "Category",   type: "enum",   options: CATEGORY_OPTS, get: (t: Case) => t.category },
    { key: "requesterKind", label: "Requester type", type: "enum", options: KIND_OPTS,   get: (t: Case) => t.requesterKind },
    { key: "assignee",      label: "Assignee",   type: "text",   get: (t: Case) => t.assigneeName ?? "" },
  ];
}

export function CasesTable({ cases }: { cases: Case[] }) {
  const fields = buildFields();
  const [filtered, state, setState] = useFilter(cases, fields);

  return (
    <>
      <div className="mb-5 rounded-[14px] border border-rule bg-paper p-3">
        <FilterBar
          fields={fields}
          state={state}
          onChange={setState}
          placeholder="Filter cases by status, priority, assignee…"
          totalRows={cases.length}
          filteredRows={filtered.length}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <Row hdr>
          <div>Case</div>
          <div>Subject</div>
          <div>Requester</div>
          <div>Status</div>
          <div>Priority</div>
          <div>Assignee</div>
          <div>Due</div>
        </Row>

        {filtered.length === 0 ? (
          <div className="px-[22px] py-12 text-center text-[13px] text-mute">
            No cases match the current filter.
          </div>
        ) : (
          filtered.map((t) => {
            const dueLabel = t.dueAt ? formatDue(t.dueAt) : "—";
            const overdue = t.isOverdue;
            return (
              <Row key={t.id} href={`/cases/${t.number}`}>
                <div>
                  <div className="font-mono text-[11px] tracking-[.04em] text-mute">{t.number}</div>
                  <div className="mt-0.5 text-[10px] uppercase tracking-[.08em] text-hint">
                    {CATEGORY_LABEL[t.category]}
                  </div>
                </div>

                <div className="min-w-0">
                  <div className="truncate text-[14px] font-semibold text-ink">{t.subject}</div>
                  {t.description && (
                    <div className="mt-0.5 truncate text-[12px] text-mute">{t.description}</div>
                  )}
                </div>

                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-ink">{t.requesterName}</div>
                  <div className="truncate text-[11px] text-mute">{t.requesterEmail}</div>
                </div>

                <div><StatusPill status={t.status as CaseStatus} /></div>
                <div><PriorityChip priority={t.priority} /></div>

                <div className="min-w-0 truncate text-[13px] text-ink2">
                  {t.assigneeName ?? <span className="text-hint">unassigned</span>}
                </div>

                <div className={cn("text-[12px]", overdue ? "font-semibold text-brand-magenta" : "text-mute")}>
                  {dueLabel}
                  {overdue && <span className="ml-1.5 inline-block rounded-full bg-[rgba(199,25,122,.10)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-brand-magenta">overdue</span>}
                </div>
              </Row>
            );
          })
        )}
      </div>
    </>
  );
}

function Row({ children, hdr = false, href }: { children: React.ReactNode; hdr?: boolean; href?: string }) {
  const cls = cn(
    "grid items-center gap-4 px-[22px] border-b border-rule last:border-b-0 transition",
    hdr
      ? "mono-cap py-3 text-[9.5px] font-semibold tracking-[.12em] text-mute bg-warm cursor-default"
      : "py-3.5 cursor-pointer hover:bg-warm",
  );
  const style = { gridTemplateColumns: "110px 2.4fr 1.6fr 110px 100px 1.2fr 1.2fr" };
  if (href && !hdr) return <Link href={href} className={cls} style={style}>{children}</Link>;
  return <div className={cls} style={style}>{children}</div>;
}

function formatDue(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });
  const time = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
  return `${date} · ${time}`;
}
