"use client";

import Link from "next/link";
import { useMemo } from "react";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField } from "@/components/filter/types";
import { cn } from "@/lib/cn";
import type { EnrolmentStatus, LearnerSummary } from "@/lib/types";

const STATUS_CLS: Record<EnrolmentStatus, string> = {
  active:    "bg-[rgba(46,158,106,.10)] text-state-ok",
  completed: "bg-warm2                  text-mute",
  dropped:   "bg-[rgba(217,83,79,.10)]  text-state-warn",
  deferred:  "bg-[rgba(224,138,30,.12)] text-state-amber",
};

function unique<T>(xs: T[]): T[] { return [...new Set(xs.filter(Boolean))]; }

function buildFields(rows: LearnerSummary[]): FilterField[] {
  const cities   = unique(rows.map((r) => r.city ?? ""));
  const programs = unique(rows.map((r) => r.primaryEnrolment?.programName ?? ""));
  return [
    { key: "name",    label: "Name",    type: "text",   get: (r: LearnerSummary) => r.name },
    { key: "email",   label: "Email",   type: "text",   get: (r: LearnerSummary) => r.email },
    { key: "phone",   label: "Phone",   type: "text",   get: (r: LearnerSummary) => r.phone },
    { key: "city",    label: "City",    type: "enum",   options: cities.filter(Boolean).map((c) => ({ value: c, label: c })),   get: (r: LearnerSummary) => r.city },
    { key: "program", label: "Program", type: "enum",   options: programs.filter(Boolean).map((p) => ({ value: p, label: p })), get: (r: LearnerSummary) => r.primaryEnrolment?.programName ?? null },
    { key: "status",  label: "Enrol status", type: "enum",
      options: [
        { value: "active",    label: "Active",    cls: STATUS_CLS.active },
        { value: "completed", label: "Completed", cls: STATUS_CLS.completed },
        { value: "dropped",   label: "Dropped",   cls: STATUS_CLS.dropped },
        { value: "deferred",  label: "Deferred",  cls: STATUS_CLS.deferred },
      ],
      get: (r: LearnerSummary) => r.primaryEnrolment?.status ?? null },
    { key: "activeBatches", label: "Active batches", type: "number", get: (r: LearnerSummary) => r.activeBatches },
    { key: "totalBatches",  label: "Total batches",  type: "number", get: (r: LearnerSummary) => r.totalBatches },
  ];
}

export function LearnersTable({ learners }: { learners: LearnerSummary[] }) {
  const fields = useMemo(() => buildFields(learners), [learners]);
  const [filtered, state, setState] = useFilter(learners, fields);

  return (
    <>
      <div className="mb-5 rounded-[14px] border border-rule bg-paper p-3">
        <FilterBar
          fields={fields}
          state={state}
          onChange={setState}
          placeholder="Filter learners by field…"
          totalRows={learners.length}
          filteredRows={filtered.length}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <Row hdr>
          <div>Learner</div>
          <div>Program</div>
          <div className="text-center">Batches</div>
          <div>Status</div>
          <div className="text-right">Joined</div>
        </Row>

        {filtered.length === 0 ? (
          <div className="px-[22px] py-12 text-center text-[13px] text-mute">
            {learners.length === 0
              ? "No learners yet. Convert a lead from the record page to start."
              : "No learners match the current filter."}
          </div>
        ) : (
          filtered.map((l) => (
            <Link key={l.partyId} href={`/learners/${l.partyId}`}>
              <Row hover>
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-grad-violet text-[12px] font-bold text-white">
                    {(l.attributes?.initials ?? l.name.slice(0, 2).toUpperCase()).slice(0, 2)}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-semibold tracking-[-.005em]">{l.name}</div>
                    <div className="truncate text-[12px] text-mute">{l.email ?? "—"}</div>
                  </div>
                </div>
                <div className="truncate text-[13px] text-ink2 font-medium">{l.primaryEnrolment?.programName ?? "—"}</div>
                <div className="text-center text-[13px]">
                  {l.activeBatches > 0 ? (
                    <span className="rounded-full bg-grad-soft px-2 py-0.5 font-mono text-[11px] font-semibold text-brand-violet">
                      {l.activeBatches}{l.totalBatches > l.activeBatches ? `/${l.totalBatches}` : ""}
                    </span>
                  ) : (
                    <span className="text-mute">{l.totalBatches > 0 ? l.totalBatches : "—"}</span>
                  )}
                </div>
                <div>
                  {l.primaryEnrolment ? (
                    <span className={cn("mono-cap inline-flex items-center rounded-full px-2 py-0.5 text-[9.5px] font-semibold", STATUS_CLS[l.primaryEnrolment.status])}>
                      {l.primaryEnrolment.status}
                    </span>
                  ) : (
                    <span className="text-[12px] text-mute">No enrolment</span>
                  )}
                </div>
                <div className="text-right font-mono text-[11px] text-mute">
                  {new Date(l.learnerSince).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                </div>
              </Row>
            </Link>
          ))
        )}
      </div>
    </>
  );
}

function Row({ hdr = false, hover = false, children }: { hdr?: boolean; hover?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid items-center gap-4 px-[22px] border-b border-rule last:border-b-0 transition",
        hdr ? "mono-cap py-3 text-[9.5px] font-semibold tracking-[.12em] text-mute bg-warm" : "py-3.5",
        hover && !hdr && "cursor-pointer hover:bg-warm",
      )}
      style={{ gridTemplateColumns: "2.4fr 1.8fr 90px 130px 140px" }}
    >
      {children}
    </div>
  );
}
