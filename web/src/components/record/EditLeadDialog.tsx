"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { getCatalog, updateLead } from "@/lib/api";
import type { CatalogResponse, Heat, LeadRating } from "@/lib/types";
import { LEAD_RATINGS } from "@/lib/types";
import { ratingStyles } from "@/lib/ui";

export function EditLeadButton({ leadNumber, lead }: { leadNumber: string; lead: LeadEditable }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-[9px] text-brand-violet hover:underline"
      >
        Edit
      </button>
      {open && <Dialog leadNumber={leadNumber} lead={lead} onClose={() => setOpen(false)} />}
    </>
  );
}

export interface LeadEditable {
  name: string;
  email: string | null;
  phone: string | null;
  phoneCountryCode: string | null;
  timeZone: string | null;
  deliveryMode: "online" | "offline" | "hybrid" | null;
  city: string | null;
  programId: string | null;
  programName: string | null;
  source: string | null;
  sourceLabel: string | null;
  advisorId: string | null;
  advisorName: string | null;
  value: string | null;
  description: string | null;
  feePaid: string | null;
  feeDue: string | null;
  dueDate: string | null;
  registeredDate: string | null;
  nextFollowupAt: string | null;
  demoAttendedAt: string | null;
  visitedDate:    string | null;
  visitingDate:   string | null;
  paymentProofUrl: string | null;
  score: number;
  heat: Heat;
  rating: LeadRating;
  nbaLabel: string;
}

function Dialog({ leadNumber, lead, onClose }: { leadNumber: string; lead: LeadEditable; onClose: () => void }) {
  const router = useRouter();
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state — initialize from current lead
  const [name, setName]               = useState(lead.name);
  const [email, setEmail]             = useState(lead.email ?? "");
  const [phone, setPhone]             = useState(lead.phone ?? "");
  const [phoneCountryCode, setPhoneCountryCode] = useState(lead.phoneCountryCode ?? "+91");
  const [timeZone, setTimeZone]       = useState(lead.timeZone ?? "Asia/Kolkata");
  const [deliveryMode, setDeliveryMode] = useState<string>(lead.deliveryMode ?? "");
  const [city, setCity]               = useState(lead.city ?? "");
  const [programId, setProgramId]     = useState(lead.programId ?? "");
  const [advisorId, setAdvisorId]     = useState(lead.advisorId ?? "");
  const [source, setSource]           = useState(lead.source ?? "web");
  const [value, setValue]             = useState(lead.value ?? "");
  const [description, setDescription] = useState(lead.description ?? "");
  const [feePaid, setFeePaid]         = useState(lead.feePaid ?? "");
  const [feeDue, setFeeDue]           = useState(lead.feeDue ?? "");
  const [dueDate, setDueDate]         = useState(lead.dueDate?.slice(0, 10) ?? "");
  const [registeredDate, setRegisteredDate] = useState(lead.registeredDate?.slice(0, 10) ?? "");
  const [nextFollowupAt, setNextFollowupAt] = useState(lead.nextFollowupAt?.slice(0, 10) ?? "");
  const [demoAttendedAt, setDemoAttendedAt] = useState(lead.demoAttendedAt?.slice(0, 10) ?? "");
  const [paymentProofUrl, setPaymentProofUrl] = useState(lead.paymentProofUrl ?? "");
  const [score, setScore]             = useState<number>(lead.score);
  const [rating, setRating]           = useState<LeadRating>(lead.rating);
  const [nbaLabel, setNbaLabel]       = useState(lead.nbaLabel);

  useEffect(() => {
    getCatalog().then(setCatalog).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onScoreChange(s: number) {
    setScore(s);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("Name is required"); return; }
    setBusy(true); setError(null);
    try {
      const sourceObj = catalog?.sources.find((s) => s.key === source);
      await updateLead(leadNumber, {
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.replace(/[^\d]/g, "") || null,
        phoneCountryCode: phoneCountryCode.trim() || null,
        timeZone: timeZone || null,
        deliveryMode: (deliveryMode || null) as "online" | "offline" | "hybrid" | null,
        city: city.trim() || null,
        programId: programId || null,
        advisorId: advisorId || null,
        source,
        sourceLabel: sourceObj?.label,
        value: value.trim() || null,
        description: description.trim() || null,
        feePaid: feePaid.trim() || null,
        feeDue: feeDue.trim() || null,
        dueDate: dueDate || null,
        registeredDate: registeredDate || null,
        nextFollowupAt: nextFollowupAt || null,
        demoAttendedAt: demoAttendedAt || null,
        paymentProofUrl: paymentProofUrl.trim() || null,
        score,
        rating,
        nbaLabel: nbaLabel.trim() || undefined,
      });
      router.refresh();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Panel is height-bounded; header + footer stay pinned, the form body
          becomes the only scrollable region. */}
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[calc(100vh-3rem)] w-full max-w-[680px] flex-col rounded-2xl border border-rule bg-paper shadow-card"
      >
        <div className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-rule p-7 pb-5">
          <div>
            <h2 className="font-serif text-[26px] font-normal leading-tight tracking-[-.01em]">Edit lead</h2>
            <p className="mt-1 text-[13px] text-mute">{leadNumber} · changes are recorded in the timeline.</p>
          </div>
          <button type="button" onClick={onClose} className="text-mute hover:text-ink"><Icon name="plus" size={18} strokeWidth={2} className="rotate-45" /></button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-7">
          <Section title="Contact">
            <Field label="Full name" required>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Email">
                <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="aarav@gmail.com" />
              </Field>
              <Field label="Phone">
                <div className="flex gap-2">
                  <select
                    className={cn(inputCls, "w-[120px] flex-shrink-0 font-mono")}
                    value={phoneCountryCode}
                    onChange={(e) => setPhoneCountryCode(e.target.value)}
                    aria-label="Country code"
                  >
                    <option value="+91">+91 IN</option>
                    <option value="+1">+1 US/CA</option>
                    <option value="+44">+44 UK</option>
                    <option value="+971">+971 AE</option>
                    <option value="+65">+65 SG</option>
                    <option value="+61">+61 AU</option>
                    <option value="+49">+49 DE</option>
                    <option value="+966">+966 SA</option>
                  </select>
                  <input
                    className={cn(inputCls, "flex-1 font-mono")}
                    inputMode="numeric"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, "").slice(0, 15))}
                    placeholder="98••• •••••"
                    aria-label="Phone number"
                  />
                </div>
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <Field label="City">
                <input className={inputCls} value={city} onChange={(e) => setCity(e.target.value)} placeholder="Bengaluru" />
              </Field>
              <Field label="Time zone">
                <select className={inputCls} value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
                  <option value="Asia/Kolkata">IST · India</option>
                  <option value="America/New_York">ET · US Eastern</option>
                  <option value="America/Chicago">CT · US Central</option>
                  <option value="America/Denver">MT · US Mountain</option>
                  <option value="America/Los_Angeles">PT · US Pacific</option>
                  <option value="Europe/London">UK · London</option>
                </select>
              </Field>
              <Field label="Mode">
                <select className={inputCls} value={deliveryMode} onChange={(e) => setDeliveryMode(e.target.value)}>
                  <option value="">— pick mode —</option>
                  <option value="online">Online</option>
                  <option value="offline">Offline</option>
                  <option value="hybrid">Hybrid</option>
                </select>
              </Field>
            </div>
          </Section>

          <Section title="Sales">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Program">
                <select className={inputCls} value={programId} onChange={(e) => setProgramId(e.target.value)} disabled={!catalog}>
                  <option value="">— none —</option>
                  {catalog?.programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="Source">
                <select className={inputCls} value={source} onChange={(e) => setSource(e.target.value)}>
                  {catalog?.sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Advisor">
                <select className={inputCls} value={advisorId} onChange={(e) => setAdvisorId(e.target.value)}>
                  <option value="">— auto-assign —</option>
                  {catalog?.advisors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <Field label="Price quoted (₹)">
                <input
                  className={cn(inputCls, "font-mono")}
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => {
                    const cleaned = e.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
                    setValue(cleaned);
                  }}
                  placeholder="149000"
                />
              </Field>
            </div>
            <Field label="Description / context">
              <textarea
                className={cn(inputCls, "min-h-[90px] resize-y")}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Where does this lead stand? What did they say in the last call?"
              />
            </Field>
          </Section>

          <Section title="Cadence">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Next follow-up date">
                <input className={inputCls} type="date" value={nextFollowupAt} onChange={(e) => setNextFollowupAt(e.target.value)} />
              </Field>
              <Field label="Demo attended date">
                <input className={inputCls} type="date" value={demoAttendedAt} onChange={(e) => setDemoAttendedAt(e.target.value)} />
              </Field>
            </div>
          </Section>

          <Section title="Payment trail">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Fee paid (₹)">
                <input className={inputCls} type="number" value={feePaid} onChange={(e) => setFeePaid(e.target.value)} placeholder="e.g. 25000" />
              </Field>
              <Field label="Fee due (₹)">
                <input className={inputCls} type="number" value={feeDue} onChange={(e) => setFeeDue(e.target.value)} placeholder="e.g. 124000" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Registered date">
                <input className={inputCls} type="date" value={registeredDate} onChange={(e) => setRegisteredDate(e.target.value)} />
              </Field>
              <Field label="Due date">
                <input className={inputCls} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </Field>
            </div>
            <Field label="Payment proof (URL)">
              <input className={inputCls} value={paymentProofUrl} onChange={(e) => setPaymentProofUrl(e.target.value)} placeholder="https://drive.google.com/…" />
              <span className="mt-1 block text-[10.5px] text-mute">
                Paste a link to the screenshot for now. Upload-to-blob is in a later phase.
              </span>
            </Field>
          </Section>

          <Section title="Scoring & rating">

            <Field label={`Score · ${score}`}>
              <input
                type="range" min={0} max={100} value={score}
                onChange={(e) => onScoreChange(Number(e.target.value))}
                className="w-full accent-brand-violet"
              />
              <span className="mt-1 block text-[11px] text-mute">
                Set by the Lead Scoring Agent. Drag to override manually.
              </span>
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
              <span className="mt-1 block text-[11px] text-mute">
                Human-set. The Scoring Agent reads this as a strong prior but never changes it.
              </span>
            </Field>

            <Field label="Next-best-action label">
              <input className={inputCls} value={nbaLabel} onChange={(e) => setNbaLabel(e.target.value)} placeholder="Send re-engagement email" />
            </Field>
          </Section>

        </div>

        <div className="flex flex-shrink-0 flex-col gap-3 border-t border-rule p-5">
          {error && (
            <div className="rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">{error}</div>
          )}
          <div className="flex items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="btn">Cancel</button>
            <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

const inputCls = "w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="mono-cap text-[10px] font-semibold tracking-[.14em] text-brand-violet">{title}</div>
      {children}
    </div>
  );
}

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
