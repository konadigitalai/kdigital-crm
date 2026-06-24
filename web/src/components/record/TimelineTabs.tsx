"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { addLeadNote, updateLeadNote } from "@/lib/api";
import type { TimelineRow } from "@/lib/types";

type Tab = "timeline" | "emails" | "notes";

const TABS: { key: Tab; label: string }[] = [
  { key: "timeline", label: "Timeline" },
  { key: "emails",   label: "Emails" },
  { key: "notes",    label: "Notes" },
];

export function TimelineTabs({
  leadNumber, timeline,
}: {
  leadNumber: string;
  timeline: TimelineRow[];
}) {
  const [tab, setTab] = useState<Tab>("timeline");

  // Filter rows by tab.
  const emails = timeline.filter((t) => t.verb === "Email" || t.verb === "Sent" || t.payload?.kind === "email");
  const notes  = timeline.filter((t) => t.verb === "Note" || t.payload?.kind === "note");

  return (
    <>
      <div className="mb-5 flex gap-1 border-b border-rule">
        {TABS.map((t) => {
          const count = t.key === "timeline" ? timeline.length
                      : t.key === "emails"   ? emails.length
                      : notes.length;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "-mb-px border-b-2 px-4 py-2.5 text-[13.5px] font-semibold transition",
                tab === t.key ? "border-brand-violet text-ink" : "border-transparent text-mute hover:text-ink2",
              )}
            >
              {t.label}
              {count > 0 && (
                <span className="ml-1.5 font-mono text-[10.5px] text-mute">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {tab === "timeline" && <TimelineView rows={timeline} />}
      {tab === "emails"   && <EmailsView   rows={emails} />}
      {tab === "notes"    && <NotesView    rows={notes} leadNumber={leadNumber} />}
    </>
  );
}

function TimelineView({ rows }: { rows: TimelineRow[] }) {
  if (rows.length === 0) {
    return <Empty text="No activity yet." />;
  }
  return (
    <div className="tl-rail">
      {rows.map((t, i) => (
        <div key={i} className={cn("tl-node", t.tag === "ai" && "ai", t.tag === "you" && "human")}>
          <div className="mono-cap mb-1.5 text-[10px] tracking-[.08em] text-hint">
            {t.payload?.when ?? new Date(t.ts).toLocaleString()}
          </div>
          <div className="rounded-[13px] border border-rule bg-paper p-[15px_17px]">
            <div className="mb-[7px] flex items-center gap-2.5">
              <span className="text-[13px] font-bold tracking-[-.005em]">{t.actorName}</span>
              <span
                className={cn(
                  "mono-cap rounded-full px-2 py-0.5 text-[8.5px] font-semibold tracking-[.08em]",
                  t.tag === "ai"
                    ? "bg-[rgba(107,31,184,.10)] text-brand-violet"
                    : "bg-[rgba(31,63,207,.08)] text-brand-blue",
                )}
              >
                {t.verb}
              </span>
            </div>
            <p
              className="whitespace-pre-line text-[13px] leading-[1.55] text-ink2"
              dangerouslySetInnerHTML={{ __html: t.detail.replace(/(\d+ → \d+)/, "<b>$1</b>") }}
            />
            {t.payload?.quote && (
              <div className="mt-2.5 rounded-r-lg border-l-2 border-brand-violet bg-warm p-[11px_13px] text-[12.5px] leading-[1.5] text-ink2">
                {t.payload.quote}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmailsView({ rows }: { rows: TimelineRow[] }) {
  if (rows.length === 0) {
    return <Empty text="No emails sent or received yet." />;
  }
  return (
    <div className="flex flex-col gap-3">
      {rows.map((t, i) => (
        <div key={i} className="rounded-[13px] border border-rule bg-paper p-[15px_17px]">
          <div className="mb-2 flex items-center gap-2.5 text-[12.5px]">
            <span className="font-bold">{t.actorName}</span>
            <span className="mono-cap rounded-full bg-[rgba(46,158,106,.10)] px-2 py-0.5 text-[8.5px] font-semibold tracking-[.08em] text-state-ok">
              {t.verb}
            </span>
            <span className="ml-auto font-mono text-[10px] text-mute">
              {t.payload?.when ?? new Date(t.ts).toLocaleString()}
            </span>
          </div>
          <p className="whitespace-pre-line text-[13px] leading-[1.55] text-ink2">{t.detail}</p>
        </div>
      ))}
    </div>
  );
}

function NotesView({ rows, leadNumber }: { rows: TimelineRow[]; leadNumber: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true); setError(null);
    try {
      await addLeadNote(leadNumber, text.trim());
      setText("");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form
        onSubmit={submit}
        className="mb-5 rounded-[14px] border border-rule bg-paper p-3"
      >
        <textarea
          className="w-full resize-y rounded-md border border-rule bg-warm/40 px-3 py-2.5 text-[13px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none"
          placeholder="Add a note about this lead — call summary, next step, anything you want to remember…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
        />
        {error && <div className="mt-2 text-[11px] text-state-warn">{error}</div>}
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-mute">{text.length} characters</span>
          <button type="submit" disabled={busy || !text.trim()} className="btn-grad disabled:opacity-50">
            <Icon name="plus" size={12} strokeWidth={2.4} />
            {busy ? "Saving…" : "Add note"}
          </button>
        </div>
      </form>

      {rows.length === 0 ? (
        <Empty text="No notes yet. Capture something you don't want to forget." />
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((t, i) => (
            <NoteCard key={t.id ?? i} note={t} leadNumber={leadNumber} />
          ))}
        </div>
      )}
    </>
  );
}

function NoteCard({ note, leadNumber }: { note: TimelineRow; leadNumber: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.detail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editHistory = note.payload?.edits ?? [];
  const lastEdit = editHistory.length > 0 ? editHistory[editHistory.length - 1]! : null;
  const lastEdited = lastEdit?.at ?? null;
  const lastEditedBy = lastEdit?.by ?? null;

  async function save() {
    const next = text.trim();
    if (!next) { setError("Note can't be empty"); return; }
    if (next === note.detail) { setEditing(false); return; }
    if (!note.id) { setError("Can't edit this note (missing id)"); return; }
    setBusy(true); setError(null);
    try {
      await updateLeadNote(leadNumber, note.id, next);
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setText(note.detail);
    setError(null);
    setEditing(false);
  }

  return (
    <div className="rounded-[13px] border border-rule bg-paper p-[15px_17px]">
      <div className="mb-2 flex items-center gap-2.5 text-[12.5px]">
        <span className="font-bold">{note.actorName}</span>
        {editHistory.length > 0 && (
          <span
            className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[8.5px] font-semibold tracking-[.08em] text-mute"
            title={
              editHistory
                .map(
                  (e) =>
                    `${e.by ?? "Someone"} on ${new Date(e.at).toLocaleString()}` +
                    (e.previous ? ` — was: "${e.previous}"` : ""),
                )
                .join("\n")
            }
          >
            edited
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-mute">
          {note.payload?.when ?? new Date(note.ts).toLocaleString()}
        </span>
        {!editing && note.id && (
          <button
            onClick={() => setEditing(true)}
            className="text-[11px] font-semibold text-brand-violet hover:underline"
          >
            Edit
          </button>
        )}
      </div>

      {!editing ? (
        <p className="whitespace-pre-line text-[13px] leading-[1.55] text-ink2">{note.detail}</p>
      ) : (
        <>
          <textarea
            className="w-full resize-y rounded-md border border-rule bg-warm/40 px-3 py-2 text-[13px] text-ink focus:border-brand-violet focus:outline-none"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={Math.max(3, Math.min(10, text.split("\n").length + 1))}
            autoFocus
          />
          {error && <div className="mt-2 text-[11px] text-state-warn">{error}</div>}
          <div className="mt-2 flex items-center justify-end gap-2">
            <button onClick={cancel} disabled={busy} className="btn">Cancel</button>
            <button
              onClick={save}
              disabled={busy || !text.trim() || text.trim() === note.detail}
              className="btn-grad disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      )}

      {!editing && lastEdited && (
        <div className="mt-2 font-mono text-[10px] text-hint">
          Last edited{lastEditedBy ? ` by ${lastEditedBy}` : ""} on {new Date(lastEdited).toLocaleString()}
        </div>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-rule p-8 text-center text-[13px] text-mute">
      {text}
    </div>
  );
}
