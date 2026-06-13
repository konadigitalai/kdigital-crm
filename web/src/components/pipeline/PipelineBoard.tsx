"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/Icon";
import { ScoreRing } from "@/components/ui/ScoreRing";
import { NewLeadButton } from "@/components/leads/NewLeadDialog";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField, FilterState } from "@/components/filter/types";
import { avatarGradClass, ratingStyles } from "@/lib/ui";
import { cn } from "@/lib/cn";
import { updateLead } from "@/lib/api";
import type { Lead, LeadRating, PipelineColumn } from "@/lib/types";
import { LEAD_RATINGS } from "@/lib/types";

const DRAG_MIME = "application/x-decrm-lead";

// ─── helpers ──────────────────────────────────────────────────────────────

// Pipeline columns are keyed on lead.rating now. Visual styles come from
// ratingStyles (lib/ui) — this map is just the dot color for the column header.
const colDot: Record<LeadRating, string> = {
  "new lead": "bg-brand-blue",
  attempted:  "bg-brand-violet",
  cold:       "bg-mute",
  warm:       "bg-state-amber",
  hot:        "bg-brand-magenta",
  superhot:   "bg-brand-magenta",
  enrolled:   "bg-state-ok",
};

// Hex equivalents — used by the Chart view's SVG fills.
const colHex: Record<LeadRating, string> = {
  "new lead": "#1F3FCF",
  attempted:  "#6B1FB8",
  cold:       "#A89DAC",
  warm:       "#E08A1E",
  hot:        "#C7197A",
  superhot:   "#C7197A",
  enrolled:   "#2E9E6A",
};

const RATING_OPTIONS = LEAD_RATINGS.map((r) => ({ value: r, label: ratingStyles[r].label }));

function unique<T>(xs: T[]): T[] { return [...new Set(xs.filter(Boolean))]; }

function buildFields(allLeads: Lead[]): FilterField[] {
  const programs = unique(allLeads.map((l) => l.program));
  const cities   = unique(allLeads.map((l) => l.city));
  return [
    { key: "name",       label: "Name",        type: "text",   get: (l: Lead) => l.name },
    { key: "number",     label: "Lead #",      type: "text",   get: (l: Lead) => l.number },
    { key: "program",    label: "Program",     type: "enum",   options: programs.map((p) => ({ value: p, label: p })), get: (l: Lead) => l.program },
    { key: "city",       label: "City",        type: "enum",   options: cities.map((c) => ({ value: c, label: c })),   get: (l: Lead) => l.city },
    { key: "rating",     label: "Rating",      type: "enum",   options: RATING_OPTIONS,                                get: (l: Lead) => l.rating },
    { key: "score",      label: "Score",       type: "number", get: (l: Lead) => l.score },
    { key: "nbaLabel",   label: "Next action", type: "text",   get: (l: Lead) => l.nbaLabel },
    { key: "nextFollowupAt", label: "Next follow-up", type: "date", get: (l: Lead) => l.nextFollowupAt },
    { key: "demoAttendedAt", label: "Demo attended",  type: "date", get: (l: Lead) => l.demoAttendedAt },
  ];
}

// Parse "₹1.49L" / "₹99k" / "₹2.4Cr" → number (rupees)
function parseINR(s: string | null | undefined): number {
  if (!s) return 0;
  const m = s.match(/^₹([\d.]+)([CrLk]+)?$/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (m[2] === "Cr") return n * 1_00_00_000;
  if (m[2] === "L")  return n * 1_00_000;
  if (m[2] === "k")  return n * 1_000;
  return n;
}

function fmtINR(n: number): string {
  if (!n) return "—";
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(1).replace(/\.0$/, "")}Cr`;
  if (n >= 1_00_000)    return `₹${Math.round(n / 1_00_000)}L`;
  if (n >= 1_000)       return `₹${Math.round(n / 1_000)}k`;
  return `₹${Math.round(n)}`;
}

// ─── top-level component ──────────────────────────────────────────────────

type ViewMode = "list" | "kanban" | "chart";

export function PipelineBoard({ columns }: { columns: PipelineColumn[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Local copy of all leads for optimistic drag-drop. Re-syncs from props when
  // the server returns fresh data (router.refresh) — but only when the prop
  // actually changes, so optimistic edits aren't reverted instantly.
  const incomingAllLeads: Lead[] = useMemo(() => columns.flatMap((c) => c.leads as Lead[]), [columns]);
  const [localLeads, setLocalLeads] = useState<Lead[]>(incomingAllLeads);
  const incomingKey = useMemo(
    () => incomingAllLeads.map((l) => `${l.id}:${l.rating}`).join("|"),
    [incomingAllLeads],
  );
  // Re-sync local state when the server data changes.
  useMemo(() => { setLocalLeads(incomingAllLeads); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [incomingKey]);

  const fields = useMemo(() => buildFields(localLeads), [localLeads]);
  const [filtered, state, setState] = useFilter(localLeads, fields);
  const [view, setView] = useState<ViewMode>("kanban");
  const [dragError, setDragError] = useState<string | null>(null);

  const filteredByRating = useMemo(() => {
    const m = new Map<LeadRating, Lead[]>();
    for (const l of filtered) {
      const arr = m.get(l.rating) ?? [];
      arr.push(l);
      m.set(l.rating, arr);
    }
    return m;
  }, [filtered]);

  // Optimistic drag-drop: change local state immediately, fire PATCH, roll
  // back on error. router.refresh keeps the per-column sums + AI strip
  // notes accurate after a successful drop.
  async function onDrop(leadId: string, fromRating: LeadRating, toRating: LeadRating) {
    if (fromRating === toRating) return;
    const before = localLeads;
    setLocalLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, rating: toRating } : l)));
    try {
      const target = before.find((l) => l.id === leadId);
      if (!target) throw new Error("Lead not found in local state");
      await updateLead(target.number, { rating: toRating });
      startTransition(() => router.refresh());
    } catch (err) {
      setLocalLeads(before);
      setDragError(`Couldn't update rating: ${(err as Error).message}`);
      setTimeout(() => setDragError(null), 4000);
    }
  }

  // Recompute counts and sums from local state so columns stay in sync after
  // an optimistic drop without waiting for router.refresh to complete.
  const liveColumns = useMemo(() => {
    return columns.map((col) => {
      const inCol = localLeads.filter((l) => l.rating === col.key);
      return { ...col, count: inCol.length, leads: inCol };
    });
  }, [columns, localLeads]);

  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <ViewSwitcher value={view} onChange={setView} />
        <div className="flex-1 rounded-[14px] border border-rule bg-paper p-3">
          <FilterBar
            fields={fields}
            state={state}
            onChange={setState}
            placeholder="Filter pipeline by field…"
            totalRows={localLeads.length}
            filteredRows={filtered.length}
          />
        </div>
      </div>

      {dragError && (
        <div className="mb-3 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
          {dragError}
        </div>
      )}

      {view === "kanban" && <KanbanView columns={liveColumns} byRating={filteredByRating} state={state} onDrop={onDrop} />}
      {view === "list"   && <ListView   columns={liveColumns} byRating={filteredByRating} />}
      {view === "chart"  && <ChartView  columns={liveColumns} byRating={filteredByRating} />}
    </>
  );
}

// ─── ViewSwitcher (segmented control) ─────────────────────────────────────

function ViewSwitcher({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  const items: { key: ViewMode; label: string; icon: IconName }[] = [
    { key: "list",   label: "List",   icon: "bars" },
    { key: "kanban", label: "Kanban", icon: "agents-grid" },
    { key: "chart",  label: "Chart",  icon: "chart" },
  ];
  return (
    <div className="inline-flex rounded-full border border-rule bg-paper p-1 text-[12.5px]">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-semibold transition",
            value === it.key ? "bg-ink text-white" : "text-ink2 hover:bg-warm",
          )}
        >
          <Icon name={it.icon} size={13} strokeWidth={2} />
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ─── Kanban ───────────────────────────────────────────────────────────────

function KanbanView({
  columns, byRating, state, onDrop,
}: {
  columns: PipelineColumn[];
  byRating: Map<LeadRating, Lead[]>;
  state: FilterState;
  onDrop: (leadId: string, fromRating: LeadRating, toRating: LeadRating) => void;
}) {
  // Track which column is being hovered with a dragged card so we can
  // highlight it as a valid drop target.
  const [hoverRating, setHoverRating] = useState<LeadRating | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Safety net: when the optimistic drop reorders the lead into another
  // column, React unmounts the source <Link> before the browser delivers the
  // synthetic `dragend`, so its onDragEnd handler never fires and the card
  // stays stuck at opacity-40. A window-level listener doesn't depend on any
  // particular DOM node and always cleans up.
  useEffect(() => {
    function clear() { setDraggingId(null); setHoverRating(null); }
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);

  return (
    <div
      className="grid items-start gap-3.5 overflow-x-auto pb-2"
      style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(248px, 1fr))` }}
    >
      {columns.map((col) => {
        const colLeads = byRating.get(col.key) ?? [];
        const isHover = hoverRating === col.key;
        return (
          <div
            key={col.key}
            onDragOver={(e) => {
              // Allow drops only when carrying our own MIME type.
              if (e.dataTransfer.types.includes(DRAG_MIME)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (hoverRating !== col.key) setHoverRating(col.key);
              }
            }}
            onDragLeave={(e) => {
              // Only clear when actually leaving the column container.
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setHoverRating((curr) => (curr === col.key ? null : curr));
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              // Clear drag state up-front so the source card doesn't stay
              // dimmed across the optimistic re-mount in the new column.
              setDraggingId(null);
              setHoverRating(null);
              const raw = e.dataTransfer.getData(DRAG_MIME);
              if (!raw) return;
              try {
                const { id, fromRating } = JSON.parse(raw) as { id: string; fromRating: LeadRating };
                onDrop(id, fromRating, col.key);
              } catch { /* ignore malformed payload */ }
            }}
            className={cn(
              "flex flex-col rounded-2xl border bg-warm transition",
              isHover ? "border-brand-violet ring-2 ring-brand-violet/30 bg-warm2" : "border-rule",
            )}
            style={{ maxHeight: "calc(100vh - 250px)" }}
          >
            <div className="flex items-center gap-[9px] p-[14px_16px_12px]">
              <span className={cn("h-[9px] w-[9px] flex-shrink-0 rounded-full", colDot[col.key])} />
              <span className="text-[13.5px] font-bold tracking-[-.01em]">{col.label}</span>
              <span className="rounded-full border border-rule bg-warm2 px-2 py-0.5 font-mono text-[10px] font-semibold text-mute">
                {state.rules.length > 0 ? `${colLeads.length}/${col.count}` : col.count}
              </span>
              <span className="ml-auto font-mono text-[10px] tracking-[.04em] text-mute">{col.sum}</span>
            </div>

            {col.aiNote && (
              <div
                className="mx-3 mb-2.5 flex items-center gap-2.5 rounded-[11px] border p-[10px_12px] text-[11.5px] leading-[1.35] text-ink2"
                style={{
                  background: "linear-gradient(120deg,rgba(199,25,122,.08),rgba(107,31,184,.06))",
                  borderColor: "rgba(199,25,122,.2)",
                }}
              >
                <span className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-[7px] bg-grad">
                  <Icon name="star" size={12} strokeWidth={2} className="text-white" />
                </span>
                <span dangerouslySetInnerHTML={{ __html: col.aiNote.replace(/\*\*(.+?)\*\*/g, "<b class='font-bold text-ink'>$1</b>") }} />
              </div>
            )}

            <div className="flex flex-col gap-2.5 overflow-y-auto px-3 pb-3">
              {colLeads.map((l) => {
                const ai = l.score >= 85 && (l.rating === "hot" || l.rating === "superhot");
                const isDragging = draggingId === l.id;
                return (
                  <Link
                    key={l.id}
                    href={`/records/${l.number}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData(
                        DRAG_MIME,
                        JSON.stringify({ id: l.id, fromRating: l.rating }),
                      );
                      setDraggingId(l.id);
                    }}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setHoverRating(null);
                    }}
                    onClick={(e) => {
                      // Suppress the navigate when a drag has just finished.
                      if (draggingId) e.preventDefault();
                    }}
                    className={cn(
                      "group block rounded-[13px] border bg-paper p-3.5 transition hover:-translate-y-0.5 hover:border-rule2 hover:shadow-card",
                      "cursor-grab active:cursor-grabbing",
                      ai ? "border-[rgba(199,25,122,.28)] shadow-glowSoft" : "border-rule",
                      isDragging && "opacity-40 ring-2 ring-brand-violet/40",
                    )}
                  >
                    <div className="mb-2.5 flex items-center gap-2.5">
                      <div className={cn("flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white", avatarGradClass[l.avatar])}>
                        {l.initials}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-semibold tracking-[-.005em]">{l.name}</div>
                        <div className="mt-px font-mono text-[9px] tracking-[.04em] text-mute">{l.number} · {l.city}</div>
                      </div>
                      <ScoreRing score={l.score} heat={l.heat} size={30} inner={23} fontSize={10} />
                    </div>
                    <div className="text-[12px] font-medium text-ink2">{l.program}</div>
                    <div className="mt-1 font-mono text-[10px] tracking-[.04em] text-mute">{l.value}</div>
                    <div
                      className={cn(
                        "mt-[11px] flex items-center gap-2 border-t border-dashed border-rule pt-2.5 text-[11.5px]",
                        l.nbaGhost ? "text-mute" : "text-ink2",
                      )}
                    >
                      <span className={cn("flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-[5px]", l.nbaGhost ? "bg-warm2" : "bg-grad-soft")}>
                        <Icon name={l.nbaIcon as IconName} size={10} strokeWidth={2} className={l.nbaGhost ? "text-mute" : "text-brand-violet"} />
                      </span>
                      {l.nbaLabel}
                    </div>
                  </Link>
                );
              })}
              {state.rules.length === 0 && <NewLeadButton variant="ghost" defaultRating={col.key} />}
              {colLeads.length === 0 && (
                <div className="rounded-[11px] border border-dashed border-rule2 p-4 text-center text-[11.5px] text-mute">
                  Drop a lead here to mark as <b className="font-semibold text-ink">{col.label}</b>.
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── List (flat table grouped by stage) ───────────────────────────────────

function ListView({
  columns, byRating,
}: {
  columns: PipelineColumn[];
  byRating: Map<LeadRating, Lead[]>;
}) {
  const visibleColumns = columns.filter((c) => (byRating.get(c.key) ?? []).length > 0);

  if (visibleColumns.length === 0) {
    return (
      <div className="rounded-2xl border border-rule bg-paper p-12 text-center text-[13px] text-mute">
        No leads match the current filter.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
      {/* Sticky header */}
      <Row hdr>
        <div>Lead</div>
        <div>Program</div>
        <div className="text-center">Score</div>
        <div className="text-right">Value</div>
        <div>Next action</div>
      </Row>

      {visibleColumns.map((col) => {
        const colLeads = byRating.get(col.key) ?? [];
        const sc = ratingStyles[col.key];
        return (
          <div key={col.key}>
            {/* Section header */}
            <div className="grid items-center gap-4 border-b border-rule bg-warm px-[22px] py-2"
                 style={{ gridTemplateColumns: "2.6fr 1.4fr 90px 110px 1.4fr" }}>
              <div className="flex items-center gap-2.5">
                <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold", sc.bg, sc.text)}>
                  <span className={cn("h-1.5 w-1.5 rounded-full", sc.dot)} />
                  {col.label}
                </span>
                <span className="font-mono text-[10.5px] text-mute">
                  {colLeads.length} of {col.count}
                </span>
              </div>
              <div />
              <div />
              <div className="text-right font-mono text-[10.5px] text-mute">{col.sum}</div>
              <div />
            </div>

            {/* Section rows */}
            {colLeads.map((l) => (
              <Link key={l.id} href={`/records/${l.number}`}>
                <Row hover>
                  <div className="flex min-w-0 items-center gap-3">
                    <div className={cn("flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white", avatarGradClass[l.avatar])}>
                      {l.initials}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-semibold tracking-[-.005em]">{l.name}</div>
                      <div className="mono-cap mt-0.5 text-[9.5px] tracking-[.04em] text-mute">{l.number} · {l.city}</div>
                    </div>
                  </div>
                  <div className="text-[13px] text-ink2">
                    <div className="truncate font-semibold text-ink">{l.program}</div>
                  </div>
                  <div className="flex items-center justify-center">
                    <ScoreRing score={l.score} heat={l.heat} size={30} inner={23} fontSize={10} />
                  </div>
                  <div className="text-right font-mono text-[12px] text-ink2">
                    {l.value || "—"}
                  </div>
                  <div className="flex items-center gap-2 text-[12px] text-ink2">
                    <span className={cn("flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md", l.nbaGhost ? "bg-warm2" : "bg-grad-soft")}>
                      <Icon name={l.nbaIcon as IconName} size={11} strokeWidth={2} className={l.nbaGhost ? "text-mute" : "text-brand-violet"} />
                    </span>
                    <span className={cn("truncate", l.nbaGhost && "text-mute")}>{l.nbaLabel}</span>
                  </div>
                </Row>
              </Link>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Row({ hdr = false, hover = false, children }: { hdr?: boolean; hover?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid items-center gap-4 border-b border-rule px-[22px] last:border-b-0 transition",
        hdr
          ? "mono-cap py-3 text-[9.5px] font-semibold tracking-[.12em] text-mute bg-warm/60 cursor-default"
          : "py-3 cursor-pointer",
        hover && !hdr && "hover:bg-warm/60",
      )}
      style={{ gridTemplateColumns: "2.6fr 1.4fr 90px 110px 1.4fr" }}
    >
      {children}
    </div>
  );
}

// ─── Chart (funnel + bar, SVG) ────────────────────────────────────────────

function ChartView({
  columns, byRating,
}: {
  columns: PipelineColumn[];
  byRating: Map<LeadRating, Lead[]>;
}) {
  // Per rating: count + ₹ sum (computed from filtered leads; falls back to col.sum text)
  const data = columns.map((col) => {
    const leads = byRating.get(col.key) ?? [];
    const sumNum = leads.reduce((s, l) => s + parseINR(l.value), 0);
    return {
      rating: col.key,
      label: col.label,
      count: leads.length,
      sum: sumNum,
    };
  });

  const totalCount = data.reduce((s, d) => s + d.count, 0);
  const totalSum   = data.reduce((s, d) => s + d.sum, 0);
  const maxCount   = Math.max(1, ...data.map((d) => d.count));
  const maxSum     = Math.max(1, ...data.map((d) => d.sum));

  return (
    <div className="grid grid-cols-2 gap-5">
      {/* Funnel */}
      <div className="rounded-2xl border border-rule bg-paper p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="mono-cap text-[10px] font-semibold tracking-[.14em] text-brand-violet">Funnel</div>
            <div className="mt-0.5 text-[14px] font-bold">Lead count by stage</div>
          </div>
          <div className="font-mono text-[10.5px] text-mute">{totalCount} total</div>
        </div>

        <div className="flex flex-col gap-2.5">
          {data.map((d) => {
            const widthPct = (d.count / maxCount) * 100;
            const sharePct = totalCount > 0 ? Math.round((d.count / totalCount) * 100) : 0;
            return (
              <div key={d.rating} className="flex items-center gap-3">
                <div className="w-[110px] flex-shrink-0 text-[12.5px] font-medium text-ink2">{d.label}</div>
                <div className="relative flex-1 overflow-hidden rounded-md bg-warm2/60">
                  <div
                    className="h-7 rounded-md transition-all"
                    style={{
                      width: `${Math.max(2, widthPct)}%`,
                      background: colHex[d.rating],
                      opacity: d.count === 0 ? 0.18 : 0.9,
                    }}
                  />
                  <div className="absolute inset-0 flex items-center justify-between px-2.5">
                    <span className="text-[11.5px] font-bold text-white" style={{ mixBlendMode: "difference" }}>
                      {d.count}
                    </span>
                    <span className="font-mono text-[10px] text-mute">{sharePct}%</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ₹ bar chart */}
      <div className="rounded-2xl border border-rule bg-paper p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="mono-cap text-[10px] font-semibold tracking-[.14em] text-brand-violet">Value</div>
            <div className="mt-0.5 text-[14px] font-bold">₹ open by stage</div>
          </div>
          <div className="font-mono text-[10.5px] text-mute">{fmtINR(totalSum)} total</div>
        </div>

        <div className="flex h-[260px] items-end gap-3 border-b border-rule pb-2">
          {data.map((d) => {
            const h = d.sum === 0 ? 4 : Math.max(8, (d.sum / maxSum) * 220);
            return (
              <div key={d.rating} className="flex flex-1 flex-col items-center gap-2">
                <div className="font-mono text-[10px] text-mute">{fmtINR(d.sum)}</div>
                <div
                  className="w-full rounded-t-md transition-all"
                  style={{
                    height: `${h}px`,
                    background: `linear-gradient(180deg, ${colHex[d.rating]}, ${colHex[d.rating]}cc)`,
                    opacity: d.sum === 0 ? 0.25 : 1,
                  }}
                  title={`${d.label}: ${fmtINR(d.sum)}`}
                />
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex gap-3">
          {data.map((d) => (
            <div key={d.rating} className="flex flex-1 flex-col items-center text-center">
              <div className="text-[11px] font-semibold text-ink2 truncate w-full">{d.label}</div>
              <div className="mono-cap text-[9px] tracking-[.06em] text-mute">{d.count} lead{d.count === 1 ? "" : "s"}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
