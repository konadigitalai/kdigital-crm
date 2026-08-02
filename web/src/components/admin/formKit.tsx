"use client";

// Shared pieces for the admin tables.
//
// ProgramsTable, CoursesTable and friends each grew their own copy of the
// same dialog shell, field label, input class and toggle. Five more modules
// landing at once made that a real cost, so the shapes live here now. The
// existing tables still carry their local copies; this is not a rewrite of
// them, it is the thing the new ones build on.

import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";

export const inputCls =
  "w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 text-[13.5px] text-ink " +
  "placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20";

export function Field({
  label, required, hint, children,
}: {
  label: string; required?: boolean; hint?: string; children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">
        {label}{required && <span className="ml-1 text-brand-magenta">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-[1.45] text-hint">{hint}</span>}
    </label>
  );
}

export function DialogShell({
  title, subtitle, wide = false, onClose, children,
}: {
  title: string; subtitle?: string; wide?: boolean;
  onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className={cn(
          "my-12 w-full rounded-2xl border border-rule bg-paper p-7 shadow-card",
          wide ? "max-w-[860px]" : "max-w-[640px]",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[26px] font-normal leading-tight tracking-[-.01em]">{title}</h2>
            {subtitle && <p className="mt-1 text-[13px] leading-[1.5] text-mute">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A pill. `tone` maps to the app's state colours rather than raw hex so a
 *  theme change reaches every module at once. */
export function Pill({
  tone = "neutral", children, title,
}: {
  tone?: "neutral" | "good" | "warn" | "bad" | "info" | "brand";
  children: React.ReactNode; title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-warm2 text-mute",
    good:    "bg-state-ok/12 text-state-ok",
    warn:    "bg-state-warn/12 text-state-warn",
    bad:     "bg-state-bad/12 text-state-bad",
    info:    "bg-brand-violet/10 text-brand-violet",
    brand:   "bg-grad-soft text-brand-violet",
  };
  return (
    <span
      title={title}
      className={cn(
        "mono-cap inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5",
        "text-[9px] font-semibold tracking-[.08em]",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/** The permanent registry identifier, rendered so it reads as a machine key
 *  and not as a name someone can edit. */
export function RegistryId({ id }: { id: string | null | undefined }) {
  if (!id) return null;
  return (
    <span
      title="Permanent registry identifier — credit and certificates resolve by this, never by name (CAT-001)"
      className="rounded bg-warm2 px-1.5 py-0.5 font-mono text-[10.5px] tracking-tight text-mute"
    >
      {id}
    </span>
  );
}

export function ToggleSwitch({
  enabled, busy, onClick, title,
}: {
  enabled: boolean; busy?: boolean; onClick: () => void; title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={title ?? (enabled ? "Click to deactivate" : "Click to reactivate")}
      className={cn(
        "relative h-[22px] w-[40px] flex-shrink-0 rounded-full transition disabled:opacity-50",
        enabled ? "bg-grad" : "bg-rule2",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all",
          enabled ? "left-[20px]" : "left-0.5",
        )}
      />
    </button>
  );
}

/** A grid row whose column template the caller owns. `hdr` renders the
 *  header treatment; `dimmed` is for retired / inactive rows. */
export function GridRow({
  cols, hdr = false, dimmed = false, onClick, children,
}: {
  cols: string; hdr?: boolean; dimmed?: boolean;
  onClick?: () => void; children: React.ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "grid items-center gap-4 border-b border-rule px-[22px] transition last:border-b-0",
        hdr
          ? "mono-cap bg-warm py-3 text-[9.5px] font-semibold tracking-[.12em] text-mute"
          : "py-3.5",
        dimmed && !hdr && "bg-warm/40",
        onClick && !hdr && "cursor-pointer hover:bg-warm/60",
      )}
      style={{ gridTemplateColumns: cols }}
    >
      {children}
    </div>
  );
}

export function EmptyRow({ children }: { children: React.ReactNode }) {
  return <div className="px-[22px] py-10 text-center text-[13px] text-mute">{children}</div>;
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mt-4 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
      {message}
    </div>
  );
}

/** Comma-or-chip editor for the text[] columns (skills, certifications,
 *  languages). Stores an array; accepts paste of a comma-separated list,
 *  which is how these arrive from a job description. */
export function TagInput({
  value, onChange, placeholder,
}: {
  value: string[]; onChange: (next: string[]) => void; placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...value];
    for (const p of parts) {
      // Case-insensitive dedupe, matching what the API does on the way in.
      if (!next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p);
    }
    onChange(next);
    setDraft("");
  }

  return (
    <div className="rounded-[10px] border border-rule bg-paper p-2 focus-within:border-brand-violet">
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-grad-soft px-2.5 py-1 text-[11.5px] font-semibold text-brand-violet"
            >
              {tag}
              <button
                type="button"
                onClick={() => onChange(value.filter((t) => t !== tag))}
                className="opacity-60 hover:opacity-100"
                aria-label={`Remove ${tag}`}
              >
                <Icon name="plus" size={11} strokeWidth={2.6} className="rotate-45" />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(draft); }
          // Backspace on an empty box removes the last chip — standard for
          // this control, and faster than aiming at the little ×.
          if (e.key === "Backspace" && !draft && value.length > 0) onChange(value.slice(0, -1));
        }}
        onBlur={() => commit(draft)}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (text.includes(",")) { e.preventDefault(); commit(text); }
        }}
        placeholder={placeholder ?? "Type and press Enter…"}
        className="w-full bg-transparent px-1 py-1 text-[13.5px] text-ink outline-none placeholder:text-hint"
      />
    </div>
  );
}

/** Turns 'notice_period' into 'Notice period' — the enum vocabularies are
 *  snake_case in SQL and should never be shown that way. */
export function humanise(value: string | null | undefined): string {
  if (!value) return "—";
  const s = value.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Rupees, grouped Indian-style. Accepts the numeric-as-string the API
 *  returns; null renders as an em dash rather than ₹0, because "no price
 *  set" and "free" are different facts. */
export function formatMoney(value: string | number | null | undefined, currency = "INR"): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  return symbol + n.toLocaleString(currency === "INR" ? "en-IN" : "en-US", { maximumFractionDigits: 0 });
}

/** "18 months" → "1y 6m". Requisitions and candidates both store experience
 *  in months so that sub-year ranges are expressible; nobody reads it that way. */
export function formatMonths(months: number | null | undefined): string {
  if (months === null || months === undefined) return "—";
  if (months === 0) return "Fresher";
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m}m`;
  if (m === 0) return `${y}y`;
  return `${y}y ${m}m`;
}

/** Stable list of the distinct non-empty values of one field, for filter
 *  dropdowns. Memoise at the call site. */
export function distinct<T>(rows: T[], get: (row: T) => string | null | undefined): string[] {
  return [...new Set(rows.map(get).filter(Boolean) as string[])].sort();
}

export function useDistinct<T>(rows: T[], get: (row: T) => string | null | undefined): string[] {
  return useMemo(() => distinct(rows, get), [rows, get]);
}
