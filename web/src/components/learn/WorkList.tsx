"use client";

// "My work" — every coursework item with its latest submission, plus the
// submit flow.
//
// Submission content is free-form JSON server-side. The UI keeps it to two
// fields (a link and a note) because that covers labs and written work, and
// an empty schema would have meant building a form builder first.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitLmsCoursework } from "@/lib/api";
import { ApiError } from "@/lib/api";
import {
  COURSEWORK_CHIP, COURSEWORK_LABEL, dueLabel, isOverdue, submissionLabel,
} from "@/lib/lmsUi";
import { cn } from "@/lib/cn";
import type { LmsWork, LmsWorkItem } from "@/lib/types";

type Filter = "all" | "due" | "graded";

function scorePct(item: LmsWorkItem): number | null {
  if (item.score == null || item.maxScore == null) return null;
  const max = Number(item.maxScore);
  if (!max) return null;
  return Math.round((Number(item.score) / max) * 100);
}

export function WorkList({ work }: { work: LmsWork }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const counts = useMemo(() => ({
    all: work.items.length,
    due: work.items.filter((i) => i.submissionStatus == null || i.submissionStatus === "draft").length,
    graded: work.items.filter((i) => i.submissionStatus === "graded").length,
  }), [work.items]);

  const items = useMemo(() => work.items.filter((i) =>
    filter === "all" ? true
    : filter === "due" ? (i.submissionStatus == null || i.submissionStatus === "draft")
    : i.submissionStatus === "graded",
  ), [work.items, filter]);

  const submit = (item: LmsWorkItem) => {
    setError(null);
    startTransition(async () => {
      try {
        await submitLmsCoursework(item.id, {
          link: link.trim() || null,
          note: note.trim() || null,
        });
        setOpenId(null); setLink(""); setNote("");
        router.refresh();
      } catch (err) {
        // 409 is the interesting one: window closed, or already graded.
        setError(err instanceof ApiError ? String((err.body as { error?: string })?.error ?? err.message) : "Could not submit");
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-black/5 bg-white p-5">
          <div className="text-3xl font-semibold text-amber-700">{work.stats.dueThisWeek}</div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink/45">Due this week</div>
        </div>
        <div className="rounded-2xl border border-black/5 bg-white p-5">
          <div className="text-3xl font-semibold">{work.stats.graded}</div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink/45">Graded</div>
        </div>
        <div className="rounded-2xl border border-black/5 bg-white p-5">
          <div className="text-3xl font-semibold text-emerald-700">
            {work.stats.averagePct == null ? "—" : `${work.stats.averagePct}%`}
          </div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink/45">Average score</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {(["all", "due", "graded"] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full px-4 py-1.5 text-sm capitalize transition",
              filter === f ? "bg-ink text-white" : "border border-black/10 hover:bg-black/5",
            )}
          >
            {f === "all" ? "Everything" : f}
            <span className={cn("ml-1.5", filter === f ? "text-white/60" : "text-ink/40")}>{counts[f]}</span>
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-black/10 bg-white/50 p-10 text-center text-sm text-ink/50">
          Nothing here.
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => {
            const open = openId === item.id;
            const graded = item.submissionStatus === "graded";
            const submitted = item.submissionStatus != null && item.submissionStatus !== "draft";
            const closed = !!item.closesAt && new Date(item.closesAt).getTime() < Date.now();
            const p = scorePct(item);
            return (
              <li key={item.id} className="rounded-2xl border border-black/5 bg-white p-5">
                <div className="flex flex-wrap items-start gap-4">
                  <span className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl font-mono text-[10px] font-semibold", COURSEWORK_CHIP[item.type])}>
                    {COURSEWORK_LABEL[item.type]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="font-medium leading-snug">{item.title}</h3>
                    <p className="mt-0.5 text-sm text-ink/50">
                      {item.batchName}
                      {item.batchCode ? <span className="font-mono text-xs"> · {item.batchCode}</span> : null}
                      {item.moduleTitle ? ` · ${item.moduleTitle}` : ""}
                    </p>
                    {item.brief && !open ? (
                      <p className="mt-2 line-clamp-2 text-sm text-ink/60">{item.brief}</p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-2">
                    {graded && p != null ? (
                      <span className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800">
                        {item.score} / {item.maxScore} · {p}%
                      </span>
                    ) : (
                      <span className={cn(
                        "rounded-full px-3 py-1 text-xs font-medium",
                        submitted ? "bg-sky-100 text-sky-800"
                        : isOverdue(item.dueAt) ? "bg-rose-100 text-rose-800"
                        : "bg-amber-100 text-amber-900",
                      )}>
                        {submitted ? submissionLabel(item.submissionStatus) : dueLabel(item.dueAt)}
                      </span>
                    )}
                    {!graded && !closed ? (
                      <button
                        type="button"
                        onClick={() => { setOpenId(open ? null : item.id); setError(null); setLink(""); setNote(""); }}
                        className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90"
                      >
                        {open ? "Cancel" : submitted ? "Resubmit" : "Submit"}
                      </button>
                    ) : closed && !submitted ? (
                      <span className="text-xs text-ink/40">Window closed</span>
                    ) : null}
                  </div>
                </div>

                {graded && item.feedback ? (
                  <div className="mt-4 rounded-xl bg-emerald-50 p-4">
                    <p className="font-mono text-[10px] uppercase tracking-wide text-emerald-800">Trainer feedback</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-emerald-950">{item.feedback}</p>
                  </div>
                ) : null}

                {open ? (
                  <div className="mt-4 space-y-3 rounded-xl bg-black/[0.03] p-4">
                    {item.brief ? (
                      <p className="whitespace-pre-wrap text-sm text-ink/70">{item.brief}</p>
                    ) : null}
                    <label className="block">
                      <span className="font-mono text-[10px] uppercase tracking-wide text-ink/45">
                        Link (repo, notebook, doc)
                      </span>
                      <input
                        value={link}
                        onChange={(e) => setLink(e.target.value)}
                        placeholder="https://github.com/…"
                        className="mt-1 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400"
                      />
                    </label>
                    <label className="block">
                      <span className="font-mono text-[10px] uppercase tracking-wide text-ink/45">Notes for your trainer</span>
                      <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        rows={4}
                        className="mt-1 w-full resize-y rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400"
                      />
                    </label>
                    {isOverdue(item.dueAt) ? (
                      <p className="text-xs text-amber-800">
                        This is past its due date — it&rsquo;ll be marked late, but your trainer can still grade it.
                      </p>
                    ) : null}
                    {error ? <p className="text-sm text-rose-700">{error}</p> : null}
                    <button
                      type="button"
                      disabled={pending || (!link.trim() && !note.trim())}
                      onClick={() => submit(item)}
                      className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-40"
                    >
                      {pending ? "Submitting…" : "Submit work"}
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
