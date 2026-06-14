"use client";

// Inline editor for the phone fields. Country code is a small dropdown of
// the most-likely picks (with Other... → free text); the local number is a
// digits-only input. PATCH writes both fields in one call.
//
// State machine matches InlineField (idle → editing → saving → saved → idle)
// but the dual-input shape is too custom to wedge into the InlineField primitive,
// so we implement it stand-alone here.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { updateLead } from "@/lib/api";

interface CountryOpt { code: string; label: string }

const COMMON_CODES: CountryOpt[] = [
  { code: "+91", label: "+91 India" },
  { code: "+1",  label: "+1 US / CA" },
  { code: "+44", label: "+44 UK" },
  { code: "+971", label: "+971 UAE" },
  { code: "+65", label: "+65 SG" },
  { code: "+61", label: "+61 AU" },
  { code: "+49", label: "+49 DE" },
  { code: "+966", label: "+966 SA" },
];

interface Props {
  leadNumber: string;
  countryCode: string | null;
  number: string | null;
  ariaLabel?: string;
  className?: string;
  valueClass?: string;
}

export function PhoneField({
  leadNumber,
  countryCode: ccProp,
  number: numProp,
  ariaLabel = "Phone",
  className,
  valueClass,
}: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cc, setCc]   = useState<string>(ccProp ?? "+91");
  const [num, setNum] = useState<string>(numProp ?? "");
  const [otherOpen, setOtherOpen] = useState(false);

  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setCc(ccProp ?? "+91");
    setNum(numProp ?? "");
  }, [ccProp, numProp]);

  // Click-outside while editing → commit (mirrors blur behaviour of other
  // inline fields).
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
  }, [editing, cc, num]);

  async function commit() {
    if (!editing) return;
    const cleanNum = num.replace(/[^\d]/g, "") || null;
    const cleanCc = cleanCountry(cc);
    const ccChanged = cleanCc !== (ccProp ?? null);
    const numChanged = cleanNum !== (numProp ?? null);
    if (!ccChanged && !numChanged) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateLead(leadNumber, {
        phoneCountryCode: cleanCc,
        phone: cleanNum,
      });
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    const display = formatDisplay(ccProp, numProp);
    return (
      <span ref={wrapRef} className={cn("inline-flex items-center gap-1.5", className)}>
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label={`Edit ${ariaLabel}`}
          className={cn(
            "rounded px-1 py-0.5 text-left text-ink hover:bg-warm",
            !numProp && "text-mute",
            valueClass,
          )}
        >
          {display ?? "—"}
        </button>
      </span>
    );
  }

  const isCustomCc = cc !== "" && !COMMON_CODES.some((c) => c.code === cc);

  return (
    <span ref={wrapRef} className={cn("inline-flex items-center gap-1.5", className)}>
      {otherOpen || isCustomCc ? (
        <input
          type="text"
          inputMode="tel"
          autoFocus
          value={cc}
          onChange={(e) => setCc(e.target.value.replace(/[^+\d]/g, "").slice(0, 5))}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setEditing(false); setOtherOpen(false); }
            if (e.key === "Enter") void commit();
          }}
          placeholder="+CC"
          aria-label="Country code"
          disabled={saving}
          className={cn(inputCls, "w-[70px] font-mono")}
        />
      ) : (
        <select
          value={cc}
          onChange={(e) => {
            if (e.target.value === "__other__") { setCc(""); setOtherOpen(true); return; }
            setCc(e.target.value);
          }}
          aria-label="Country code"
          disabled={saving}
          className={cn(inputCls, "w-[120px] font-mono")}
        >
          {COMMON_CODES.map((o) => (
            <option key={o.code} value={o.code}>{o.label}</option>
          ))}
          <option value="__other__">Other…</option>
        </select>
      )}
      <input
        type="tel"
        inputMode="numeric"
        value={num}
        autoFocus={!otherOpen && !isCustomCc}
        onChange={(e) => setNum(e.target.value.replace(/[^\d]/g, "").slice(0, 15))}
        onKeyDown={(e) => {
          if (e.key === "Escape") setEditing(false);
          if (e.key === "Enter") void commit();
        }}
        placeholder="98••• •••••"
        aria-label="Phone number"
        disabled={saving}
        className={cn(inputCls, "w-[160px] font-mono")}
      />
      {saving && <Spinner />}
      {error && <span className="text-[11px] text-state-warn" title={error}>!</span>}
    </span>
  );
}

function cleanCountry(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const m = t.match(/^\+?(\d{1,4})$/);
  return m ? `+${m[1]}` : null;
}

// Phone display intentionally omits the country code — the CC has its own
// dedicated row ("Phone CC") on the lead record, so showing it here too is
// noisy and easy to misread (people confuse "+1 5859..." for a single ID).
// `cc` stays in the signature for API compatibility but is unused.
function formatDisplay(_cc: string | null, num: string | null): string | null {
  if (!num) return null;
  // Indian-style 5-5 grouping if length permits, else simple 3-grouping.
  return num.length === 10
    ? `${num.slice(0, 5)} ${num.slice(5)}`
    : num.replace(/(\d{3,4})(?=\d)/g, "$1 ").trim();
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
