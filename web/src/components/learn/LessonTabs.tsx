"use client";

// The panel under a lesson: Overview · Notes · Resources.
//
// Split out of BatchPlayer because notes carry their own fetch + mutation
// lifecycle, and folding that into the player would have made one component
// responsible for playback, progress, navigation and CRUD at once.
//
// "Resources" are the module's document and link items. In our model those
// are module_resource rows like any other, but they aren't lessons — nobody
// works *through* a reading list — so they surface as attachments here
// rather than as steps in the sidebar.

import { useEffect, useState, useTransition } from "react";
import { addLmsNote, deleteLmsNote, getLmsNotes } from "@/lib/api";
import { hms, RESOURCE_LABEL } from "@/lib/lmsUi";
import { cn } from "@/lib/cn";
import type { LmsBatchDetail, LmsNote, LmsResource } from "@/lib/types";

type TabKey = "overview" | "notes" | "resources";

export function LessonTabs({
  resource, module: mod, batch, attachments, completed, positionRef,
}: {
  resource: LmsResource;
  module: { id: string; title: string } | null;
  batch: LmsBatchDetail["batch"];
  attachments: LmsResource[];
  completed: boolean;
  /** Live playhead, so a note pins to where the learner actually is. */
  positionRef: React.MutableRefObject<number>;
}) {
  const [tab, setTab] = useState<TabKey>("overview");
  const [notes, setNotes] = useState<LmsNote[] | null>(null);
  const [draft, setDraft] = useState("");
  const [at, setAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Load lazily — most lessons are watched without ever opening Notes.
  useEffect(() => {
    if (tab !== "notes" || notes !== null) return;
    let alive = true;
    getLmsNotes(resource.id)
      .then((n) => { if (alive) setNotes(n); })
      .catch(() => { if (alive) setNotes([]); });
    return () => { alive = false; };
  }, [tab, notes, resource.id]);

  // Reset when the lesson changes, or you'd see the previous lesson's notes.
  useEffect(() => { setNotes(null); setDraft(""); setTab("overview"); }, [resource.id]);

  // Capture the playhead when the field is focused, not when saved — by the
  // time someone finishes typing the video has moved on.
  const captureAt = () => setAt(Math.floor(positionRef.current || 0));

  const save = () => {
    const body = draft.trim();
    if (!body) return;
    setError(null);
    start(async () => {
      try {
        const created = await addLmsNote(resource.id, body, at);
        setNotes((prev) => [...(prev ?? []), created]
          .sort((a, b) => a.positionSeconds - b.positionSeconds));
        setDraft("");
      } catch { setError("Could not save that note. Try again."); }
    });
  };

  const remove = (id: string) => {
    start(async () => {
      try {
        await deleteLmsNote(id);
        setNotes((prev) => (prev ?? []).filter((n) => n.id !== id));
      } catch { setError("Could not delete that note."); }
    });
  };

  const timed = resource.kind === "video" || resource.kind === "recording";

  const TABS: Array<{ key: TabKey; label: string; badge?: number }> = [
    { key: "overview", label: "Overview" },
    { key: "notes", label: "Notes", badge: notes?.length || undefined },
    { key: "resources", label: "Resources", badge: attachments.length || undefined },
  ];

  return (
    <div>
      <div className="flex gap-6 border-b border-black/10">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "-mb-px border-b-2 pb-2.5 text-sm transition",
              tab === t.key
                ? "border-indigo-600 font-medium text-ink"
                : "border-transparent text-ink/50 hover:text-ink/80",
            )}
          >
            {t.label}
            {t.badge ? <sup className="ml-1 font-mono text-[10px] text-ink/40">{t.badge}</sup> : null}
          </button>
        ))}
      </div>

      <div className="pt-5">
        {tab === "overview" ? (
          <div className="space-y-4">
            {resource.kind === "note" && resource.body ? (
              <article className="rounded-2xl border border-black/5 bg-white p-6">
                <p className="font-mono text-[10px] uppercase tracking-wide text-indigo-700">About this lesson</p>
                <div className="mt-2 whitespace-pre-wrap text-[15px] leading-[1.75] text-ink/85">
                  {resource.body}
                </div>
              </article>
            ) : (
              <div className="rounded-2xl border border-black/5 bg-white p-6">
                <p className="font-mono text-[10px] uppercase tracking-wide text-indigo-700">About this lesson</p>
                <p className="mt-2 text-sm text-ink/70">
                  {timed
                    ? "Watch the recording above. Anything you note is pinned to the point you were at."
                    : "Open the material above."}
                  {attachments.length > 0
                    ? ` ${attachments.length} supporting ${attachments.length === 1 ? "item" : "items"} in Resources.`
                    : ""}
                </p>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <dl className="rounded-2xl border border-black/5 bg-white p-5 text-sm">
                <p className="mb-3 font-mono text-[10px] uppercase tracking-wide text-ink/45">This lesson</p>
                {[
                  ["Type", RESOURCE_LABEL[resource.kind]],
                  ["Length", resource.durationSeconds ? hms(resource.durationSeconds) : "—"],
                  ["Module", mod?.title ?? "—"],
                  ["Status", completed ? "Completed" : "Not finished"],
                  ["Counts toward progress", resource.required ? "Yes" : "Optional"],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4 border-t border-black/5 py-2 first:border-0">
                    <dt className="text-ink/50">{k}</dt>
                    <dd className="text-right font-medium">{v}</dd>
                  </div>
                ))}
              </dl>

              <div className="rounded-2xl border border-black/5 bg-white p-5">
                <p className="font-mono text-[10px] uppercase tracking-wide text-ink/45">
                  Live classes{batch.code ? ` · ${batch.code}` : ""}
                </p>
                <p className="mt-3 text-sm font-medium">{batch.name}</p>
                <p className="mt-1 text-sm text-ink/55">
                  {batch.trainerName ? `${batch.trainerName} · ` : ""}
                  {batch.startDate && batch.endDate
                    ? `${new Date(batch.startDate).toLocaleDateString(undefined, { day: "numeric", month: "short" })} – ${new Date(batch.endDate).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
                    : "Dates to be confirmed"}
                </p>
                {batch.joinUrl ? (
                  <a href={batch.joinUrl} target="_blank" rel="noreferrer"
                     className="mt-4 inline-block text-sm font-medium text-indigo-700 hover:underline">
                    Join the live class →
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {tab === "notes" ? (
          <div className="space-y-4">
            <div className="rounded-2xl border border-black/5 bg-white p-5">
              <textarea
                value={draft}
                onFocus={captureAt}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                placeholder={timed ? `Add a note at ${hms(at)}…` : "Add a note…"}
                className="w-full resize-y rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-indigo-400"
              />
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={pending || !draft.trim()}
                  onClick={save}
                  className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-40"
                >
                  {pending ? "Saving…" : "Save note"}
                </button>
                <span className="text-xs text-ink/45">
                  Notes are private{timed ? " and stay pinned to the timestamp." : "."} Your trainer never sees them.
                </span>
              </div>
              {error ? <p className="mt-2 text-sm text-rose-700">{error}</p> : null}
            </div>

            {notes === null ? (
              <div className="h-20 animate-pulse rounded-2xl bg-black/5" />
            ) : notes.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-black/10 bg-white/50 p-8 text-center">
                <p className="font-medium">No notes on this lesson yet</p>
                <p className="mt-1 text-sm text-ink/55">
                  Anything you save here {timed ? "is pinned to its timestamp and " : ""}stays private to you.
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {notes.map((n) => (
                  <li key={n.id} className="flex gap-3 rounded-2xl border border-black/5 bg-white p-4">
                    {timed ? (
                      <span className="shrink-0 rounded bg-indigo-50 px-2 py-0.5 font-mono text-[11px] text-indigo-800">
                        {hms(n.positionSeconds)}
                      </span>
                    ) : null}
                    <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm text-ink/80">{n.body}</p>
                    <button
                      type="button"
                      onClick={() => remove(n.id)}
                      disabled={pending}
                      className="shrink-0 text-xs text-ink/35 transition hover:text-rose-700 disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {tab === "resources" ? (
          attachments.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-black/10 bg-white/50 p-8 text-center">
              <p className="font-medium">No resources for this module</p>
              <p className="mt-1 text-sm text-ink/55">
                Handbooks, datasets and reading lists appear here when your trainer adds them.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {attachments.map((a) => (
                <li key={a.id} className="flex items-center gap-3 rounded-2xl border border-black/5 bg-white p-4">
                  <span className="shrink-0 rounded bg-black/5 px-2 py-1 font-mono text-[10px] font-semibold text-ink/60">
                    {a.kind === "link" ? "LINK" : "DOC"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.title}</span>
                  {a.kind === "link" && a.externalUrl ? (
                    <a href={a.externalUrl} target="_blank" rel="noreferrer"
                       className="shrink-0 text-sm text-indigo-700 hover:underline">Open</a>
                  ) : (
                    // Documents need a Blob store; BLOB_READ_WRITE_TOKEN is
                    // unset, so say so rather than offer a dead download.
                    <span className="shrink-0 text-xs text-ink/40" title="File storage isn't configured yet">
                      Unavailable
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </div>
  );
}
