"use client";

import Link from "next/link";
import { Icon, type IconName } from "@/components/ui/Icon";
import { ScoreRing } from "@/components/ui/ScoreRing";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField } from "@/components/filter/types";
import { avatarGradClass, ratingStyles, scoreBand } from "@/lib/ui";
import { cn } from "@/lib/cn";
import type { Lead } from "@/lib/types";
import { LEAD_RATINGS } from "@/lib/types";

const RATING_OPTIONS = LEAD_RATINGS.map((r) => ({ value: r, label: ratingStyles[r].label }));

// Build the field schema from the actual rows so program/source dropdowns
// only list values that exist in the dataset.
function buildFields(leads: Lead[]): FilterField[] {
  const programs = unique(leads.map((l) => l.program));
  const cities   = unique(leads.map((l) => l.city));
  return [
    { key: "name",       label: "Name",       type: "text",   get: (l: Lead) => l.name },
    { key: "number",     label: "Lead #",     type: "text",   get: (l: Lead) => l.number },
    { key: "city",       label: "City",       type: "enum",   options: cities.map((c) => ({ value: c, label: c })),  get: (l: Lead) => l.city },
    { key: "program",    label: "Program",    type: "enum",   options: programs.map((p) => ({ value: p, label: p })), get: (l: Lead) => l.program },
    { key: "rating",     label: "Rating",     type: "enum",   options: RATING_OPTIONS, get: (l: Lead) => l.rating },
    { key: "score",      label: "Score",      type: "number", get: (l: Lead) => l.score },
    { key: "nbaLabel",   label: "Next action",type: "text",   get: (l: Lead) => l.nbaLabel },
    { key: "nextFollowupAt", label: "Next follow-up", type: "date", get: (l: Lead) => l.nextFollowupAt },
    { key: "demoAttendedAt", label: "Demo attended",  type: "date", get: (l: Lead) => l.demoAttendedAt },
  ];
}

function unique<T>(xs: T[]): T[] { return [...new Set(xs.filter(Boolean))]; }

export function LeadsTable({ leads }: { leads: Lead[] }) {
  const fields = buildFields(leads);
  const [filtered, state, setState] = useFilter(leads, fields);

  return (
    <>
      <div className="mb-5 rounded-[14px] border border-rule bg-paper p-3">
        <FilterBar
          fields={fields}
          state={state}
          onChange={setState}
          placeholder="Filter leads by field…"
          totalRows={leads.length}
          filteredRows={filtered.length}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <Row hdr>
          <div />
          <div>Lead</div>
          <div>Interest</div>
          <div>Rating</div>
          <div>AI score</div>
          <div>Next best action</div>
          <div />
        </Row>

        {filtered.length === 0 ? (
          <div className="px-[22px] py-12 text-center text-[13px] text-mute">
            No leads match the current filter.
          </div>
        ) : (
          filtered.map((l) => {
            const sc = ratingStyles[l.rating];
            return (
              <Row key={l.id} href={`/records/${l.number}`}>
                <div className="h-4 w-4 rounded-md border-[1.5px] border-rule2 bg-white" />
                <div className="flex min-w-0 items-center gap-[11px]">
                  <div className={cn("flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-full text-[13px] font-bold text-white", avatarGradClass[l.avatar])}>
                    {l.initials}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-semibold tracking-[-.005em]">{l.name}</div>
                    <div className="mt-0.5 font-mono text-[10px] tracking-[.04em] text-mute">{l.number} · {l.city}</div>
                  </div>
                </div>
                <div className="text-[13px] text-ink2">
                  <div className="font-semibold text-ink">{l.program}</div>
                  <div className="mono-cap mt-0.5 text-[9.5px] tracking-[.04em] text-mute">{l.value}</div>
                </div>
                <div className="text-[13px]">
                  <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold", sc.bg, sc.text)}>
                    <span className={cn("h-1.5 w-1.5 rounded-full", sc.dot)} />
                    {sc.label}
                  </span>
                </div>
                <div>
                  <ScoreRing score={l.score} heat={scoreBand(l.score).heat} />
                </div>
                <div className="flex items-center gap-2 text-[12px] text-ink2">
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md bg-grad-soft">
                    <Icon name={l.nbaIcon as IconName} size={11} strokeWidth={2} className="text-brand-violet" />
                  </span>
                  {l.nbaLabel}
                </div>
                <button className="ml-auto flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-rule bg-paper text-mute hover:border-brand-violet hover:text-brand-violet">
                  →
                </button>
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
  const style = { gridTemplateColumns: "30px 2.4fr 1.5fr 1fr 90px 1.4fr 100px" };
  if (href && !hdr) {
    return <Link href={href} className={cls} style={style}>{children}</Link>;
  }
  return <div className={cls} style={style}>{children}</div>;
}
