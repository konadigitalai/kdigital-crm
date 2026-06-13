"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";

interface Person { id: string; name: string; email: string; role: string }

interface Props {
  people: Person[];
  value: string | null;
  onChange: (id: string | null) => void;
  excludeId?: string | null;
  placeholder?: string;
  disabled?: boolean;
}

// Single-select trainer picker — shows the chosen person as a chip with a clear
// button; clicking opens a small searchable dropdown.
export function TrainerPicker({ people, value, onChange, excludeId, placeholder, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  const chosen = useMemo(() => people.find((p) => p.id === value) ?? null, [people, value]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return people
      .filter((p) => !excludeId || p.id !== excludeId)
      .filter((p) => !term ||
        p.name.toLowerCase().includes(term) ||
        p.email.toLowerCase().includes(term) ||
        p.role.toLowerCase().includes(term),
      );
  }, [people, q, excludeId]);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      {chosen ? (
        <div className="flex items-center gap-2 rounded-[10px] border border-rule bg-paper px-2.5 py-1.5">
          <div className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full bg-grad text-[11px] font-bold text-white">
            {initials(chosen.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-ink">{chosen.name}</div>
            <div className="truncate text-[10.5px] text-mute">{chosen.email} · {chosen.role}</div>
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setOpen((v) => !v)}
            className="rounded border border-rule px-2 py-0.5 text-[11px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet disabled:opacity-50"
          >
            Change
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(null)}
            className="rounded border border-rule px-1.5 py-0.5 text-[11px] font-semibold text-mute hover:border-state-warn hover:text-state-warn disabled:opacity-50"
            title="Clear"
          >
            ✕
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className="w-full rounded-[10px] border border-rule bg-paper px-3 py-2 text-left text-[13px] text-mute hover:border-brand-violet focus:border-brand-violet focus:outline-none disabled:opacity-50"
        >
          {placeholder ?? "— pick a person —"}
        </button>
      )}

      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1.5 overflow-hidden rounded-[10px] border border-rule bg-paper shadow-card">
          <div className="border-b border-rule bg-warm/40 p-2">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, email, or role…"
              className="w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12.5px] text-ink focus:border-brand-violet focus:outline-none"
            />
          </div>
          <div className="max-h-[260px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-mute">No matches.</div>
            ) : (
              filtered.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { onChange(p.id); setOpen(false); setQ(""); }}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-warm",
                    p.id === value && "bg-brand-violet/5",
                  )}
                >
                  <div className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-full bg-warm2 text-[10px] font-bold text-ink2">
                    {initials(p.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-ink">{p.name}</div>
                    <div className="truncate text-[10.5px] text-mute">{p.email} · {p.role}</div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("") || "?";
}
