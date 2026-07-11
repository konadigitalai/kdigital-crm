"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { createLead, getCatalog } from "@/lib/api";
import type { CatalogResponse, LeadRating } from "@/lib/types";
import { LEAD_RATINGS } from "@/lib/types";
import { ratingStyles } from "@/lib/ui";
import { emitCrmMutation } from "@/lib/live-summary";

export function NewLeadButton({
  defaultRating,
  variant = "primary",
  label,
  className,
}: {
  defaultRating?: LeadRating;
  variant?: "primary" | "ghost";
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn(
          variant === "primary"
            ? "btn-grad"
            : "rounded-[11px] border border-dashed border-rule2 bg-transparent p-2.5 text-center text-[12px] font-semibold text-mute hover:border-brand-violet hover:text-brand-violet",
          className,
        )}
      >
        {variant === "primary" && <Icon name="plus" size={14} strokeWidth={2.2} />}
        {label ?? (variant === "primary" ? "New lead" : "+ Add lead")}
      </button>
      {open && <NewLeadDialog defaultRating={defaultRating} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Everything the dialog sends when the user hits submit — same shape as
 *  createLead's argument. Exposed so callers that override `submit` can
 *  reuse the exact same field set. */
export type DialogSubmitPayload = Parameters<typeof createLead>[0];

/** Prefill values for the New Lead dialog — e.g. when promoting an inbox
 *  conversation, we already know the phone (and sometimes the party name). */
export interface NewLeadDefaults {
  name?: string;
  phone?: string;              // local digits only, no cc
  phoneCountryCode?: string;   // "+91"
  source?: string;             // catalog key; defaults to "web"
  rating?: LeadRating;
}

/** Standalone dialog. Renders as-is when open; parent controls open state.
 *  When `submit` is provided it REPLACES the default `createLead` call —
 *  useful for the inbox Promote flow which routes through the twilio
 *  conversation endpoint instead of the leads endpoint. */
export function NewLeadDialog({
  defaults,
  defaultRating,
  onClose,
  submit: submitOverride,
  submitLabel,
  title,
  subtitle,
}: {
  defaults?: NewLeadDefaults;
  defaultRating?: LeadRating;
  onClose: () => void;
  submit?: (payload: DialogSubmitPayload) => Promise<{ number: string }>;
  submitLabel?: string;
  title?: string;
  subtitle?: string;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state — seeded from `defaults` when the caller pre-fills.
  const [name, setName] = useState(defaults?.name ?? "");
  const [email, setEmail] = useState("");
  const [phoneCountryCode, setPhoneCountryCode] = useState(defaults?.phoneCountryCode ?? "+91");
  const [phone, setPhone] = useState(defaults?.phone ?? "");
  const [city, setCity] = useState("");
  const [program, setProgram] = useState("");
  const [value, setValue] = useState("");
  const [source, setSource] = useState(defaults?.source ?? "web");
  const [rating, setRating] = useState<LeadRating>(defaults?.rating ?? defaultRating ?? "new lead");
  const [leadStatus, setLeadStatus] = useState<string>("");
  const [description, setDescription] = useState("");
  const [score, setScore] = useState(50);
  const [advisorId, setAdvisorId] = useState<string>("");
  const [nbaLabel, setNbaLabel] = useState("");
  const [nextFollowupAt, setNextFollowupAt] = useState<string>("");   // YYYY-MM-DD
  const [visitingDate,   setVisitingDate]   = useState<string>("");   // YYYY-MM-DD
  const [deliveryMode,   setDeliveryMode]   = useState<"" | "online" | "classroom" | "hybrid">("");

  useEffect(() => {
    // Load the catalog for the program dropdown. Program is optional — leave
    // it unselected by default so the advisor picks explicitly, or leaves it
    // blank if the lead's program isn't decided yet.
    getCatalog()
      .then((c) => setCatalog(c))
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("Name is required"); return; }
    // Phone is required so campaign / template sends work out of the box.
    // Enforce a country code and a local number of ≥6 digits (the shortest
    // real subscriber number worldwide). Anything else is almost certainly
    // a typo or a placeholder.
    const localDigits = phone.replace(/\D/g, "");
    if (localDigits.length < 6) {
      setError("Phone number is required (at least 6 digits).");
      return;
    }
    if (!/^\+\d{1,4}$/.test(phoneCountryCode.trim())) {
      setError("Country code must be like +91.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const sourceObj = catalog?.sources.find((s) => s.key === source);
      const payload: DialogSubmitPayload = {
        name: name.trim(),
        email: email.trim() || undefined,
        phone: localDigits,
        phoneCountryCode: phoneCountryCode.trim(),
        city: city.trim() || undefined,
        program: program || undefined,
        value: value.trim() || undefined,
        source,
        sourceLabel: sourceObj?.label,
        stage: "new",
        score,
        rating,
        leadStatus: leadStatus || undefined,
        description: description.trim() || undefined,
        advisorId: advisorId || undefined,
        nbaLabel: nbaLabel.trim() || undefined,
        nextFollowupAt: nextFollowupAt || undefined,
        visitingDate:   visitingDate   || undefined,
        deliveryMode:   deliveryMode   || undefined,
      };
      const created = submitOverride
        ? await submitOverride(payload)
        : await createLead(payload);
      emitCrmMutation("lead.created");
      router.refresh();
      router.push(`/records/${created.number}`);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Dialog is a column-flex box with a max-height, so header/footer stay
          fixed and only the middle grows a scrollbar. */}
      <div
        ref={dialogRef}
        className="flex w-full max-w-[640px] max-h-[calc(100vh-3rem)] flex-col rounded-2xl border border-rule bg-paper shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Fixed header */}
        <div className="flex-none border-b border-rule px-7 pt-6 pb-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-serif text-[28px] font-normal leading-tight tracking-[-.01em]">{title ?? "New lead"}</h2>
              <p className="mt-1 text-[13px] text-mute">
                {subtitle ?? "Agents will pick this up the moment it lands — score, draft outreach, and book a demo."}
              </p>
            </div>
            <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
              <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
            </button>
          </div>
        </div>

        {/* Scrollable body — form fields live here. onSubmit is on the outer
            <form> below so the footer's submit button still triggers it. */}
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-7 py-6">
            <Field label="Full name" required>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Aarav Mehta" autoFocus />
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Email">
                <input className={inputCls} value={email} type="email" onChange={(e) => setEmail(e.target.value)} placeholder="aarav@gmail.com" />
              </Field>
              <Field label="Phone" required>
                <div className="flex gap-2">
                  <select
                    className={cn(inputCls, "w-[110px] font-mono")}
                    value={phoneCountryCode}
                    onChange={(e) => setPhoneCountryCode(e.target.value)}
                    aria-label="Country code"
                  >
                    {COUNTRY_CODES.map((c) => (
                      <option key={c.code} value={c.code}>{c.iso} {c.code}</option>
                    ))}
                  </select>
                  <input
                    className={cn(inputCls, "flex-1")}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, "").slice(0, 15))}
                    placeholder="98••• •••••"
                    inputMode="numeric"
                    aria-label="Phone number"
                  />
                </div>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field label="City">
                <input className={inputCls} value={city} onChange={(e) => setCity(e.target.value)} placeholder="Bengaluru" />
              </Field>
              <Field label="Source">
                <select className={inputCls} value={source} onChange={(e) => setSource(e.target.value)}>
                  {catalog?.sources.map((s) => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Program">
                <select className={inputCls} value={program} onChange={(e) => setProgram(e.target.value)} disabled={!catalog}>
                  <option value="">— none —</option>
                  {catalog?.programs.map((p) => (
                    <option key={p.id} value={p.name}>{p.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Price quoted (₹)">
                <input
                  className={inputCls}
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => {
                    // Digits-only with one optional decimal — same rule the API enforces.
                    const cleaned = e.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
                    setValue(cleaned);
                  }}
                  placeholder="149000"
                />
              </Field>
            </div>

            <Field label="Advisor">
              <select className={inputCls} value={advisorId} onChange={(e) => setAdvisorId(e.target.value)}>
                <option value="">— auto-assign —</option>
                {catalog?.advisors.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}{a.role !== "advisor" ? ` · ${a.role}` : ""}</option>
                ))}
              </select>
            </Field>

            <Field label="Description">
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Context, prior conversations, anything the advisor should know…"
                className={cn(inputCls, "min-h-[76px] resize-y leading-[1.45]")}
              />
            </Field>

            <Field label="Rating">
              <div className="flex flex-wrap gap-2">
                {LEAD_RATINGS.map((r) => {
                  const s = ratingStyles[r];
                  const on = rating === r;
                  return (
                    <button
                      type="button" key={r}
                      onClick={() => setRating(r)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition",
                        on
                          ? cn(s.bg, s.text, "ring-2 ring-offset-1 ring-offset-paper", s.text.replace("text-", "ring-"))
                          : "border border-rule bg-paper text-mute hover:border-rule2",
                      )}
                    >
                      <span className={cn("h-1.5 w-1.5 rounded-full", on ? s.dot : "bg-rule2")} />
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Lead status">
              <div className="flex flex-wrap gap-2">
                {/* "None" pill lets the advisor create a lead without picking
                    a workflow status — useful when it's the very first touch
                    and there's nothing to classify yet. */}
                <button
                  type="button"
                  onClick={() => setLeadStatus("")}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition",
                    leadStatus === ""
                      ? "bg-brand-violet/10 text-brand-violet ring-2 ring-offset-1 ring-offset-paper ring-brand-violet"
                      : "border border-rule bg-paper text-mute hover:border-rule2",
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", leadStatus === "" ? "bg-brand-violet" : "bg-rule2")} />
                  None
                </button>
                {(catalog?.leadStatuses ?? []).map((o) => {
                  const on = leadStatus === o.key;
                  return (
                    <button
                      type="button" key={o.key}
                      onClick={() => setLeadStatus(o.key)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition",
                        on
                          ? "bg-brand-violet/10 text-brand-violet ring-2 ring-offset-1 ring-offset-paper ring-brand-violet"
                          : "border border-rule bg-paper text-mute hover:border-rule2",
                      )}
                    >
                      <span className={cn("h-1.5 w-1.5 rounded-full", on ? "bg-brand-violet" : "bg-rule2")} />
                      {o.label}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label={`Initial score · ${score}`}>
              <input
                type="range" min={0} max={100} value={score}
                onChange={(e) => setScore(Number(e.target.value))}
                className="w-full accent-brand-violet"
              />
              <span className="mt-1 block text-[11px] text-mute">
                The Lead Scoring Agent will refine this once the lead has activity.
              </span>
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Next follow-up">
                <input
                  type="date"
                  className={inputCls}
                  value={nextFollowupAt}
                  onChange={(e) => setNextFollowupAt(e.target.value)}
                />
              </Field>
              <Field label="Visiting date">
                <input
                  type="date"
                  className={inputCls}
                  value={visitingDate}
                  onChange={(e) => setVisitingDate(e.target.value)}
                />
              </Field>
            </div>

            <Field label="Delivery mode">
              <div className="flex flex-wrap gap-2">
                {(["online","classroom","hybrid"] as const).map((m) => {
                  const on = deliveryMode === m;
                  return (
                    <button
                      type="button" key={m}
                      onClick={() => setDeliveryMode(on ? "" : m)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition capitalize",
                        on
                          ? "bg-brand-violet/10 text-brand-violet ring-2 ring-offset-1 ring-offset-paper ring-brand-violet"
                          : "border border-rule bg-paper text-mute hover:border-rule2",
                      )}
                    >
                      <span className={cn("h-1.5 w-1.5 rounded-full", on ? "bg-brand-violet" : "bg-rule2")} />
                      {m}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Next-best-action label (optional)">
              <input
                className={inputCls}
                value={nbaLabel}
                onChange={(e) => setNbaLabel(e.target.value)}
                placeholder="Leave blank — the NBA agent will fill this in"
              />
            </Field>
          </div>

          {/* Sticky footer — error banner + actions, always visible while scrolling */}
          <div className="flex-none border-t border-rule px-7 py-4">
            {error && (
              <div className="mb-3 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
                {error}
              </div>
            )}
            <div className="flex items-center justify-end gap-3">
              <button type="button" onClick={onClose} className="btn">Cancel</button>
              <button type="submit" disabled={submitting} className="btn-grad disabled:opacity-60">
                {submitting ? "Creating…" : (submitLabel ?? "Create lead")}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputCls = "w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20";

// Country codes mirrored from the public website intake form so operators
// and self-serve leads have the same options. India first because most of
// our leads are Indian; keep the rest in a sensible market order.
const COUNTRY_CODES: { iso: string; code: string }[] = [
  { iso: "IN", code: "+91"  },
  { iso: "US", code: "+1"   },
  { iso: "GB", code: "+44"  },
  { iso: "AU", code: "+61"  },
  { iso: "SG", code: "+65"  },
  { iso: "AE", code: "+971" },
  { iso: "QA", code: "+974" },
  { iso: "SA", code: "+966" },
  { iso: "DE", code: "+49"  },
  { iso: "FR", code: "+33"  },
];

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">
        {label}{required && <span className="ml-1 text-brand-magenta">*</span>}
      </span>
      {children}
    </label>
  );
}
