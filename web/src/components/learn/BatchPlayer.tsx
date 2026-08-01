"use client";

// Batch content browser + player.
//
// Progress is written from here, not from the server pages, because only the
// client knows where the video actually is. Two rules keep it cheap and
// honest:
//
//   * Save on a 15s heartbeat and on unmount — not on every Vimeo timeupdate,
//     which fires ~4x a second and would hammer the API.
//   * Mark complete at 95%, not 100%. Nobody watches the trailing credits,
//     and a video that can never be completed is worse than one completed a
//     few seconds early.
//
// Completion is sticky server-side, so a re-watch can't undo it.
//
// Structure follows the reference designs:
//
//   sidebar   searchable lesson list, grouped by module, with per-module counts
//   main      the lesson, then Overview / Notes / Resources tabs beneath it
//
// "Lesson" means a video, recording or trainer note — something you work
// THROUGH. Documents and links are supporting material, so they surface in
// the Resources tab rather than as steps in the list. Nobody works through a
// reading list, and mixing them made a five-step module look like eight.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { saveLmsProgress } from "@/lib/api";
import {
  hms, pct, remainingLabel, vimeoEmbedUrl, RESOURCE_LABEL,
  dueLabel, isOverdue, COURSEWORK_CHIP, COURSEWORK_LABEL, submissionLabel,
} from "@/lib/lmsUi";
import { cn } from "@/lib/cn";
import { LessonTabs } from "./LessonTabs";
import type { LmsBatchDetail, LmsResource, ResourceKind } from "@/lib/types";

const HEARTBEAT_MS = 15_000;
const COMPLETE_AT = 0.95;

function KindIcon({ kind, className }: { kind: ResourceKind; className?: string }) {
  const p = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
              strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className };
  if (kind === "video" || kind === "recording")
    return <svg {...p} fill="currentColor" stroke="none"><path d="M8 5v14l11-7z" /></svg>;
  if (kind === "document")
    return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>;
  if (kind === "link")
    return <svg {...p}><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19" /></svg>;
  return <svg {...p}><path d="M4 6h16M4 12h16M4 18h10" /></svg>;
}

// What counts as a lesson — something a learner works through, in order.
const LESSON_KINDS: ResourceKind[] = ["video", "recording", "note"];

export function BatchPlayer({ detail }: { detail: LmsBatchDetail }) {
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get("r");

  const [query, setQuery] = useState("");

  // Lessons are the spine of the sidebar; documents and links hang off the
  // Resources tab instead.
  const lessons = useMemo(
    () => detail.resources.filter((r) => LESSON_KINDS.includes(r.kind)),
    [detail.resources],
  );

  const initial = useMemo(() => {
    if (requested && lessons.some((r) => r.id === requested)) return requested;
    const unfinished = lessons.find((r) => !r.completedAt);
    return unfinished?.id ?? lessons[0]?.id ?? null;
  }, [requested, lessons]);

  const [activeId, setActiveId] = useState<string | null>(initial);
  const active = lessons.find((r) => r.id === activeId) ?? null;

  const [doneIds, setDoneIds] = useState<Set<string>>(
    () => new Set(detail.resources.filter((r) => r.completedAt).map((r) => r.id)),
  );
  const isDone = (id: string) => doneIds.has(id);

  // ─── progress heartbeat ─────────────────────────────────────────────────
  const positionRef = useRef(0);
  const savedRef = useRef(0);
  const activeRef = useRef<LmsResource | null>(null);
  activeRef.current = active;

  const flush = useCallback(async (force = false) => {
    const r = activeRef.current;
    if (!r) return;
    const pos = positionRef.current;
    if (!force && Math.abs(pos - savedRef.current) < 5) return;
    savedRef.current = pos;
    const complete = !!r.durationSeconds && pos / r.durationSeconds >= COMPLETE_AT;
    try {
      await saveLmsProgress(r.id, pos, complete);
      if (complete && !doneIds.has(r.id)) {
        setDoneIds((prev) => new Set(prev).add(r.id));
        router.refresh();
      }
    } catch {
      // Offline or expired session — the next heartbeat retries. Losing a few
      // seconds of position isn't worth interrupting playback for.
    }
  }, [doneIds, router]);

  // Vimeo posts player events to the parent window. We listen rather than
  // pulling in the Player SDK — one script fewer, and we only need time.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (!/player\.vimeo\.com/.test(e.origin)) return;
      try {
        const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
        if (data?.event === "timeupdate" && typeof data?.data?.seconds === "number") {
          positionRef.current = data.data.seconds;
        }
      } catch { /* not ours */ }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    positionRef.current = active?.positionSeconds ?? 0;
    savedRef.current = positionRef.current;
  }, [active?.id, active?.positionSeconds]);

  useEffect(() => {
    const t = setInterval(() => { void flush(); }, HEARTBEAT_MS);
    const onHide = () => { void flush(true); };
    window.addEventListener("pagehide", onHide);
    return () => {
      clearInterval(t);
      window.removeEventListener("pagehide", onHide);
      void flush(true);
    };
  }, [flush]);

  const markComplete = async () => {
    const r = activeRef.current;
    if (!r) return;
    setDoneIds((prev) => new Set(prev).add(r.id));
    try {
      await saveLmsProgress(r.id, r.durationSeconds ?? positionRef.current, true);
      router.refresh();
    } catch { /* optimistic; heartbeat retries */ }
  };

  const requiredTotal = lessons.filter((r) => r.required).length;
  const requiredDone = lessons.filter((r) => r.required && isDone(r.id)).length;

  const activeModule = active ? detail.modules.find((m) => m.id === active.moduleId) : null;

  // The module's assessment, if it has one — what "Quiz me" opens. Submission
  // lives on My work, so this is a jump to the right row there rather than a
  // second quiz UI: one place to answer, one place to see the mark.
  const quiz = active
    ? detail.coursework.find((cw) => cw.moduleId === active.moduleId && cw.type === "assessment") ?? null
    : null;

  return (
    // Sidebar leads on desktop, matching the reference. On a phone it drops
    // BELOW the lesson (order-2): nobody wants to scroll past forty lesson
    // titles to reach the video they tapped.
    <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
      <div className="order-1 min-w-0 space-y-5 lg:order-2">
        {active ? (
          <>
            {/* ── the thing itself ───────────────────────────────────────── */}
            {(active.kind === "video" || active.kind === "recording") && active.videoRef ? (
              <div className="overflow-hidden rounded-2xl bg-black">
                <div className="relative aspect-video">
                  <iframe
                    key={active.id}
                    src={vimeoEmbedUrl(active.videoRef, active.positionSeconds)}
                    title={active.title}
                    className="absolute inset-0 h-full w-full"
                    allow="autoplay; fullscreen; picture-in-picture"
                    allowFullScreen
                  />
                </div>
              </div>
            ) : active.kind === "recording" && active.recordingUrl ? (
              <div className="overflow-hidden rounded-2xl bg-black">
                <video src={active.recordingUrl} controls className="aspect-video w-full" />
              </div>
            ) : active.kind === "note" ? (
              <article className="rounded-2xl border border-black/5 bg-white p-8">
                {/* Notes are markdown-ish. Rendering the raw text in a readable
                    measure beats a half-implemented parser that mangles it. */}
                <div className="whitespace-pre-wrap text-[15px] leading-[1.75] text-ink/85">
                  {active.body}
                </div>
              </article>
            ) : active.kind === "link" && active.externalUrl ? (
              <div className="rounded-2xl border border-black/5 bg-white p-8">
                <p className="font-mono text-[10px] uppercase tracking-wide text-ink/45">External resource</p>
                <p className="mt-2 break-all text-sm text-ink/60">{active.externalUrl}</p>
                <a
                  href={active.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-5 inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white transition hover:bg-ink/90"
                >
                  Open link
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M7 17 17 7M9 7h8v8" />
                  </svg>
                </a>
              </div>
            ) : active.kind === "document" ? (
              <div className="rounded-2xl border border-black/5 bg-white p-8 text-center">
                <p className="font-serif text-xl">Document</p>
                <p className="mx-auto mt-2 max-w-sm text-sm text-ink/55">
                  File storage isn&rsquo;t configured yet, so this document can&rsquo;t be opened.
                  Ask your trainer to share it as a link.
                </p>
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-black/10 bg-white/50 p-10 text-center text-sm text-ink/55">
                This resource has no preview. Ask your trainer if you think that&rsquo;s wrong.
              </div>
            )}

            {/* ── title, provenance, completion ──────────────────────────── */}
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="font-serif text-3xl leading-tight">{active.title}</h2>
                {/* Provenance line from the reference: where this sits, what
                    it is, which batch, who teaches it. */}
                <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink/45">
                  {[
                    activeModule?.title,
                    RESOURCE_LABEL[active.kind],
                    detail.batch.code,
                    detail.batch.trainerName,
                  ].filter(Boolean).join(" · ")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={markComplete}
                  disabled={isDone(active.id)}
                  className={cn(
                    "rounded-full px-5 py-2.5 text-sm font-medium transition",
                    isDone(active.id)
                      ? "cursor-default bg-emerald-100 text-emerald-800"
                      : "bg-ink text-white hover:bg-ink/90",
                  )}
                >
                  {isDone(active.id) ? "✓ Completed" : "Mark complete"}
                </button>

                {quiz ? (
                  <Link
                    href={`/learn/work?item=${encodeURIComponent(quiz.id)}`}
                    title={quiz.title}
                    className="flex items-center gap-1.5 rounded-full border border-black/15 px-5 py-2.5 text-sm font-medium transition hover:bg-black/5"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m12 3 2.6 5.6 6.1.8-4.5 4.2 1.2 6L12 16.8 6.6 19.6l1.2-6L3.3 9.4l6.1-.8z" />
                    </svg>
                    Quiz me
                  </Link>
                ) : (
                  // Shown disabled rather than hidden: the absence is the
                  // useful signal — this module simply has no assessment.
                  <span
                    title="This module has no assessment yet"
                    className="flex cursor-default items-center gap-1.5 rounded-full border border-black/10 px-5 py-2.5 text-sm font-medium text-ink/30"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m12 3 2.6 5.6 6.1.8-4.5 4.2 1.2 6L12 16.8 6.6 19.6l1.2-6L3.3 9.4l6.1-.8z" />
                    </svg>
                    Quiz me
                  </span>
                )}
              </div>
            </div>

            <LessonTabs
              resource={active}
              module={activeModule ?? null}
              batch={detail.batch}
              sessions={detail.sessions}
              attachments={detail.resources.filter(
                (r) => r.moduleId === active.moduleId && !LESSON_KINDS.includes(r.kind),
              )}
              completed={isDone(active.id)}
              positionRef={positionRef}
            />
          </>
        ) : (
          <div className="rounded-2xl border border-dashed border-black/10 bg-white/50 p-10 text-center">
            {detail.modules.length === 0 ? (
              <>
                <h2 className="font-serif text-2xl">No content published yet</h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-ink/55">
                  Your trainer hasn&rsquo;t published any modules for this batch. Check back shortly.
                </p>
              </>
            ) : (
              <>
                <h2 className="font-serif text-2xl">Nothing to open yet</h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-ink/55">
                  {detail.modules.length === 1
                    ? `“${detail.modules[0]!.title}” is published but has no material in it yet.`
                    : "Your modules are published but none of them has any material in it yet."}
                  {" "}Your trainer is still adding to them.
                </p>
              </>
            )}
          </div>
        )}

        {detail.coursework.length > 0 ? (
          <section className="rounded-2xl border border-black/5 bg-white p-6">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink/45">Coursework in this batch</h3>
            <ul className="mt-4 space-y-2">
              {detail.coursework.map((cw) => (
                <li key={cw.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-black/5 p-3">
                  <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg font-mono text-[10px] font-semibold", COURSEWORK_CHIP[cw.type])}>
                    {COURSEWORK_LABEL[cw.type]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{cw.title}</span>
                    <span className="text-sm text-ink/50">{submissionLabel(cw.submissionStatus)}</span>
                  </span>
                  {cw.score != null ? (
                    <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800">
                      {cw.score}{cw.maxScore ? ` / ${cw.maxScore}` : ""}
                    </span>
                  ) : (
                    <span className={cn("rounded-full px-3 py-1 text-xs font-medium",
                      isOverdue(cw.dueAt) && cw.submissionStatus == null
                        ? "bg-rose-100 text-rose-800" : "bg-black/5 text-ink/60")}>
                      {dueLabel(cw.dueAt)}
                    </span>
                  )}
                  <Link href="/learn/work" className="text-sm text-indigo-700 hover:underline">Open</Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {/* ── sidebar: searchable lesson list, grouped by module ────────────── */}
      <aside className="order-2 lg:order-1 lg:sticky lg:top-24 lg:self-start">
        <div className="rounded-2xl border border-black/5 bg-white">
          <div className="border-b border-black/5 p-4">
            <div className="relative">
              <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/35"
                   width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
              </svg>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search lessons"
                className="w-full rounded-lg border border-black/10 py-2 pl-9 pr-3 text-sm outline-none focus:border-indigo-400"
              />
            </div>
            <div className="mt-3 flex items-baseline justify-between">
              <span className="font-mono text-[10px] uppercase tracking-wide text-ink/45">
                {requiredDone} of {requiredTotal} done
              </span>
              <span className="text-sm font-medium text-indigo-700">{pct(requiredDone, requiredTotal)}%</span>
            </div>
            <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-black/10">
              <span className="block h-full rounded-full bg-indigo-500 transition-[width]"
                    style={{ width: `${pct(requiredDone, requiredTotal)}%` }} />
            </span>
          </div>

          <div className="max-h-[34rem] overflow-y-auto p-2">
            {detail.modules.map((m, mi) => {
              const all = lessons.filter((r) => r.moduleId === m.id);
              // Search filters the items but keeps the module heading, so the
              // structure doesn't rearrange itself while you type.
              const items = query.trim()
                ? all.filter((r) => r.title.toLowerCase().includes(query.trim().toLowerCase()))
                : all;
              if (query.trim() && items.length === 0) return null;

              const done = all.filter((r) => r.required && isDone(r.id)).length;
              const total = all.filter((r) => r.required).length;

              return (
                <div key={m.id} className="mb-3">
                  <div className="flex items-baseline justify-between gap-2 px-3 pb-1.5 pt-2">
                    <p className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.1em] text-ink/45">
                      Module {mi + 1} · {m.title}
                    </p>
                    {total > 0 ? (
                      <span className={cn("shrink-0 font-mono text-[10px]",
                        done === total ? "text-emerald-600" : "text-ink/40")}>
                        {done}/{total}
                      </span>
                    ) : null}
                  </div>

                  {items.length === 0 ? (
                    <p className="px-3 py-1.5 text-xs text-ink/40">No lessons yet</p>
                  ) : (
                    <ul>
                      {items.map((r) => {
                        const on = r.id === activeId;
                        const complete = isDone(r.id);
                        return (
                          <li key={r.id}>
                            <button
                              type="button"
                              onClick={() => { void flush(true); setActiveId(r.id); }}
                              className={cn(
                                "flex w-full items-start gap-2.5 border-l-2 py-2 pl-2.5 pr-3 text-left text-sm transition",
                                on
                                  ? "border-indigo-500 bg-indigo-50/70 font-medium text-indigo-900"
                                  : "border-transparent hover:bg-black/[0.04]",
                              )}
                            >
                              <span className={cn(
                                "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full",
                                complete ? "bg-emerald-500 text-white"
                                         : on ? "border border-indigo-300 text-indigo-500"
                                              : "border border-black/15 text-ink/40",
                              )}>
                                {complete
                                  ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                                  : <KindIcon kind={r.kind} />}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block leading-snug">{r.title}</span>
                                <span className="mt-0.5 block font-mono text-[10px] text-ink/40">
                                  {r.durationSeconds
                                    ? (complete ? hms(r.durationSeconds) : (remainingLabel(r) ?? hms(r.durationSeconds)))
                                    : RESOURCE_LABEL[r.kind]}
                                  {!r.required ? " · optional" : ""}
                                </span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}

            {query.trim() && lessons.every((r) => !r.title.toLowerCase().includes(query.trim().toLowerCase())) ? (
              <p className="px-3 py-6 text-center text-sm text-ink/45">
                No lessons match &ldquo;{query.trim()}&rdquo;.
              </p>
            ) : null}
          </div>
        </div>
      </aside>
    </div>
  );
}
