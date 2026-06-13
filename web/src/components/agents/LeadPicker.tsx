"use client";

// Searchable single-select for picking one lead. The list is small (under
// 100 active leads in dev), so a flat <select> with all options + a small
// search input that filters them client-side is enough.

import { useMemo, useState } from "react";
import type { Lead } from "@/lib/types";
import { ratingStyles } from "@/lib/ui";
import { cn } from "@/lib/cn";

export function LeadPicker({
  leads,
  value,
  onChange,
  disabled,
}: {
  leads: Lead[];
  value: string | null;
  onChange: (leadNumber: string | null) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return leads;
    return leads.filter((l) =>
      l.name.toLowerCase().includes(needle) ||
      l.number.toLowerCase().includes(needle) ||
      l.program?.toLowerCase().includes(needle) ||
      l.city?.toLowerCase().includes(needle),
    );
  }, [leads, q]);

  return (
    <div className="space-y-2">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name, number, program, city…"
        disabled={disabled}
        className="w-full rounded-[10px] border border-rule bg-paper px-3 py-2 text-[13px] focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
      />
      <div className="max-h-[280px] overflow-y-auto rounded-[10px] border border-rule bg-paper">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-mute">No leads match.</div>
        ) : (
          filtered.map((l) => {
            const r = ratingStyles[l.rating];
            const on = value === l.number;
            return (
              <button
                key={l.id}
                type="button"
                disabled={disabled}
                onClick={() => onChange(l.number)}
                className={cn(
                  "flex w-full items-center gap-3 border-b border-rule px-3 py-2 text-left last:border-b-0 transition",
                  on ? "bg-grad-soft" : "hover:bg-warm",
                )}
              >
                <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-semibold", r.bg, r.text)}>
                  <span className={cn("h-1.5 w-1.5 rounded-full", r.dot)} />
                  {r.label}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold tracking-[-.005em]">{l.name}</div>
                  <div className="mono-cap mt-0.5 text-[10px] tracking-[.04em] text-mute">
                    {l.number} · {l.program ?? "no program"} · {l.city ?? "—"}
                  </div>
                </div>
                <span className="font-mono text-[11px] tracking-[.04em] text-mute">{l.score}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
