"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import {
  createEvent,
  deleteEvent,
  getEvent,
  respondToEvent,
  setEventInvitees,
  updateEvent,
} from "@/lib/api";
import type {
  CalendarEventDetail,
  CalendarInvitee,
  EventRsvp,
} from "@/lib/types";
import { InviteePicker } from "./InviteePicker";

interface Person { id: string; name: string; email: string; role: string }

interface CommonProps {
  meId: string;
  people: Person[];
  onClose: () => void;
  onSaved: () => void;
}

interface CreateProps extends CommonProps {
  mode: "create";
  defaultStart: string;
  defaultEnd: string;
}
interface DetailProps extends CommonProps {
  mode: "detail";
  eventId: string;
}

export function EventDialog(props: CreateProps | DetailProps) {
  return props.mode === "create" ? <CreateDialog {...props} /> : <DetailDialog {...props} />;
}

function CreateDialog({ people, meId, defaultStart, defaultEnd, onClose, onSaved }: CreateProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultEnd);
  const [allDay, setAllDay] = useState(false);
  const [invitees, setInvitees] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!title.trim()) { setErr("Title is required"); return; }
    if (new Date(end) <= new Date(start)) { setErr("End must be after start"); return; }
    setBusy(true);
    try {
      await createEvent({
        title: title.trim(),
        description: description.trim() || null,
        location: location.trim() || null,
        startAt: new Date(start).toISOString(),
        endAt: new Date(end).toISOString(),
        allDay,
        inviteeIds: invitees,
      });
      onSaved();
    } catch (e2) { setErr((e2 as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Shell title="New event" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Title" required>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} autoFocus placeholder="Sales sync" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts">
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Ends">
            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[12.5px] text-ink2">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> All day
        </label>
        <Field label="Location">
          <input value={location} onChange={(e) => setLocation(e.target.value)} className={inputCls} placeholder="Conference room / video link" />
        </Field>
        <Field label="Description">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} className={cn(inputCls, "min-h-[60px] resize-y")} />
        </Field>
        <Field label="Invite teammates">
          <InviteePicker people={people} value={invitees} onChange={setInvitees} organizerId={meId} />
        </Field>
        {err && <div className="rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">{err}</div>}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">
            {busy ? "Saving…" : "Create event"}
          </button>
        </div>
      </form>
    </Shell>
  );
}

function DetailDialog({ eventId, people, meId, onClose, onSaved }: DetailProps) {
  const [detail, setDetail] = useState<CalendarEventDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Editor state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [invitees, setInvitees] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    getEvent(eventId).then((d) => {
      if (!alive) return;
      if (!d) { setErr("Event not found"); return; }
      setDetail(d);
      setTitle(d.event.title);
      setDescription(d.event.description ?? "");
      setLocation(d.event.location ?? "");
      setStart(toLocalInput(d.event.startAt));
      setEnd(toLocalInput(d.event.endAt));
      setAllDay(d.event.allDay);
      setInvitees(d.invitees.filter((i) => i.userId !== d.event.organizerId).map((i) => i.userId));
    }).catch((e) => setErr((e as Error).message));
    return () => { alive = false; };
  }, [eventId]);

  if (!detail) {
    return (
      <Shell title="Event" onClose={onClose}>
        {err ? <div className="text-[13px] text-state-warn">{err}</div> : <div className="text-[13px] text-mute">Loading…</div>}
      </Shell>
    );
  }

  const isOrganizer = detail.event.organizerId === meId;
  const myInvite = detail.invitees.find((i) => i.userId === meId);

  async function save() {
    setBusy(true); setErr(null);
    try {
      await updateEvent(eventId, {
        title: title.trim(),
        description: description.trim() || null,
        location: location.trim() || null,
        startAt: new Date(start).toISOString(),
        endAt: new Date(end).toISOString(),
        allDay,
      });
      await setEventInvitees(eventId, invitees);
      onSaved();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  async function remove() {
    if (!confirm("Delete this event for everyone?")) return;
    setBusy(true); setErr(null);
    try { await deleteEvent(eventId); onSaved(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  async function rsvp(next: EventRsvp) {
    setBusy(true); setErr(null);
    try { await respondToEvent(eventId, next); onSaved(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <Shell title={isOrganizer && editing ? "Edit event" : detail.event.title} onClose={onClose}
           subtitle={!editing ? eventTimeStr(detail.event.startAt, detail.event.endAt, detail.event.allDay) : undefined}>
      {!editing ? (
        <div className="space-y-4">
          <div className="grid grid-cols-[80px_1fr] gap-y-2 text-[13px]">
            {detail.event.location && <>
              <div className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">Where</div>
              <div className="text-ink">{detail.event.location}</div>
            </>}
            <div className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">Organizer</div>
            <div className="text-ink">{detail.event.organizerName ?? "—"}{isOrganizer && <span className="ml-1 text-mute">(you)</span>}</div>
            {detail.event.description && <>
              <div className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">Notes</div>
              <div className="whitespace-pre-wrap text-ink2">{detail.event.description}</div>
            </>}
          </div>

          <div>
            <div className="mono-cap mb-2 text-[10px] font-semibold tracking-[.12em] text-mute">Invitees ({detail.invitees.length})</div>
            <div className="divide-y divide-rule rounded-[10px] border border-rule">
              {detail.invitees.map((i) => (
                <div key={i.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold">{i.name ?? i.email}</div>
                    <div className="truncate text-[11px] text-mute">{i.email}</div>
                  </div>
                  <RsvpBadge rsvp={i.rsvp} />
                </div>
              ))}
            </div>
          </div>

          {!isOrganizer && myInvite && (
            <div className="border-t border-rule pt-4">
              <div className="mono-cap mb-2 text-[10px] font-semibold tracking-[.12em] text-mute">Your response</div>
              <div className="flex gap-2">
                <RsvpBtn label="Accept" tone="ok"   active={myInvite.rsvp === "accepted"}  onClick={() => rsvp("accepted")} disabled={busy} />
                <RsvpBtn label="Tentative" tone="amber" active={myInvite.rsvp === "tentative"} onClick={() => rsvp("tentative")} disabled={busy} />
                <RsvpBtn label="Decline" tone="warn" active={myInvite.rsvp === "declined"}  onClick={() => rsvp("declined")} disabled={busy} />
              </div>
            </div>
          )}

          {err && <div className="rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">{err}</div>}

          {isOrganizer && (
            <div className="flex items-center justify-between border-t border-rule pt-4">
              <button onClick={remove} disabled={busy} className="text-[12px] font-semibold text-state-warn hover:underline">Delete event</button>
              <button onClick={() => setEditing(true)} className="btn-grad">Edit event</button>
            </div>
          )}
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); save(); }} className="space-y-3">
          <Field label="Title" required>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts">
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Ends">
              <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-[12.5px] text-ink2">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> All day
          </label>
          <Field label="Location">
            <input value={location} onChange={(e) => setLocation(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Description">
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} className={cn(inputCls, "min-h-[60px] resize-y")} />
          </Field>
          <Field label="Invitees">
            <InviteePicker people={people} value={invitees} onChange={setInvitees} organizerId={meId} />
          </Field>
          {err && <div className="rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">{err}</div>}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button type="button" onClick={() => setEditing(false)} className="btn">Cancel</button>
            <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">{busy ? "Saving…" : "Save changes"}</button>
          </div>
        </form>
      )}
    </Shell>
  );
}

function RsvpBadge({ rsvp }: { rsvp: CalendarInvitee["rsvp"] }) {
  const map: Record<EventRsvp, { label: string; cls: string }> = {
    pending:   { label: "Pending",   cls: "bg-warm2 text-mute" },
    accepted:  { label: "Going",     cls: "bg-state-ok/10 text-state-ok" },
    declined:  { label: "Declined",  cls: "bg-state-warn/10 text-state-warn" },
    tentative: { label: "Maybe",     cls: "bg-state-amber/10 text-state-amber" },
  };
  const m = map[rsvp];
  return <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", m.cls)}>{m.label}</span>;
}

function RsvpBtn({
  label, tone, active, onClick, disabled,
}: {
  label: string;
  tone: "ok" | "amber" | "warn";
  active: boolean;
  onClick: () => void;
  disabled: boolean;
}) {
  const tones = {
    ok:    "border-state-ok/30 text-state-ok hover:bg-state-ok/10",
    amber: "border-state-amber/30 text-state-amber hover:bg-state-amber/10",
    warn:  "border-state-warn/30 text-state-warn hover:bg-state-warn/10",
  };
  const activeTones = {
    ok:    "bg-state-ok text-white border-state-ok",
    amber: "bg-state-amber text-white border-state-amber",
    warn:  "bg-state-warn text-white border-state-warn",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-md border px-3 py-1.5 text-[12px] font-semibold transition disabled:opacity-50",
        active ? activeTones[tone] : tones[tone],
      )}
    >
      {label}
    </button>
  );
}

function Shell({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="my-12 w-full max-w-[560px] rounded-2xl border border-rule bg-paper p-6 shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[24px] font-normal leading-tight">{title}</h2>
            {subtitle && <p className="mt-1 text-[13px] text-mute">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputCls = "w-full rounded-[10px] border border-rule bg-paper px-3 py-2 text-[13px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20";

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mono-cap mb-1 block text-[10px] font-semibold tracking-[.12em] text-mute">
        {label}{required && <span className="ml-1 text-brand-magenta">*</span>}
      </span>
      {children}
    </label>
  );
}

function toLocalInput(iso: string): string {
  // ISO → "yyyy-MM-ddTHH:mm" in IST for the datetime-local input.
  const d = new Date(iso);
  const ist = new Date(d.getTime() + (5 * 60 + 30) * 60_000);
  return ist.toISOString().slice(0, 16);
}

function eventTimeStr(startISO: string, endISO: string, allDay: boolean): string {
  const fmt = (iso: string) => new Date(iso).toLocaleString("en-IN", {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata",
  });
  if (allDay) {
    const dayFmt = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
    return `${dayFmt(startISO)} · all day`;
  }
  return `${fmt(startISO)} → ${fmt(endISO).split(", ")[1] ?? fmt(endISO)}`;
}
