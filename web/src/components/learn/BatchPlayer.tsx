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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { saveLmsProgress } from "@/lib/api";
import { hms, pct, remainingLabel, vimeoEmbedUrl, RESOURCE_LABEL, dueLabel, isOverdue, COURSEWORK_CHIP, COURSEWORK_LABEL, submissionLabel } from "@/lib/lmsUi";
import { cn } from "@/lib/cn";
import type { LmsBatchDetail, LmsResource } from "@/lib/types";

const HEARTBEAT_MS = 15_000;
const COMPLETE_AT = 0.95;

function KindIcon({ kind }: { kind: LmsResource["kind"] }) {
  const common = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (kind === "video" || kind === "recording") return <svg {...common} fill="currentColor" stroke="none"><path d="M8 5v14l11-7z" /></svg>;
  if (kind === "document") return <svg {...common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>;
  if (kind === "link") return <svg {...common}><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19" /></svg>;
  return <svg {...common}><path d="M4 6h16M4 12h16M4 18h10" /></svg>;
}

export function BatchPlayer({ detail }: { detail: LmsBatchDetail }) {
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get("r");

  const playable = useMemo(
    () => detail.resources.filter((r) => r.kind === "video" || r.kind === "recording"),
    [detail.resources],
  );

  // Open the requested resource, else the first unfinished one, else the first.
  const initial = useMemo(() => {
    if (requested && detail.resources.some((r) => r.id === requested)) return requested;
    const unfinished = detail.resources.find((r) => !r.completedAt);
    return unfinished?.id ?? detail.resources[0]?.id ?? null;
  }, [requested, detail.resources]);

  const [activeId, setActiveId] = useState<string | null>(initial);
  const active = detail.resources.find((r) => r.id === activeId) ?? null;

  // Local completion overlay so ticks appear immediately without a refetch.
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
    // Don't spam the API when the position hasn't meaningfully moved.
    if (!force && Math.abs(pos - savedRef.current) < 5) return;
    savedRef.current = pos;
    const complete = !!r.durationSeconds && pos / r.durationSeconds >= COMPLETE_AT;
    try {
      await saveLmsProgress(r.id, pos, complete);
      if (complete && !doneIds.has(r.id)) {
        setDoneIds((prev) => new Set(prev).add(r.id));
        router.refresh();   // pull fresh percentages into the server-rendered header
      }
    } catch {
      // Offline or session expired — the next heartbeat retries. Losing a few
      // seconds of position is not worth interrupting playback for.
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
    } catch { /* optimistic; heartbeat will retry */ }
  };

  const requiredTotal = detail.resources.filter((r) => r.required).length;
  const requiredDone = detail.resources.filter((r) => r.required && isDone(r.id)).length;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="min-w-0 space-y-5">
        {active ? (
          <>
            <div className="overflow-hidden rounded-2xl bg-black">
              {(active.kind === "video" || active.kind === "recording") && active.videoRef ? (
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
              ) : active.kind === "recording" && active.recordingUrl ? (
                <div className="aspect-video">
                  <video src={active.recordingUrl} controls className="h-full w-full" />
                </div>
              ) : active.kind === "note" ? (
                <div className="whitespace-pre-wrap bg-white p-7 text-[15px] leading-relaxed text-ink">
                  {active.body}
                </div>
              ) : active.kind === "link" && active.externalUrl ? (
                <div className="bg-white p-7">
                  <a href={active.externalUrl} target="_blank" rel="noreferrer"
                     className="text-indigo-700 underline underline-offset-2">
                    {active.externalUrl}
                  </a>
                </div>
              ) : (
                <div className="bg-white p-7 text-sm text-ink/55">
                  This resource has no preview. Ask your trainer if you think that&rsquo;s wrong.
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink/45">
                  {RESOURCE_LABEL[active.kind]}
                  {active.durationSeconds ? ` · ${hms(active.durationSeconds)}` : ""}
                  {!active.required ? " · optional" : ""}
                </p>
                <h2 className="mt-1 font-serif text-2xl leading-tight">{active.title}</h2>
              </div>
              <button
                type="button"
                onClick={markComplete}
                disabled={isDone(active.id)}
                className={cn(
                  "shrink-0 rounded-full px-5 py-2.5 text-sm font-medium transition",
                  isDone(active.id)
                    ? "cursor-default bg-emerald-100 text-emerald-800"
                    : "bg-ink text-white hover:bg-ink/90",
                )}
              >
                {isDone(active.id) ? "Completed" : "Mark complete"}
              </button>
            </div>
          </>
        ) : (
          <div className="rounded-2xl border border-dashed border-black/10 bg-white/50 p-10 text-center">
            <h2 className="font-serif text-2xl">No content published yet</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-ink/55">
              Your trainer hasn&rsquo;t published any modules for this batch. Check back shortly.
            </p>
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

      <aside className="lg:sticky lg:top-24 lg:self-start">
        <div className="rounded-2xl border border-black/5 bg-white">
          <div className="border-b border-black/5 p-5">
            <div className="flex items-baseline justify-between">
              <h3 className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink/45">Modules</h3>
              <span className="text-sm font-medium text-indigo-700">{pct(requiredDone, requiredTotal)}%</span>
            </div>
            <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-black/10">
              <span className="block h-full rounded-full bg-indigo-500" style={{ width: `${pct(requiredDone, requiredTotal)}%` }} />
            </span>
            <p className="mt-1.5 text-xs text-ink/45">{requiredDone} of {requiredTotal} required items</p>
          </div>

          <div className="max-h-[32rem] overflow-y-auto p-2">
            {detail.modules.map((m) => {
              const items = detail.resources.filter((r) => r.moduleId === m.id);
              return (
                <div key={m.id} className="mb-2">
                  <p className="px-3 pb-1 pt-3 font-mono text-[10px] uppercase tracking-wide text-ink/45">
                    {m.title}
                  </p>
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
                              "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition",
                              on ? "bg-indigo-50 font-medium text-indigo-900" : "hover:bg-black/5",
                            )}
                          >
                            <span className={cn("grid h-5 w-5 shrink-0 place-items-center rounded-full",
                              complete ? "bg-emerald-500 text-white" : "border border-black/15 text-ink/40")}>
                              {complete
                                ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                                : <KindIcon kind={r.kind} />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">{r.title}</span>
                              {r.durationSeconds ? (
                                <span className="font-mono text-[10px] text-ink/40">
                                  {complete ? hms(r.durationSeconds) : (remainingLabel(r) ?? hms(r.durationSeconds))}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                    {items.length === 0 ? (
                      <li className="px-3 py-2 text-xs text-ink/40">No items yet</li>
                    ) : null}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      </aside>
    </div>
  );
}
