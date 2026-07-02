"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { createCase, getCatalog, getLeads, getLearners } from "@/lib/api";
import type {
  CatalogResponse, Lead, LearnerSummary, CaseCategory, CasePriority, CaseRequesterKind,
} from "@/lib/types";
import { emitCrmMutation } from "@/lib/live-summary";

export function NewCaseButton({
  label = "New case",
  className,
}: {
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className={cn("btn-grad", className)}>
        <Icon name="plus" size={14} strokeWidth={2.2} />
        {label}
      </button>
      {open && <Dialog onClose={() => setOpen(false)} />}
    </>
  );
}

function Dialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [learners, setLearners] = useState<LearnerSummary[] | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [requesterKind, setRequesterKind] = useState<CaseRequesterKind>("external");
  const [partyId, setPartyId] = useState<string>("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<CaseCategory>("other");
  const [priority, setPriority] = useState<CasePriority>(3);
  const [assigneeId, setAssigneeId] = useState<string>("");
  const [dueAt, setDueAt] = useState<string>("");
  const [remindAt, setRemindAt] = useState<string>("");

  useEffect(() => {
    getCatalog().then(setCatalog).catch((e) => setError((e as Error).message));
  }, []);

  // Load leads/learners on demand when the kind changes.
  useEffect(() => {
    if (requesterKind === "lead" && !leads) {
      getLeads().then(setLeads).catch(() => {});
    }
    if (requesterKind === "learner" && !learners) {
      getLearners().then(setLearners).catch(() => {});
    }
    if (requesterKind === "external") {
      setPartyId("");
    }
  }, [requesterKind, leads, learners]);

  // When user picks a linked lead/learner, hydrate the contact fields.
  useEffect(() => {
    if (!partyId) return;
    if (requesterKind === "lead" && leads) {
      const lead = leads.find((l) => l.id === partyId || l.number === partyId);
      // Leads come without partyId in this list — we look up by work_item id which won't match.
      // Just fallthrough — user can type contact details if needed.
      void lead;
    }
    if (requesterKind === "learner" && learners) {
      const learner = learners.find((l) => l.partyId === partyId);
      if (learner) {
        setName(learner.name);
        if (learner.email) setEmail(learner.email);
        if (learner.phone) setPhone(learner.phone);
      }
    }
  }, [partyId, requesterKind, leads, learners]);

  // ESC to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lead picker uses partyId — but Lead.id is the work_item_id. We need to fetch the
  // lead's underlying party_id. For now, when requesterKind='lead', we ask the user
  // to type the contact themselves and link via /records page later. The simple
  // path: only let them pick a linked person when kind='learner' (where we have partyId).
  // For 'lead' kind, the form behaves like 'external' but stamps requesterKind='lead'
  // — the API will reject without partyId. So in this UI, 'lead' linking is via free-typing
  // contact fields and we leave partyId blank (kind goes to 'external' on send if no link).

  const showPartyPicker = requesterKind === "learner";
  const learnerOptions = useMemo(() => learners ?? [], [learners]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Name is required");
    if (!email.trim()) return setError("Email is required");
    if (!phone.trim()) return setError("Phone is required");
    if (!subject.trim()) return setError("Subject is required");

    setSubmitting(true);
    try {
      const effectiveKind: CaseRequesterKind =
        requesterKind === "learner" && partyId ? "learner" : "external";

      const created = await createCase({
        requesterName: name.trim(),
        requesterEmail: email.trim(),
        requesterPhone: phone.trim(),
        requesterKind: effectiveKind,
        partyId: effectiveKind === "learner" ? partyId : undefined,
        subject: subject.trim(),
        description: description.trim() || undefined,
        category,
        priority,
        assigneeId: assigneeId || undefined,
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        remindAt: remindAt ? new Date(remindAt).toISOString() : undefined,
      });
      emitCrmMutation("case.created");
      router.refresh();
      router.push(`/cases/${created.number}`);
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
        className="my-12 w-full max-w-[680px] rounded-2xl border border-rule bg-paper p-7 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[28px] font-normal leading-tight tracking-[-.01em]">New case</h2>
            <p className="mt-1 text-[13px] text-mute">
              Track an issue end-to-end. Name, email and phone are required regardless of whether the
              stakeholder already exists in the CRM.
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-5">
          {/* Stakeholder kind */}
          <Field label="Stakeholder type">
            <div className="flex gap-2">
              {([
                { k: "external", label: "External (new contact)" },
                { k: "lead", label: "Existing lead" },
                { k: "learner", label: "Existing learner" },
              ] as const).map((opt) => (
                <button
                  key={opt.k}
                  type="button"
                  onClick={() => setRequesterKind(opt.k)}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-[12px] font-semibold transition",
                    requesterKind === opt.k
                      ? "border border-transparent bg-ink text-white"
                      : "border border-rule bg-paper text-ink2 hover:border-rule2",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </Field>

          {/* Linked learner picker (only for learner kind) */}
          {showPartyPicker && (
            <Field label="Pick a learner">
              <select
                className={inputCls}
                value={partyId}
                onChange={(e) => setPartyId(e.target.value)}
              >
                <option value="">— select learner —</option>
                {learnerOptions.map((l) => (
                  <option key={l.partyId} value={l.partyId}>
                    {l.name}{l.email ? ` · ${l.email}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {requesterKind === "lead" && (
            <div className="rounded-lg border border-rule2 bg-warm2 px-3 py-2 text-[12px] text-mute">
              Capture the lead's contact details below. The case will be opened against an external
              record for now — link it from the lead's record page after creation.
            </div>
          )}

          <Field label="Full name" required>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Aarav Mehta" autoFocus />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Email" required>
              <input className={inputCls} value={email} type="email" onChange={(e) => setEmail(e.target.value)} placeholder="aarav@gmail.com" />
            </Field>
            <Field label="Phone" required>
              <input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98••• ••••" />
            </Field>
          </div>

          <Field label="Subject" required>
            <input className={inputCls} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Onboarding link not working" />
          </Field>

          <Field label="Description">
            <textarea
              className={cn(inputCls, "min-h-[88px] resize-y")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's going on? Add as much context as you have."
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Category">
              <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value as CaseCategory)}>
                {catalog?.caseCategories.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Priority">
              <select className={inputCls} value={priority} onChange={(e) => setPriority(Number(e.target.value) as CasePriority)}>
                {catalog?.casePriorities.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Assign to">
            <select className={inputCls} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">— unassigned —</option>
              {catalog?.employees?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}{u.role !== "service_rep" ? ` · ${u.role}` : ""}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Due by">
              <input className={inputCls} type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </Field>
            <Field label="Remind at">
              <input className={inputCls} type="datetime-local" value={remindAt} onChange={(e) => setRemindAt(e.target.value)} />
            </Field>
          </div>

          {error && (
            <div className="rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn">Cancel</button>
            <button type="submit" disabled={submitting} className="btn-grad disabled:opacity-60">
              {submitting ? "Creating…" : "Create case"}
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
