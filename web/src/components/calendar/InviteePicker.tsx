"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";

interface Person { id: string; name: string; email: string; role: string }

export function InviteePicker({
  people, value, onChange, organizerId,
}: {
  people: Person[];
  value: string[];
  onChange: (ids: string[]) => void;
  organizerId: string;
}) {
  const [q, setQ] = useState("");
  const picked = useMemo(() => new Set(value), [value]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return people
      .filter((p) => p.id !== organizerId)
      .filter((p) => !term ||
        p.name.toLowerCase().includes(term) ||
        p.email.toLowerCase().includes(term) ||
        p.role.toLowerCase().includes(term),
      );
  }, [people, q, organizerId]);

  function toggle(id: string) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  }

  return (
    <div className="rounded-[10px] border border-rule bg-warm/30 p-2">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name, email, or role…"
        className="mb-2 w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12.5px] text-ink focus:border-brand-violet focus:outline-none"
      />
      <div className="max-h-[260px] overflow-y-auto pr-1">
        {filtered.length === 0 ? (
          <div className="px-2 py-6 text-center text-[12px] text-mute">No matches.</div>
        ) : (
          filtered.map((p) => {
            const on = picked.has(p.id);
            return (
              <label
                key={p.id}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded p-1.5 text-[12.5px] hover:bg-warm",
                  on && "bg-brand-violet/5",
                )}
              >
                <input type="checkbox" checked={on} onChange={() => toggle(p.id)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-ink">{p.name}</div>
                  <div className="truncate text-[11px] text-mute">{p.email} · {p.role}</div>
                </div>
              </label>
            );
          })
        )}
      </div>
      {value.length > 0 && (
        <div className="mt-2 border-t border-rule pt-2 text-[11px] text-mute">
          {value.length} invited
        </div>
      )}
    </div>
  );
}
