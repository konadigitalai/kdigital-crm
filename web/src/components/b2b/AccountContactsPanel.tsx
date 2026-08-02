"use client";

// Contacts on an account.
//
// The employer link is a party_affiliation row with a valid interval, not a
// column — so moving a contact to another company end-dates the old row and
// opens a new one, and the history survives. This panel only ever shows the
// CURRENT affiliation; the fact that yesterday's is still on file is the
// reason "remove" here means "end-date", never "delete the person".

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { createContact, updateContact } from "@/lib/api";
import type { Contact, ContactInput, ContactMethod, ContactRole } from "@/lib/types";
import {
  DialogShell, ErrorNote, Field, Pill, humanise, inputCls,
} from "@/components/admin/formKit";

const ROLES: ContactRole[] = [
  "decision_maker", "evaluator", "sponsor", "influencer", "user", "gatekeeper",
];
const METHODS: ContactMethod[] = ["email", "phone", "whatsapp", "sms", "none"];

const ROLE_TONE: Record<ContactRole, "brand" | "info" | "neutral"> = {
  decision_maker: "brand",
  sponsor: "brand",
  evaluator: "info",
  influencer: "info",
  user: "neutral",
  gatekeeper: "neutral",
};

export function AccountContactsPanel({
  accountPartyId, initial,
}: {
  accountPartyId: string; initial: Contact[];
}) {
  const router = useRouter();
  const [contacts, setContacts] = useState<Contact[]>(initial);
  const [editing, setEditing] = useState<Contact | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(input: ContactInput) {
    setBusy(true); setError(null);
    try {
      if (editing === "new") {
        const created = await createContact({ ...input, accountPartyId });
        setContacts((all) => [...all, created].sort((a, b) => a.name.localeCompare(b.name)));
      } else if (editing) {
        const updated = await updateContact(editing.partyId, input);
        // A contact moved to another employer no longer belongs on this panel.
        setContacts((all) =>
          updated.accountPartyId === accountPartyId
            ? all.map((c) => (c.partyId === updated.partyId ? updated : c))
            : all.filter((c) => c.partyId !== updated.partyId));
      }
      setEditing(null);
      router.refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-rule bg-paper">
      <header className="flex items-center justify-between border-b border-rule bg-warm px-4 py-3">
        <h2 className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">
          Contacts {contacts.length > 0 && <span className="text-hint">({contacts.length})</span>}
        </h2>
        <button
          onClick={() => setEditing("new")}
          className="flex items-center gap-1 text-[11.5px] font-semibold text-brand-violet hover:underline"
        >
          <Icon name="plus" size={12} strokeWidth={2.4} /> Add
        </button>
      </header>

      {contacts.length === 0 ? (
        <div className="px-4 py-8 text-center text-[12.5px] text-mute">
          Nobody recorded at this organisation yet.
        </div>
      ) : contacts.map((c) => (
        <div key={c.partyId} className="flex items-start gap-3 border-b border-rule px-4 py-3 last:border-b-0">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold">{c.name}</span>
              {c.contactRole && <Pill tone={ROLE_TONE[c.contactRole]}>{humanise(c.contactRole)}</Pill>}
            </div>
            <div className="mt-0.5 truncate text-[11.5px] text-mute">
              {[c.jobTitle, c.department].filter(Boolean).join(" · ") || "—"}
            </div>
            <div className="mt-0.5 truncate text-[11.5px] text-hint">
              {[c.email, c.phone].filter(Boolean).join(" · ")}
            </div>
          </div>
          <button
            onClick={() => setEditing(c)}
            className="rounded-md border border-rule px-2 py-1 text-[11px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
          >
            Edit
          </button>
        </div>
      ))}

      <div className="px-4 pb-3"><ErrorNote message={error} /></div>

      {editing && (
        <ContactFormDialog
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSubmit={onSubmit}
          busy={busy}
        />
      )}
    </section>
  );
}

function ContactFormDialog({
  initial, onClose, onSubmit, busy,
}: {
  initial?: Contact; onClose: () => void;
  onSubmit: (input: ContactInput) => void; busy: boolean;
}) {
  const isEdit = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [jobTitle, setJobTitle] = useState(initial?.jobTitle ?? "");
  const [department, setDepartment] = useState(initial?.department ?? "");
  const [contactRole, setContactRole] = useState<ContactRole | "">(initial?.contactRole ?? "");
  const [method, setMethod] = useState<ContactMethod | "">(initial?.preferredContactMethod ?? "");
  const [language, setLanguage] = useState(initial?.preferredLanguage ?? "");
  const [city, setCity] = useState(initial?.city ?? "");

  return (
    <DialogShell
      title={isEdit ? initial!.name : "New contact"}
      subtitle="A person at this organisation. Their role is what they do in a buying decision — distinct from their job title."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onSubmit({
            name: name.trim(),
            email: email.trim() || null,
            phone: phone.trim() || null,
            city: city.trim() || null,
            jobTitle: jobTitle.trim() || null,
            department: department.trim() || null,
            contactRole: contactRole || null,
            preferredContactMethod: method || null,
            preferredLanguage: language.trim() || null,
          });
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-3 gap-4">
          <Field label="Name" required>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Email">
            <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Phone">
            <input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91…" />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Job title">
            <input className={inputCls} value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="e.g. VP Engineering" />
          </Field>
          <Field label="Department">
            <input className={inputCls} value={department} onChange={(e) => setDepartment(e.target.value)} />
          </Field>
          <Field label="Buying role" hint="What they do in a decision, not their title.">
            <select className={inputCls} value={contactRole} onChange={(e) => setContactRole(e.target.value as ContactRole | "")}>
              <option value="">—</option>
              {ROLES.map((r) => <option key={r} value={r}>{humanise(r)}</option>)}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Preferred contact">
            <select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value as ContactMethod | "")}>
              <option value="">—</option>
              {METHODS.map((m) => <option key={m} value={m}>{humanise(m)}</option>)}
            </select>
          </Field>
          <Field label="Language">
            <input className={inputCls} value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="e.g. English" />
          </Field>
          <Field label="City">
            <input className={inputCls} value={city} onChange={(e) => setCity(e.target.value)} />
          </Field>
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">
            {busy ? "Saving…" : isEdit ? "Save" : "Add contact"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
