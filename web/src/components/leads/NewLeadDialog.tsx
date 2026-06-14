"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { createLead, getCatalog } from "@/lib/api";
import type { CatalogResponse, LeadRating } from "@/lib/types";
import { LEAD_RATINGS } from "@/lib/types";
import { ratingStyles } from "@/lib/ui";

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
      {open && <Dialog defaultRating={defaultRating} onClose={() => setOpen(false)} />}
    </>
  );
}

function Dialog({ defaultRating, onClose }: { defaultRating?: LeadRating; onClose: () => void }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState("");
  const [program, setProgram] = useState("");
  const [value, setValue] = useState("");
  const [source, setSource] = useState("web");
  const [rating, setRating] = useState<LeadRating>(defaultRating ?? "new lead");
  const [score, setScore] = useState(50);
  const [advisorId, setAdvisorId] = useState<string>("");
  const [nbaLabel, setNbaLabel] = useState("");

  useEffect(() => {
    getCatalog()
      .then((c) => {
        setCatalog(c);
        if (c.programs[0]) setProgram(c.programs[0].name);
      })
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
    setSubmitting(true);
    setError(null);
    try {
      const sourceObj = catalog?.sources.find((s) => s.key === source);
      const created = await createLead({
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        city: city.trim() || undefined,
        program: program || undefined,
        value: value.trim() || undefined,
        source,
        sourceLabel: sourceObj?.label,
        // legacy stage column still required by the create endpoint until
        // it is migrated; default to 'new' for any new lead.
        stage: "new",
        score,
        rating,
        advisorId: advisorId || undefined,
        nbaLabel: nbaLabel.trim() || undefined,
      });
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
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        className="my-12 w-full max-w-[640px] rounded-2xl border border-rule bg-paper p-7 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[28px] font-normal leading-tight tracking-[-.01em]">New lead</h2>
            <p className="mt-1 text-[13px] text-mute">
              Agents will pick this up the moment it lands — score, draft outreach, and book a demo.
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-5">
          <Field label="Full name" required>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Aarav Mehta" autoFocus />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Email">
              <input className={inputCls} value={email} type="email" onChange={(e) => setEmail(e.target.value)} placeholder="aarav@gmail.com" />
            </Field>
            <Field label="Phone">
              <input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98••• ••••" />
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
                {catalog?.programs.length === 0 ? (
                  <option value="">— no programs yet —</option>
                ) : catalog?.programs.map((p) => (
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

          <Field label="Next-best-action label (optional)">
            <input
              className={inputCls}
              value={nbaLabel}
              onChange={(e) => setNbaLabel(e.target.value)}
              placeholder="Leave blank — the NBA agent will fill this in"
            />
          </Field>

          {error && (
            <div className="rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn">Cancel</button>
            <button type="submit" disabled={submitting} className="btn-grad disabled:opacity-60">
              {submitting ? "Creating…" : "Create lead"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputCls = "w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20";

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
