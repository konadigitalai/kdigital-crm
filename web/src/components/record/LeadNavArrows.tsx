"use client";

// Prev/next arrows on the lead record page. Reads the ordered list of lead
// numbers from sessionStorage under `decrm_lead_nav_v1`, finds where the
// current record sits, and renders ‹ prev · N of M · next ›.
//
// The list is written by PipelineListView whenever the user clicks a name
// or number cell in /leads or /pipeline. Reading it here means the arrows
// respect whatever sort + filter was active on the list — no extra API,
// no URL parameter, no coupling between routes.
//
// Silent no-op when:
//   - sessionStorage has no snapshot (direct URL, cross-session)
//   - the current lead number isn't in the snapshot (stale snapshot after
//     a filter change; unlikely, but harmless)
//   - the snapshot has only one entry (arrows would be dead)

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";

export const LEAD_NAV_STORAGE_KEY = "decrm_lead_nav_v1";

interface Snapshot {
  numbers: string[];
  savedAt: number;
}

function readSnapshot(): Snapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(LEAD_NAV_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as { numbers?: unknown; savedAt?: unknown };
    if (!Array.isArray(p.numbers)) return null;
    const numbers = p.numbers.filter((n): n is string => typeof n === "string");
    if (numbers.length === 0) return null;
    return { numbers, savedAt: typeof p.savedAt === "number" ? p.savedAt : 0 };
  } catch {
    return null;
  }
}

export function LeadNavArrows({ currentNumber }: { currentNumber: string }) {
  // Read on mount only — the snapshot is set by the list before it
  // navigates here, and doesn't change while the record page is open.
  const [snap, setSnap] = useState<Snapshot | null>(null);
  useEffect(() => { setSnap(readSnapshot()); }, []);

  const router = useRouter();

  // Keyboard shortcuts: [ = prev, ] = next. Matches Superhuman/Front
  // conventions. Guarded so we don't hijack keystrokes while the user
  // is typing in an <input> or <textarea>.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!snap) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = snap.numbers.indexOf(currentNumber);
      if (idx < 0) return;
      if (e.key === "[") {
        const prev = snap.numbers[idx - 1];
        if (prev) { e.preventDefault(); router.push(`/records/${encodeURIComponent(prev)}`); }
      } else if (e.key === "]") {
        const next = snap.numbers[idx + 1];
        if (next) { e.preventDefault(); router.push(`/records/${encodeURIComponent(next)}`); }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snap, currentNumber, router]);

  if (!snap) return null;
  const idx = snap.numbers.indexOf(currentNumber);
  if (idx < 0 || snap.numbers.length < 2) return null;

  const prev = idx > 0 ? snap.numbers[idx - 1] : null;
  const next = idx < snap.numbers.length - 1 ? snap.numbers[idx + 1] : null;

  return (
    <div className="flex items-center gap-1.5">
      <NavButton
        href={prev ? `/records/${encodeURIComponent(prev)}` : null}
        title={prev ? `Previous lead (${prev}) · [` : "No previous lead"}
        aria-label="Previous lead"
        rotate180
      />
      <span className="mono-cap px-1 text-[10.5px] tracking-[.06em] text-mute">
        {idx + 1} <span className="text-hint">of</span> {snap.numbers.length}
      </span>
      <NavButton
        href={next ? `/records/${encodeURIComponent(next)}` : null}
        title={next ? `Next lead (${next}) · ]` : "No next lead"}
        aria-label="Next lead"
      />
    </div>
  );
}

function NavButton({
  href, title, rotate180,
  "aria-label": ariaLabel,
}: {
  href: string | null;
  title: string;
  rotate180?: boolean;
  "aria-label": string;
}) {
  const glyph = (
    <Icon name="arrow-right" size={13} strokeWidth={2.2} className={rotate180 ? "rotate-180" : ""} />
  );
  const base = "inline-flex h-7 w-7 items-center justify-center rounded-full border border-rule bg-paper transition";
  if (!href) {
    return (
      <span
        className={`${base} text-hint opacity-40 cursor-not-allowed`}
        title={title}
        aria-label={ariaLabel}
        aria-disabled="true"
      >
        {glyph}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className={`${base} text-ink2 hover:border-brand-violet hover:text-brand-violet`}
      title={title}
      aria-label={ariaLabel}
    >
      {glyph}
    </Link>
  );
}
