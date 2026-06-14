"use client";

// InlineField — generic click-to-edit primitive used across the lead record
// page (and anywhere else single-field inline editing is wanted).
//
// State machine:
//   idle ─click─► editing ─Enter/blur─► saving ─ok─► saved ─1.4s─► idle
//                  │  Esc │                  │ err
//                  ▼      ▼                  ▼
//                 idle (no save)           error (red border + tooltip)

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import type { LeadRating } from "@/lib/types";
import { LEAD_RATINGS } from "@/lib/types";
import { ratingStyles } from "@/lib/ui";

export type InlineFieldKind =
  | { kind: "text";     value: string | null; placeholder?: string }
  | { kind: "textarea"; value: string | null; placeholder?: string; minRows?: number }
  | { kind: "email";    value: string | null }
  | { kind: "phone";    value: string | null }
  | { kind: "url";      value: string | null }
  | { kind: "money";    value: string | null }
  | { kind: "number";   value: number | null; min?: number; max?: number }
  | { kind: "date";     value: string | null }
  | { kind: "select";   value: string | null; options: { value: string; label: string }[]; placeholder?: string }
  | { kind: "rating";   value: LeadRating };

/**
 * Serializable idle-mode rendering options. Plain strings/numbers/JSON pass
 * through fine across the server→client boundary; React-element renderers do
 * not, which is why this is an enum rather than a render-prop.
 */
export type IdleStyle =
  | { kind: "default" }                                      // money/date/select all default-format themselves
  | { kind: "mailto" }                                       // text → "mailto:" link in brand-violet
  | { kind: "phone" }                                        // text → "tel:" link in brand-violet
  | { kind: "url"; emptyLabel?: string; linkLabel?: string } // text → external link with custom label
  | { kind: "select-label"; options: { value: string; label: string }[] }; // resolves the value back to its label
                                                              // (used when the underlying value is an id but you
                                                              // want to show the human label in idle)

interface InlineFieldProps {
  kind: InlineFieldKind;
  onSave: (next: string | number | null) => Promise<void>;
  ariaLabel: string;
  /** Style of the idle-mode rendering. Plain enum so this is server-component safe. */
  idleStyle?: IdleStyle;
  /** Tailwind classes applied to the idle render wrapper. */
  className?: string;
  /** Tailwind classes applied to the value text inside idle render. */
  valueClass?: string;
  /** When true, shows a "(required)" hint and refuses to save empty. */
  required?: boolean;
  /** When true, the field renders as plain text — no hover state, no edit affordance. */
  readOnly?: boolean;
}

type Phase = "idle" | "editing" | "saving" | "saved" | "error";

export function InlineField(props: InlineFieldProps) {
  const { kind, onSave, ariaLabel, idleStyle, className, valueClass, required, readOnly } = props;
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  // Local current value — what to render in idle. Updated optimistically post-save.
  const [current, setCurrent] = useState<string | number | null>(extractValue(kind));

  // Re-sync if parent passes a new value (e.g. router.refresh after a sibling save).
  useEffect(() => {
    setCurrent(extractValue(kind));
  }, [kindKey(kind)]);

  async function commit(next: string | number | null) {
    if (sameValue(current, next)) {
      setPhase("idle");
      return;
    }
    if (required && (next === null || next === "")) {
      setError("Required");
      setPhase("error");
      return;
    }
    setPhase("saving");
    setError(null);
    try {
      await onSave(next);
      setCurrent(next);
      setPhase("saved");
      setTimeout(() => setPhase("idle"), 1400);
    } catch (err) {
      setError((err as Error).message);
      setPhase("error");
    }
  }

  // ── IDLE ─────────────────────────────────────────────────────────────────
  if (phase === "idle" || phase === "saved") {
    const idleNode = renderIdle(kind, current, idleStyle);
    if (readOnly) {
      return (
        <span aria-label={ariaLabel} className={cn("inline-flex items-center", className)}>
          <span className={cn("min-w-[1ch]", valueClass)}>{idleNode}</span>
        </span>
      );
    }
    return (
      <button
        type="button"
        aria-label={`Edit ${ariaLabel}`}
        onClick={() => setPhase("editing")}
        className={cn(
          "group relative inline-flex items-center gap-1.5 rounded-md text-left transition",
          "hover:bg-warm/60 hover:ring-1 hover:ring-rule cursor-text",
          phase === "saved" && "ring-1 ring-state-ok/40 bg-state-ok/5",
          className,
        )}
      >
        <span className={cn("min-w-[1ch]", valueClass)}>
          {idleNode}
        </span>
        <Icon
          name="settings"
          size={11}
          strokeWidth={2}
          className={cn(
            "ml-1 flex-shrink-0 text-mute opacity-0 transition group-hover:opacity-60",
            phase === "saved" && "hidden",
          )}
        />
        {phase === "saved" && (
          <Icon name="check" size={11} strokeWidth={2.5} className="ml-1 flex-shrink-0 text-state-ok" />
        )}
      </button>
    );
  }

  // ── ERROR ────────────────────────────────────────────────────────────────
  if (phase === "error") {
    return (
      <div className={cn("inline-flex items-center gap-1.5", className)}>
        <span className={cn("text-state-warn", valueClass)}>
          {renderIdle(kind, current, idleStyle)}
        </span>
        <button
          type="button"
          onClick={() => { setPhase("editing"); setError(null); }}
          className="rounded-md border border-state-warn/30 bg-state-warn/10 px-1.5 py-0.5 text-[10px] font-semibold text-state-warn"
          title={error ?? "Save failed"}
        >
          retry
        </button>
      </div>
    );
  }

  // ── EDITING / SAVING ────────────────────────────────────────────────────
  return (
    <Editor
      kind={kind}
      saving={phase === "saving"}
      onCancel={() => { setPhase("idle"); setError(null); }}
      onCommit={commit}
      ariaLabel={ariaLabel}
      className={className}
      valueClass={valueClass}
    />
  );
}

// ── Editor ─────────────────────────────────────────────────────────────────

function Editor({
  kind,
  saving,
  onCommit,
  onCancel,
  ariaLabel,
  className,
  valueClass,
}: {
  kind: InlineFieldKind;
  saving: boolean;
  onCommit: (v: string | number | null) => void;
  onCancel: () => void;
  ariaLabel: string;
  className?: string;
  valueClass?: string;
}) {
  // All hooks at the top — order must be stable across renders.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputCls = cn(
    "rounded-md border border-rule bg-paper px-2 py-1 text-[13.5px] text-ink",
    "focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20",
    saving && "opacity-60",
    valueClass,
  );

  // SELECT
  if (kind.kind === "select") {
    return (
      <span className={cn("inline-flex items-center gap-1.5", className)}>
        <select
          autoFocus
          aria-label={ariaLabel}
          disabled={saving}
          defaultValue={kind.value ?? ""}
          onChange={(e) => onCommit(e.target.value || null)}
          onBlur={() => !saving && onCancel()}
          className={inputCls}
        >
          {kind.placeholder && <option value="">{kind.placeholder}</option>}
          {kind.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {saving && <Spinner />}
      </span>
    );
  }

  // RATING — chip popover.
  if (kind.kind === "rating") {
    return (
      <RatingPopover
        value={kind.value}
        saving={saving}
        onCommit={onCommit}
        onCancel={onCancel}
        className={className}
      />
    );
  }

  // TEXTAREA
  if (kind.kind === "textarea") {
    return (
      <span className={cn("flex flex-col gap-1.5", className)}>
        <textarea
          ref={textareaRef}
          autoFocus
          aria-label={ariaLabel}
          disabled={saving}
          defaultValue={kind.value ?? ""}
          placeholder={kind.placeholder}
          rows={kind.minRows ?? 4}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); onCancel(); }
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              onCommit(textareaRef.current?.value.trim() || null);
            }
          }}
          onBlur={(e) => !saving && onCommit(e.currentTarget.value.trim() || null)}
          className={cn(inputCls, "min-h-[90px] w-full resize-y leading-[1.5]")}
        />
        <span className="font-mono text-[10px] tracking-[.04em] text-mute">
          Enter for newline · Ctrl+Enter to save · Esc to cancel
        </span>
      </span>
    );
  }

  // NUMBER (range overrides not handled here — a regular number input)
  if (kind.kind === "number") {
    return (
      <span className={cn("inline-flex items-center gap-1.5", className)}>
        <input
          type="number"
          autoFocus
          aria-label={ariaLabel}
          disabled={saving}
          defaultValue={kind.value ?? ""}
          min={kind.min}
          max={kind.max}
          onKeyDown={(e) => commonKeys(e, onCancel, (v) => onCommit(v === "" ? null : Number(v)))}
          onBlur={(e) => !saving && onCommit(e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}
          className={cn(inputCls, "w-[110px] text-right font-mono")}
        />
        {saving && <Spinner />}
      </span>
    );
  }

  // DATE
  if (kind.kind === "date") {
    return (
      <span className={cn("inline-flex items-center gap-1.5", className)}>
        <input
          type="date"
          autoFocus
          aria-label={ariaLabel}
          disabled={saving}
          defaultValue={(kind.value ?? "").slice(0, 10)}
          onChange={(e) => onCommit(e.currentTarget.value || null)}
          onBlur={(e) => !saving && onCommit(e.currentTarget.value || null)}
          onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
          className={cn(inputCls, "w-[160px] font-mono")}
        />
        {saving && <Spinner />}
      </span>
    );
  }

  // MONEY — digits-only input; we keep storage as the bare numeric string
  // ("149000") so the same column round-trips with the renderer's ₹ format.
  if (kind.kind === "money") {
    return (
      <span className={cn("inline-flex items-center gap-1.5", className)}>
        <span className="font-mono text-[13px] text-mute">₹</span>
        <input
          type="text"
          inputMode="decimal"
          autoFocus
          aria-label={ariaLabel}
          disabled={saving}
          defaultValue={kind.value ?? ""}
          placeholder="0"
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
            // Only digits + a single decimal point; allow editing/navigation keys.
            const ctrl = e.metaKey || e.ctrlKey;
            const allowed = ["Backspace","Tab","ArrowLeft","ArrowRight","Home","End","Delete"];
            if (e.key === "Enter") {
              e.preventDefault();
              const v = e.currentTarget.value.trim();
              onCommit(v === "" ? null : v);
              return;
            }
            if (ctrl || allowed.includes(e.key)) return;
            if (e.key === "." && !e.currentTarget.value.includes(".")) return;
            if (!/^\d$/.test(e.key)) e.preventDefault();
          }}
          onChange={(e) => {
            // Last-line defence against pasted non-numeric input.
            const cleaned = e.currentTarget.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
            if (cleaned !== e.currentTarget.value) e.currentTarget.value = cleaned;
          }}
          onBlur={(e) => !saving && onCommit(e.currentTarget.value.trim() || null)}
          className={cn(inputCls, "w-[160px] text-right font-mono")}
        />
        {saving && <Spinner />}
      </span>
    );
  }

  // text / email / phone / url — all single-line text inputs
  const inputType =
    kind.kind === "email" ? "email" :
    kind.kind === "phone" ? "tel" :
    kind.kind === "url"   ? "url" :
    "text";

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <input
        type={inputType}
        autoFocus
        aria-label={ariaLabel}
        disabled={saving}
        defaultValue={kind.value ?? ""}
        placeholder={(kind as { placeholder?: string }).placeholder}
        onKeyDown={(e) => commonKeys(e, onCancel, (v) => onCommit(v.trim() || null))}
        onBlur={(e) => !saving && onCommit(e.currentTarget.value.trim() || null)}
        className={cn(inputCls, "min-w-[180px]")}
      />
      {saving && <Spinner />}
    </span>
  );
}

function commonKeys(
  e: React.KeyboardEvent<HTMLInputElement>,
  cancel: () => void,
  commitText: (v: string) => void,
) {
  if (e.key === "Escape") { e.preventDefault(); cancel(); }
  if (e.key === "Enter")  { e.preventDefault(); commitText(e.currentTarget.value); }
}

function RatingPopover({
  value, saving, onCommit, onCancel, className,
}: {
  value: LeadRating;
  saving: boolean;
  onCommit: (v: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  // Close on outside click / Esc.
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onCancel();
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onCancel(); }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onCancel]);

  return (
    <span ref={popRef} className={cn("relative inline-flex", className)}>
      {/* Anchor — currently selected chip, kept visible while popover is open. */}
      <RatingChip rating={value} />
      <div className="absolute left-0 top-[110%] z-50 flex flex-wrap gap-1.5 rounded-xl border border-rule bg-paper p-2 shadow-card"
           style={{ minWidth: 320 }}>
        {LEAD_RATINGS.map((r) => {
          const s = ratingStyles[r];
          const on = r === value;
          return (
            <button
              key={r}
              type="button"
              disabled={saving}
              onClick={() => onCommit(r)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition",
                on
                  ? cn(s.bg, s.text, "ring-2 ring-offset-1 ring-offset-paper", s.text.replace("text-", "ring-"))
                  : "border border-rule bg-paper text-mute hover:border-rule2 hover:text-ink",
                saving && "opacity-50",
              )}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", on ? s.dot : "bg-rule2")} />
              {s.label}
            </button>
          );
        })}
      </div>
    </span>
  );
}

function RatingChip({ rating }: { rating: LeadRating }) {
  const s = ratingStyles[rating];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold", s.bg, s.text)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

// Render the idle representation of a value. The optional IdleStyle bends
// the default rendering — e.g. text → mailto link instead of plain text.
function renderIdle(
  kind: InlineFieldKind,
  value: string | number | null,
  style: IdleStyle | undefined,
): React.ReactNode {
  // Style overrides come first.
  if (style?.kind === "mailto") {
    if (!value) return <span className="text-mute">—</span>;
    return <a href={`mailto:${value}`} className="text-brand-violet hover:underline">{String(value)}</a>;
  }
  if (style?.kind === "phone") {
    if (!value) return <span className="text-mute">—</span>;
    return <a href={`tel:${String(value).replace(/\s+/g, "")}`} className="text-brand-violet hover:underline">{String(value)}</a>;
  }
  if (style?.kind === "url") {
    if (!value) return <span className="text-mute">{style.emptyLabel ?? "—"}</span>;
    return (
      <a href={String(value)} target="_blank" rel="noreferrer" className="text-brand-violet hover:underline">
        {style.linkLabel ?? "View →"}
      </a>
    );
  }
  if (style?.kind === "select-label") {
    const opt = style.options.find((o) => o.value === value);
    return <span>{opt?.label ?? <span className="text-mute">—</span>}</span>;
  }

  // Default rendering: each kind formats itself.
  if (kind.kind === "rating") {
    return <RatingChip rating={(value as LeadRating | null) ?? "new lead"} />;
  }
  if (kind.kind === "select") {
    const opt = kind.options.find((o) => o.value === value);
    return <span>{opt?.label ?? <span className="text-mute">—</span>}</span>;
  }
  if (kind.kind === "money") {
    const n = value == null || value === "" ? null : Number(value);
    return <span>{n != null && Number.isFinite(n) ? `₹${n.toLocaleString("en-IN")}` : <span className="text-mute">—</span>}</span>;
  }
  if (kind.kind === "date") {
    const d = value ? new Date(String(value)) : null;
    return <span>{d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : <span className="text-mute">—</span>}</span>;
  }
  if (value == null || value === "") return <span className="text-mute">—</span>;
  return <span>{String(value)}</span>;
}

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin text-mute" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" strokeOpacity=".3" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractValue(k: InlineFieldKind): string | number | null {
  return k.value as string | number | null;
}

// Stable key for the value, used to re-sync local state when parent updates.
function kindKey(k: InlineFieldKind): string {
  return `${k.kind}:${String(k.value)}`;
}

function sameValue(a: string | number | null, b: string | number | null): boolean {
  if (a === b) return true;
  if (a == null && (b == null || b === "")) return true;
  if (b == null && (a == null || a === "")) return true;
  return false;
}
