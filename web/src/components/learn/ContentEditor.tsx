"use client";

// LMS admin — build the modules, resources and coursework inside one batch.
//
// Everything is optimistic-free on purpose: each action awaits the API and
// then router.refresh(). Content authoring is low-frequency and low-latency
// tolerance, and getting a stale tree after a failed write is far more
// confusing than a 300ms wait.
//
// Draft vs published is the safety net — an admin can build a whole module
// before any learner sees a half-finished one.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createLmsModule, updateLmsModule, deleteLmsModule,
  createLmsResource, deleteLmsResource,
  createLmsCoursework, deleteLmsCoursework,
  updateLmsBatch, ApiError,
} from "@/lib/api";
import { hms, RESOURCE_LABEL, COURSEWORK_CHIP, COURSEWORK_LABEL } from "@/lib/lmsUi";
import { batchStatusLabel } from "@/lib/batchStatus";
import { cn } from "@/lib/cn";
import type {
  LmsAdminBatch, LmsAdminContent, ResourceKind, CourseworkType,
} from "@/lib/types";

const KINDS: ResourceKind[] = ["video", "recording", "note", "link", "document"];
const TYPES: CourseworkType[] = ["lab", "assignment", "assessment"];
const STATUSES = ["upcoming", "running", "completed", "cancelled"];

/** Accepts a full Vimeo URL or a bare id and returns the id. Admins paste
 *  whatever is in their address bar; making them extract the number by hand
 *  is the kind of friction that produces broken rows. */
function vimeoId(input: string): string {
  const s = input.trim();
  const m = s.match(/vimeo\.com\/(?:video\/)?(\d+)/i) ?? s.match(/^(\d+)$/);
  return m?.[1] ?? s;
}

export function ContentEditor({
  batch, content,
}: { batch: LmsAdminBatch; content: LmsAdminContent }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [openModule, setOpenModule] = useState<string | null>(content.modules[0]?.id ?? null);
  const [addingTo, setAddingTo] = useState<{ moduleId: string; what: "resource" | "coursework" } | null>(null);
  const [newModuleTitle, setNewModuleTitle] = useState("");
  // Controlled so the join link has a real Save button. It used to write on
  // blur, which gave no confirmation — you couldn't tell a saved link from one
  // that had silently failed.
  const [joinUrl, setJoinUrl] = useState(batch.joinUrl ?? "");
  const [joinSaved, setJoinSaved] = useState(false);
  const joinDirty = joinUrl.trim() !== (batch.joinUrl ?? "").trim();

  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    start(async () => {
      try { await fn(); router.refresh(); }
      catch (err) {
        setError(err instanceof ApiError
          ? String((err.body as { error?: string })?.error ?? err.message)
          : "Something went wrong");
      }
    });
  };

  return (
    <div className="space-y-6">
      {error ? (
        <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</p>
      ) : null}

      {/* ── batch-level settings ─────────────────────────────────────────── */}
      <section className="rounded-2xl border border-black/5 bg-white p-5">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink/45">Batch settings</h2>
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <label className="block">
            <span className="text-xs text-ink/50">Status</span>
            <select
              defaultValue={batch.status}
              onChange={(e) => run(() => updateLmsBatch(batch.id, { status: e.target.value }))}
              className="mt-1 block rounded-lg border border-black/10 bg-white px-3 py-2 text-sm"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>{batchStatusLabel(s)}</option>
              ))}
            </select>
          </label>

          <div className="min-w-[18rem] flex-1">
            <label className="block">
              <span className="text-xs text-ink/50">Live class join link (applies to every session)</span>
              <input
                value={joinUrl}
                onChange={(e) => { setJoinUrl(e.target.value); setJoinSaved(false); }}
                placeholder="https://us06web.zoom.us/j/… or https://meet.google.com/…"
                className="mt-1 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400"
              />
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={pending || !joinDirty}
                onClick={() => run(async () => {
                  await updateLmsBatch(batch.id, { joinUrl: joinUrl.trim() || null });
                  setJoinSaved(true);
                })}
                className="rounded-full bg-ink px-4 py-1.5 text-xs font-medium text-white transition hover:bg-ink/90 disabled:opacity-40"
              >
                {pending ? "Saving…" : joinDirty ? "Save link" : "Saved"}
              </button>
              {joinSaved && !joinDirty ? (
                <span className="text-xs text-emerald-700">
                  Saved — learners see a Join button on this batch and on every scheduled class.
                </span>
              ) : (
                <span className="text-xs text-ink/45">
                  Learners see this as a Join button on the batch page, Today, and each class in Schedule.
                </span>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── modules ──────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        {content.modules.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-black/10 bg-white/50 p-8 text-center text-sm text-ink/50">
            No modules yet. Add the first one below — learners see nothing until a module is published.
          </p>
        ) : null}

        {content.modules.map((m) => {
          const resources = content.resources.filter((r) => r.moduleId === m.id);
          const coursework = content.coursework.filter((c) => c.moduleId === m.id);
          const open = openModule === m.id;
          return (
            <div key={m.id} className="overflow-hidden rounded-2xl border border-black/5 bg-white">
              <div className="flex flex-wrap items-center gap-3 p-4">
                <button
                  type="button"
                  onClick={() => setOpenModule(open ? null : m.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span className="font-mono text-xs text-ink/40">{String(m.rank).padStart(2, "0")}</span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{m.title}</span>
                    <span className="text-xs text-ink/45">
                      {resources.length} resources · {coursework.length} coursework
                    </span>
                  </span>
                </button>
                <span className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-medium",
                  m.status === "published" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900")}>
                  {m.status}
                </span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => updateLmsModule(m.id, {
                    status: m.status === "published" ? "draft" : "published",
                  }))}
                  className="rounded-full border border-black/10 px-3 py-1.5 text-xs hover:bg-black/5 disabled:opacity-40"
                >
                  {m.status === "published" ? "Unpublish" : "Publish"}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (!confirm(`Delete "${m.title}" and everything in it?`)) return;
                    run(() => deleteLmsModule(m.id));
                  }}
                  className="rounded-full px-3 py-1.5 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-40"
                >
                  Delete
                </button>
              </div>

              {open ? (
                <div className="border-t border-black/5 bg-black/[0.015] p-4">
                  <h4 className="font-mono text-[10px] uppercase tracking-wide text-ink/45">Resources</h4>
                  <ul className="mt-2 space-y-1.5">
                    {resources.map((r) => (
                      <li key={r.id} className="flex items-center gap-3 rounded-lg bg-white px-3 py-2 text-sm">
                        <span className="w-24 shrink-0 font-mono text-[10px] uppercase text-ink/40">
                          {RESOURCE_LABEL[r.kind]}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{r.title}</span>
                        {r.durationSeconds ? (
                          <span className="font-mono text-[11px] text-ink/40">{hms(r.durationSeconds)}</span>
                        ) : null}
                        {!r.required ? <span className="text-[11px] text-ink/40">optional</span> : null}
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => run(() => deleteLmsResource(r.id))}
                          className="text-xs text-rose-700 hover:underline disabled:opacity-40"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                    {resources.length === 0 ? (
                      <li className="px-3 py-2 text-xs text-ink/40">No resources yet.</li>
                    ) : null}
                  </ul>

                  <h4 className="mt-5 font-mono text-[10px] uppercase tracking-wide text-ink/45">Coursework</h4>
                  <ul className="mt-2 space-y-1.5">
                    {coursework.map((c) => (
                      <li key={c.id} className="flex items-center gap-3 rounded-lg bg-white px-3 py-2 text-sm">
                        <span className={cn("rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold", COURSEWORK_CHIP[c.type])}>
                          {COURSEWORK_LABEL[c.type]}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{c.title}</span>
                        {c.dueAt ? (
                          <span className="text-[11px] text-ink/45">
                            due {new Date(c.dueAt).toLocaleDateString()}
                          </span>
                        ) : <span className="text-[11px] text-amber-700">no due date</span>}
                        {c.awaitingGrading > 0 ? (
                          <a href={`/learn/admin/grade/${c.id}`}
                             className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-200">
                            {c.awaitingGrading} to grade
                          </a>
                        ) : (
                          <a href={`/learn/admin/grade/${c.id}`} className="text-xs text-indigo-700 hover:underline">
                            Submissions
                          </a>
                        )}
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => run(() => deleteLmsCoursework(c.id))}
                          className="text-xs text-rose-700 hover:underline disabled:opacity-40"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                    {coursework.length === 0 ? (
                      <li className="px-3 py-2 text-xs text-ink/40">No coursework yet.</li>
                    ) : null}
                  </ul>

                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      onClick={() => setAddingTo(addingTo?.moduleId === m.id && addingTo.what === "resource" ? null : { moduleId: m.id, what: "resource" })}
                      className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs hover:bg-black/5"
                    >
                      + Resource
                    </button>
                    <button
                      type="button"
                      onClick={() => setAddingTo(addingTo?.moduleId === m.id && addingTo.what === "coursework" ? null : { moduleId: m.id, what: "coursework" })}
                      className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs hover:bg-black/5"
                    >
                      + Coursework
                    </button>
                  </div>

                  {addingTo?.moduleId === m.id && addingTo.what === "resource" ? (
                    <ResourceForm
                      pending={pending}
                      onCancel={() => setAddingTo(null)}
                      onSubmit={(body) => run(async () => {
                        await createLmsResource(m.id, body);
                        setAddingTo(null);
                      })}
                    />
                  ) : null}

                  {addingTo?.moduleId === m.id && addingTo.what === "coursework" ? (
                    <CourseworkForm
                      pending={pending}
                      onCancel={() => setAddingTo(null)}
                      onSubmit={(body) => run(async () => {
                        await createLmsCoursework(m.id, body);
                        setAddingTo(null);
                      })}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </section>

      {/* ── add a module ─────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-dashed border-black/15 bg-white/60 p-4">
        <div className="flex flex-wrap gap-2">
          <input
            value={newModuleTitle}
            onChange={(e) => setNewModuleTitle(e.target.value)}
            placeholder="New module title — e.g. Deep Learning & Neural Networks"
            className="min-w-[18rem] flex-1 rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400"
          />
          <button
            type="button"
            disabled={pending || !newModuleTitle.trim()}
            onClick={() => run(async () => {
              await createLmsModule(batch.id, { title: newModuleTitle.trim() });
              setNewModuleTitle("");
            })}
            className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-40"
          >
            Add module
          </button>
        </div>
        <p className="mt-2 text-xs text-ink/45">
          Modules are created as drafts. Publish when the content inside is ready.
        </p>
      </section>
    </div>
  );
}

// ─── sub-forms ─────────────────────────────────────────────────────────────

function ResourceForm({
  pending, onCancel, onSubmit,
}: {
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: {
    title: string; kind: ResourceKind; videoRef?: string | null;
    durationSeconds?: number | null; body?: string | null;
    externalUrl?: string | null; required?: boolean;
  }) => void;
}) {
  const [kind, setKind] = useState<ResourceKind>("video");
  const [title, setTitle] = useState("");
  const [ref, setRef] = useState("");
  const [minutes, setMinutes] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [required, setRequired] = useState(true);

  const canSave = title.trim() && (
    kind === "video" || kind === "recording" ? ref.trim()
    : kind === "note" ? text.trim()
    : kind === "link" ? url.trim()
    : false   // document needs a Blob store — see the note below
  );

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-black/10 bg-white p-4">
      <div className="flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <button
            key={k} type="button" onClick={() => setKind(k)}
            className={cn("rounded-full px-3 py-1.5 text-xs capitalize transition",
              kind === k ? "bg-ink text-white" : "border border-black/10 hover:bg-black/5")}
          >
            {RESOURCE_LABEL[k]}
          </button>
        ))}
      </div>

      <input
        value={title} onChange={(e) => setTitle(e.target.value)}
        placeholder="Title — e.g. Optimisers: SGD to AdamW"
        className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-indigo-400"
      />

      {kind === "video" || kind === "recording" ? (
        <div className="flex flex-wrap gap-2">
          <input
            value={ref} onChange={(e) => setRef(e.target.value)}
            placeholder="Vimeo URL or ID"
            className="min-w-[16rem] flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-indigo-400"
          />
          <input
            value={minutes} onChange={(e) => setMinutes(e.target.value)}
            placeholder="Length (min)" inputMode="numeric"
            className="w-32 rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-indigo-400"
          />
        </div>
      ) : null}

      {kind === "note" ? (
        <textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={5}
          placeholder="Markdown notes…"
          className="w-full resize-y rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-indigo-400"
        />
      ) : null}

      {kind === "link" ? (
        <input
          value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-indigo-400"
        />
      ) : null}

      {kind === "document" ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Document upload needs a Vercel Blob store. Set <code>BLOB_READ_WRITE_TOKEN</code> and{" "}
          <code>BLOB_STORE_ID</code> on the API, then documents can be attached from the media library.
          Until then, use a Link resource pointing at the file.
        </p>
      ) : null}

      <label className="flex items-center gap-2 text-sm text-ink/70">
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
        Counts toward completion
      </label>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || !canSave}
          onClick={() => onSubmit({
            title: title.trim(),
            kind,
            videoRef: kind === "video" || kind === "recording" ? vimeoId(ref) : null,
            durationSeconds: minutes.trim() ? Math.round(Number(minutes) * 60) : null,
            body: kind === "note" ? text : null,
            externalUrl: kind === "link" ? url.trim() : null,
            required,
          })}
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Add resource
        </button>
        <button type="button" onClick={onCancel} className="rounded-full border border-black/10 px-4 py-2 text-sm hover:bg-black/5">
          Cancel
        </button>
      </div>
    </div>
  );
}

function CourseworkForm({
  pending, onCancel, onSubmit,
}: {
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: {
    title: string; type: CourseworkType; brief?: string | null;
    maxScore?: number | null; dueAt?: string | null;
  }) => void;
}) {
  const [type, setType] = useState<CourseworkType>("lab");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [maxScore, setMaxScore] = useState("100");
  const [dueAt, setDueAt] = useState("");

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-black/10 bg-white p-4">
      <div className="flex flex-wrap gap-2">
        {TYPES.map((t) => (
          <button
            key={t} type="button" onClick={() => setType(t)}
            className={cn("rounded-full px-3 py-1.5 text-xs capitalize transition",
              type === t ? "bg-ink text-white" : "border border-black/10 hover:bg-black/5")}
          >
            {t}
          </button>
        ))}
      </div>
      <input
        value={title} onChange={(e) => setTitle(e.target.value)}
        placeholder="Title — e.g. Lab: train on CIFAR-10"
        className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-indigo-400"
      />
      <textarea
        value={brief} onChange={(e) => setBrief(e.target.value)} rows={3}
        placeholder="Brief — what the learner has to do"
        className="w-full resize-y rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-indigo-400"
      />
      <div className="flex flex-wrap gap-2">
        <label className="block">
          <span className="text-xs text-ink/50">Max score</span>
          <input
            value={maxScore} onChange={(e) => setMaxScore(e.target.value)} inputMode="numeric"
            className="mt-1 w-28 rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-indigo-400"
          />
        </label>
        <label className="block">
          <span className="text-xs text-ink/50">Due</span>
          <input
            type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)}
            className="mt-1 rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-indigo-400"
          />
        </label>
      </div>
      <p className="text-xs text-ink/45">
        Grading is by a trainer. Auto-grading is reserved but not built — a score entered here is final.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || !title.trim()}
          onClick={() => onSubmit({
            title: title.trim(), type,
            brief: brief.trim() || null,
            maxScore: maxScore.trim() ? Number(maxScore) : null,
            dueAt: dueAt ? new Date(dueAt).toISOString() : null,
          })}
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Add coursework
        </button>
        <button type="button" onClick={onCancel} className="rounded-full border border-black/10 px-4 py-2 text-sm hover:bg-black/5">
          Cancel
        </button>
      </div>
    </div>
  );
}
