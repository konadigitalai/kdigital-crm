"use client";

// Grading queue for one coursework item.
//
// Ungraded first — a trainer opening this screen wants the work waiting on
// them, not an alphabetical roster. The score input is bounded by max_score
// client-side as a courtesy; the API enforces it regardless, because a
// mistyped 900/100 would skew every average on the learner's My work page.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { gradeLmsSubmission, ApiError } from "@/lib/api";
import { submissionLabel } from "@/lib/lmsUi";
import { cn } from "@/lib/cn";
import type { LmsSubmissionRow } from "@/lib/types";

const ORDER: Record<string, number> = { submitted: 0, late: 1, returned: 2, draft: 3, graded: 4 };

export function GradeQueue({
  submissions, maxScore,
}: { submissions: LmsSubmissionRow[]; maxScore: number | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { score: string; feedback: string }>>({});

  const rows = useMemo(
    () => [...submissions].sort((a, b) =>
      (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) ||
      (a.learnerName ?? "").localeCompare(b.learnerName ?? "")),
    [submissions],
  );

  const pendingCount = rows.filter((r) => r.status === "submitted" || r.status === "late").length;

  const save = (row: LmsSubmissionRow) => {
    const d = drafts[row.id] ?? { score: row.score ?? "", feedback: row.feedback ?? "" };
    const score = Number(d.score);
    if (!d.score.trim() || !Number.isFinite(score)) { setError("Enter a score"); return; }
    if (maxScore != null && score > maxScore) { setError(`Score cannot exceed ${maxScore}`); return; }
    setError(null);
    start(async () => {
      try {
        await gradeLmsSubmission(row.id, { score, feedback: d.feedback.trim() || null });
        router.refresh();
      } catch (err) {
        setError(err instanceof ApiError
          ? String((err.body as { error?: string })?.error ?? err.message)
          : "Could not save the grade");
      }
    });
  };

  if (rows.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-black/10 bg-white/50 p-10 text-center text-sm text-ink/50">
        Nobody has submitted this yet.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error ? <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</p> : null}
      <p className="text-sm text-ink/55">
        {pendingCount === 0 ? "Everything here is graded." : `${pendingCount} awaiting a grade.`}
      </p>

      <ul className="space-y-3">
        {rows.map((r) => {
          const d = drafts[r.id] ?? { score: r.score ?? "", feedback: r.feedback ?? "" };
          const content = r.content as { link?: string | null; note?: string | null };
          const done = r.status === "graded";
          return (
            <li key={r.id} className="rounded-2xl border border-black/5 bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-medium">{r.learnerName ?? r.learnerEmail ?? "Unknown learner"}</h3>
                  <p className="mt-0.5 text-xs text-ink/45">
                    {r.learnerNumber ? <span className="font-mono">{r.learnerNumber}</span> : null}
                    {r.learnerNumber ? " · " : ""}
                    {r.submittedAt ? `submitted ${new Date(r.submittedAt).toLocaleString()}` : "not submitted"}
                    {r.attempt > 1 ? ` · attempt ${r.attempt}` : ""}
                  </p>
                </div>
                <span className={cn("rounded-full px-3 py-1 text-xs font-medium",
                  done ? "bg-emerald-100 text-emerald-800"
                  : r.status === "late" ? "bg-amber-100 text-amber-900"
                  : "bg-sky-100 text-sky-800")}>
                  {submissionLabel(r.status)}
                </span>
              </div>

              {content?.link || content?.note ? (
                <div className="mt-3 space-y-2 rounded-xl bg-black/[0.03] p-3 text-sm">
                  {content.link ? (
                    <a href={content.link} target="_blank" rel="noreferrer"
                       className="block truncate text-indigo-700 underline underline-offset-2">
                      {content.link}
                    </a>
                  ) : null}
                  {content.note ? <p className="whitespace-pre-wrap text-ink/75">{content.note}</p> : null}
                </div>
              ) : (
                <p className="mt-3 text-sm text-ink/40">No content submitted.</p>
              )}

              <div className="mt-4 flex flex-wrap items-end gap-3">
                <label className="block">
                  <span className="text-xs text-ink/50">Score{maxScore != null ? ` / ${maxScore}` : ""}</span>
                  <input
                    value={d.score}
                    inputMode="decimal"
                    onChange={(e) => setDrafts((p) => ({ ...p, [r.id]: { ...d, score: e.target.value } }))}
                    className="mt-1 w-28 rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-indigo-400"
                  />
                </label>
                <label className="block flex-1 min-w-[14rem]">
                  <span className="text-xs text-ink/50">Feedback</span>
                  <input
                    value={d.feedback}
                    onChange={(e) => setDrafts((p) => ({ ...p, [r.id]: { ...d, feedback: e.target.value } }))}
                    placeholder="What was good, what to fix"
                    className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-indigo-400"
                  />
                </label>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => save(r)}
                  className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-40"
                >
                  {done ? "Update grade" : "Save grade"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
