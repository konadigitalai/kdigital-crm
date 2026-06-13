"use client";

// Inline editor for the lead's phone country code, on its own row in
// LEAD DETAILS. Distinct from PhoneField which edits CC + number together —
// here we only touch CC, so the row reads cleanly as a single value.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { updateLead } from "@/lib/api";

const COMMON_CODES: { code: string; label: string }[] = [
  { code: "+91",  label: "+91 India" },
  { code: "+1",   label: "+1 US / CA" },
  { code: "+44",  label: "+44 UK" },
  { code: "+971", label: "+971 UAE" },
  { code: "+65",  label: "+65 SG" },
  { code: "+61",  label: "+61 AU" },
  { code: "+49",  label: "+49 DE" },
  { code: "+966", label: "+966 SA" },
];

interface Props {
  leadNumber: string;
  value: string | null;
  className?: string;
  valueClass?: string;
}

export function PhoneCodeField({ leadNumber, value, className, valueClass }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<string>(value ?? "");
  const [otherOpen, setOtherOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => { setDraft(value ?? ""); }, [value]);

  // Click-outside while editing → commit (mirrors blur-to-save on the rest of
  // the inline fields).
  useEffect(() => {
    if (!editing) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (wrapRef.current.contains(e.target as Node)) return;
      void commit();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, draft]);

  async function commit() {
    if (!editing) return;
    const next = clean(draft);
    if (next === (value ?? null)) {
      setEditing(false);
      setOtherOpen(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateLead(leadNumber, { phoneCountryCode: next });
      setEditing(false);
      setOtherOpen(false);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <span ref={wrapRef} className={cn("inline-flex items-center gap-1.5", className)}>
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="Edit phone country code"
          className={cn(
            "rounded px-1 py-0.5 text-left hover:bg-warm",
            value ? "text-ink" : "text-mute",
            valueClass,
          )}
        >
          {value ? formatPretty(value) : "—"}
        </button>
      </span>
    );
  }

  const isCustom = draft !== "" && !COMMON_CODES.some((c) => c.code === draft);

  return (
    <span ref={wrapRef} className={cn("inline-flex items-center gap-1.5", className)}>
      {otherOpen || isCustom ? (
        <input
          type="text"
          inputMode="tel"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^+\d]/g, "").slice(0, 5))}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setEditing(false); setOtherOpen(false); }
            if (e.key === "Enter")  void commit();
          }}
          placeholder="+CC"
          aria-label="Country code"
          disabled={saving}
          className={cn(inputCls, "w-[80px] font-mono")}
        />
      ) : (
        <select
          value={draft}
          autoFocus
          onChange={(e) => {
            if (e.target.value === "__other__") { setDraft(""); setOtherOpen(true); return; }
            setDraft(e.target.value);
          }}
          aria-label="Country code"
          disabled={saving}
          className={cn(inputCls, "w-[140px] font-mono")}
        >
          <option value="">— none —</option>
          {COMMON_CODES.map((o) => (
            <option key={o.code} value={o.code}>{o.label}</option>
          ))}
          <option value="__other__">Other…</option>
        </select>
      )}
      {saving && <Spinner />}
      {error && <span className="text-[11px] text-state-warn" title={error}>!</span>}
    </span>
  );
}

function clean(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const m = t.match(/^\+?(\d{1,4})$/);
  return m ? `+${m[1]}` : null;
}

function formatPretty(cc: string): string {
  const found = COMMON_CODES.find((o) => o.code === cc);
  return found ? found.label : cc;
}

const inputCls = "rounded-md border border-rule bg-paper px-2 py-1 text-[13px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20";

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin text-mute" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" strokeOpacity=".3" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}
