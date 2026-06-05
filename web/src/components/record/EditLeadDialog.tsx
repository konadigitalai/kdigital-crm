"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { getCatalog, updateLead } from "@/lib/api";
import type { CatalogResponse, Heat, Stage } from "@/lib/types";

const STAGES: { key: Stage; label: string }[] = [
  { key: "new", label: "New inbound" },
  { key: "qual", label: "Qualified" },
  { key: "demo", label: "Demo / Trial" },
  { key: "neg", label: "Negotiation" },
  { key: "won", label: "Enrolled" },
];
const HEATS: Heat[] = ["hot", "warm", "cold"];

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
  paymentProofUrl: string | null;
  score: number;
  heat: Heat;
  stage: Stage;
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
  const [paymentProofUrl, setPaymentProofUrl] = useState(lead.paymentProofUrl ?? "");
  const [stage, setStage]             = useState<Stage>(lead.stage);
  const [score, setScore]             = useState<number>(lead.score);
  const [heat, setHeat]               = useState<Heat>(lead.heat);
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
    setHeat(s >= 75 ? "hot" : s >= 45 ? "warm" : "cold");
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
        phone: phone.trim() || null,
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
        paymentProofUrl: paymentProofUrl.trim() || null,
        stage,
        score,
        heat,
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
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="my-12 w-full max-w-[680px] rounded-2xl border border-rule bg-paper p-7 shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[26px] font-normal leading-tight tracking-[-.01em]">Edit lead</h2>
            <p className="mt-1 text-[13px] text-mute">{leadNumber} · changes are recorded in the timeline.</p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink"><Icon name="plus" size={18} strokeWidth={2} className="rotate-45" /></button>
        </div>

        <form onSubmit={submit} className="space-y-5">
          <Section title="Contact">
            <Field label="Full name" required>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Email">
                <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="aarav@gmail.com" />
              </Field>
              <Field label="Phone">
                <input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98••• ••••" />
              </Field>
            </div>
            <Field label="City">
              <input className={inputCls} value={city} onChange={(e) => setCity(e.target.value)} placeholder="Bengaluru" />
            </Field>
          </Section>

          <Section title="Sales">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Program">
                <select className={inputCls} value={programId} onChange={(e) => setProgramId(e.target.value)} disabled={!catalog}>
                  <option value="">— pick a program —</option>
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
              <Field label="Value (free-form)">
                <input className={inputCls} value={value} onChange={(e) => setValue(e.target.value)} placeholder="₹1.49L · verbal yes · …" />
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

          <Section title="Scoring & stage">
            <Field label="Stage">
              <div className="flex flex-wrap gap-2">
                {STAGES.map((s) => (
                  <button
                    type="button" key={s.key}
                    onClick={() => setStage(s.key)}
                    className={cn(
                      "rounded-full px-3 py-1.5 text-[12px] font-semibold transition",
                      stage === s.key ? "border border-transparent bg-ink text-white" : "border border-rule bg-paper text-ink2 hover:border-rule2",
                    )}
                  >{s.label}</button>
                ))}
              </div>
              {stage === "won" && (
                <div className="mt-2 rounded-md border border-state-amber/30 bg-state-amber/10 p-2.5 text-[11.5px] text-state-amber">
                  Tip: 'Enrolled' usually means the lead converted. Use the <b>Convert to learner</b> button (top right) instead — that creates a real enrolment.
                </div>
              )}
            </Field>

            <Field label={`Score · ${score} (${heat})`}>
              <div className="flex items-center gap-3">
                <input type="range" min={0} max={100} value={score} onChange={(e) => onScoreChange(Number(e.target.value))} className="flex-1 accent-brand-violet" />
                <div className="flex gap-1">
                  {HEATS.map((h) => (
                    <button
                      type="button" key={h}
                      onClick={() => setHeat(h)}
                      className={cn(
                        "rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition",
                        heat === h
                          ? h === "hot" ? "bg-brand-magenta text-white"
                          : h === "warm" ? "bg-state-amber text-white"
                          : "bg-mute text-white"
                          : "border border-rule text-mute hover:border-rule2",
                      )}
                    >{h}</button>
                  ))}
                </div>
              </div>
            </Field>

            <Field label="Next-best-action label">
              <input className={inputCls} value={nbaLabel} onChange={(e) => setNbaLabel(e.target.value)} placeholder="Send re-engagement email" />
            </Field>
          </Section>

          {error && (
            <div className="rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">{error}</div>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button type="button" onClick={onClose} className="btn">Cancel</button>
            <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
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
