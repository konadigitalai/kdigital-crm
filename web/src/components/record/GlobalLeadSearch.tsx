"use client";

// Global lead-picker on the record page.
//
// A compact search input in the Topbar's centerSlot that lets an advisor
// jump to any other lead without going back to /leads. Clicks the name or
// hits Enter → routes to /records/<number>.
//
// Data source: /leads (returns every live lead). Filtered client-side by
// name / number / phone / email substring. Debounced 120ms so typing feels
// smooth. Menu closes on outside click, Escape, or after navigation.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { getLeads } from "@/lib/api";
import type { Lead } from "@/lib/types";

export function GlobalLeadSearch({ currentNumber }: { currentNumber?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [rows, setRows] = useState<Lead[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Lazy-load the lead list the first time the input is focused. Reused
  // across every open/close cycle — the record page is usually short-lived,
  // so a fresh fetch per mount is fine.
  useEffect(() => {
    if (!open || rows !== null) return;
    getLeads()
      .then((r) => setRows(r))
      .catch((e) => setLoadErr((e as Error).message));
  }, [open, rows]);

  // Debounce the query so we're not filtering on every keystroke of a big list.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim().toLowerCase()), 120);
    return () => clearTimeout(t);
  }, [query]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (wrapRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Escape closes; Cmd/Ctrl-K opens + focuses.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isK = e.key === "k" || e.key === "K";
      if ((e.metaKey || e.ctrlKey) && isK) {
        e.preventDefault();
        setOpen(true);
        setTimeout(() => inputRef.current?.focus(), 0);
      }
      if (e.key === "Escape" && open) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const results = useMemo(() => {
    if (rows === null) return [];
    if (!debounced) return rows.slice(0, 12); // sensible default: first 12 leads (by score DESC)
    const q = debounced;
    const scored: Array<{ lead: Lead; rank: number }> = [];
    for (const l of rows) {
      if (l.number === currentNumber) continue; // don't offer to jump to self
      // Priority: exact number match, then name prefix, then any substring.
      const numLc  = (l.number ?? "").toLowerCase();
      const nameLc = (l.name   ?? "").toLowerCase();
      const phone  = (l.phone  ?? "").toLowerCase();
      const email  = (l.email  ?? "").toLowerCase();
      let rank = -1;
      if (numLc === q)           rank = 0;
      else if (nameLc.startsWith(q)) rank = 1;
      else if (numLc.includes(q))    rank = 2;
      else if (nameLc.includes(q))   rank = 3;
      else if (phone.includes(q))    rank = 4;
      else if (email.includes(q))    rank = 5;
      if (rank >= 0) scored.push({ lead: l, rank });
      if (scored.length >= 200) break; // guard on massive lists — cap the scan
    }
    scored.sort((a, b) => a.rank - b.rank);
    return scored.slice(0, 12).map((s) => s.lead);
  }, [rows, debounced, currentNumber]);

  function jumpTo(number: string) {
    setOpen(false);
    setQuery("");
    router.push(`/records/${number}`);
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
        className={cn(
          "flex w-[300px] items-center gap-2 rounded-full border border-rule bg-paper px-3 py-1.5 text-[12.5px] text-mute hover:border-brand-violet hover:text-ink transition",
          open && "border-brand-violet text-ink",
        )}
      >
        <Icon name="search" size={13} strokeWidth={2} />
        <span className="flex-1 text-left">Jump to another lead</span>
        <span className="rounded-md border border-rule bg-warm2 px-1.5 py-0.5 font-mono text-[9px] tracking-[.06em]">⌘K</span>
      </button>

      {open && (
        <div className="absolute left-1/2 top-full z-50 mt-2 w-[420px] -translate-x-1/2 overflow-hidden rounded-[12px] border border-rule bg-paper shadow-card">
          <div className="flex items-center gap-2 border-b border-rule px-3 py-2.5">
            <Icon name="search" size={14} strokeWidth={2} className="text-mute" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && results[0]) {
                  e.preventDefault();
                  jumpTo(results[0].number);
                }
              }}
              placeholder="Search by name, LEAD-…, phone, or email"
              className="flex-1 bg-transparent text-[13.5px] text-ink placeholder:text-hint focus:outline-none"
              aria-label="Search leads"
              autoFocus
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="rounded-md p-0.5 text-mute hover:text-ink"
                aria-label="Clear search"
                type="button"
              >
                <Icon name="plus" size={12} strokeWidth={2} className="rotate-45" />
              </button>
            )}
          </div>
          <div className="max-h-[320px] overflow-y-auto">
            {rows === null && !loadErr && (
              <div className="p-4 text-center text-[12px] text-mute">Loading leads…</div>
            )}
            {loadErr && (
              <div className="p-4 text-[12px] text-state-warn">{loadErr}</div>
            )}
            {rows !== null && !loadErr && results.length === 0 && (
              <div className="p-4 text-center text-[12px] text-mute">
                {debounced ? "No matches." : "Start typing to search."}
              </div>
            )}
            {results.map((l) => (
              <button
                type="button" key={l.id}
                onClick={() => jumpTo(l.number)}
                className="flex w-full items-center gap-3 border-b border-rule px-3 py-2 text-left last:border-0 hover:bg-warm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-ink">{l.name}</div>
                  <div className="mono-cap text-[10.5px] tracking-[.04em] text-mute">
                    {l.number}
                    {l.phone ? ` · ${l.phone}` : ""}
                    {l.program ? ` · ${l.program}` : ""}
                  </div>
                </div>
                <span className={cn(
                  "mono-cap rounded-full px-2 py-0.5 text-[9.5px] tracking-[.06em]",
                  l.rating === "hot" || l.rating === "superhot"
                    ? "bg-state-warn/10 text-state-warn"
                    : l.rating === "warm"
                      ? "bg-state-amber/10 text-state-amber"
                      : "bg-warm text-mute",
                )}>
                  {l.rating}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
