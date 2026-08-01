// My learning — every batch this learner is assigned to.
//
// A batch is the unit of everything: it holds the modules, the lessons, the
// coursework and the live classes, and it is what the CRM, the advisors and
// the trainers all mean by "batch". So the portal says batch too, rather than
// inventing a layer above it that only the portal would know about.
//
// The stats strip answers the three questions people open this page for: how
// far through the calendar am I, how much have I finished, and is my
// attendance going to be a problem.

import Link from "next/link";
import { getLmsBatches } from "@/lib/api";
import { pct, dateRangeLabel } from "@/lib/lmsUi";
import { cn } from "@/lib/cn";
import { batchStatusCls, batchStatusLabel, BATCH_STATUS_PILL } from "@/lib/batchStatus";
import type { LmsBatchSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

const MS_WEEK = 7 * 86_400_000;

/** "Week 6 of 12" from the batch's own calendar. Null when it hasn't got one
 *  yet, or hasn't started — a week counter reading 0 is worse than nothing. */
function week(b: LmsBatchSummary): string | null {
  if (!b.startDate || !b.endDate) return null;
  const start = new Date(b.startDate).getTime();
  const end = new Date(b.endDate).getTime();
  const total = Math.max(1, Math.ceil((end - start + 86_400_000) / MS_WEEK));
  if (b.status === "completed") return `${total} of ${total}`;
  const now = Math.ceil((Date.now() - start + 1) / MS_WEEK);
  if (now < 1) return null;
  return `${Math.min(total, now)} of ${total}`;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink/45">{label}</dt>
      <dd className={cn("mt-0.5 font-medium", tone)}>{value}</dd>
    </div>
  );
}

export default async function MyLearning() {
  const batches = await getLmsBatches().catch(() => []);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-serif text-4xl tracking-tight">My learning</h1>
        <p className="mt-2 max-w-xl text-ink/60">
          Every batch you&rsquo;re assigned to. Each one holds its own modules,
          lessons and coursework.
        </p>
      </header>

      {batches.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-black/10 bg-white/50 p-10 text-center">
          <h2 className="font-serif text-2xl">No batches yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink/55">
            You&rsquo;ll see your batches here as soon as an advisor assigns you to one.
            If you&rsquo;ve just enrolled, that usually happens within a day.
          </p>
        </div>
      ) : (
        <ul className="space-y-4">
          {batches.map((b) => {
            const p = pct(b.resourcesDone, b.resourceCount);
            const done = b.status === "completed";
            const attendance = b.classesHeld
              ? Math.round((b.classesAttended / b.classesHeld) * 100)
              : null;
            const w = week(b);
            // The course name is the human title ("Python & Data Foundations");
            // the batch's own name is often just its code again. Lead with the
            // title and let the code be the chip.
            const title = b.courseName ?? b.name;
            const subtitle = b.courseName && b.name !== b.code ? b.name : null;

            return (
              <li key={b.id} className="rounded-2xl border border-black/5 bg-white p-6">
                <div className="flex flex-wrap items-start justify-between gap-6">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {b.code ? (
                        <span className="rounded border border-black/10 px-2 py-0.5 font-mono text-[11px] text-ink/60">
                          {b.code}
                        </span>
                      ) : null}
                      <span className={cn(BATCH_STATUS_PILL, batchStatusCls(b.status))}>
                        {batchStatusLabel(b.status)}
                      </span>
                    </div>

                    <h2 className="mt-2 font-serif text-3xl leading-tight">{title}</h2>

                    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink/55">
                      {subtitle ? (
                        <>
                          <span>{subtitle}</span>
                          <span aria-hidden className="text-ink/25">·</span>
                        </>
                      ) : null}
                      {b.trainerName ? (
                        <>
                          <span>{b.trainerName}</span>
                          <span aria-hidden className="text-ink/25">·</span>
                        </>
                      ) : null}
                      <span>{dateRangeLabel(b.startDate, b.endDate)}</span>
                      {b.timeLabel ? (
                        <>
                          <span aria-hidden className="text-ink/25">·</span>
                          <span>{b.timeLabel}</span>
                        </>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex w-full shrink-0 flex-col items-end gap-3 sm:w-64">
                    <div className="w-full">
                      <div className="text-right text-4xl font-semibold tabular-nums">{p}%</div>
                      <span className="mt-2 block h-2 overflow-hidden rounded-full bg-black/10">
                        <span
                          className={cn("block h-full rounded-full", done ? "bg-emerald-500" : "bg-indigo-500")}
                          style={{ width: `${p}%` }}
                        />
                      </span>
                      <p className="mt-1.5 text-right text-xs text-ink/50">
                        {b.resourcesDone} of {b.resourceCount} lessons
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {/* The single place the room link lives. A learner opens
                          My learning to get to a class, so it belongs on the
                          card rather than one level deeper. Hidden once the
                          batch is done — there is nothing left to join. */}
                      {b.joinUrl && !done ? (
                        <a
                          href={b.joinUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-full border border-black/15 px-5 py-2.5 text-sm font-medium transition hover:bg-black/5"
                        >
                          Join live class
                        </a>
                      ) : null}
                      <Link
                        href={`/learn/batches/${b.id}`}
                        className={cn(
                          "rounded-full px-6 py-2.5 text-sm font-medium transition",
                          done
                            ? "border border-black/10 hover:bg-black/5"
                            : "bg-ink text-white hover:bg-ink/90",
                        )}
                      >
                        {done ? "Revisit" : p > 0 ? "Continue" : "Open batch"}
                      </Link>
                    </div>
                  </div>
                </div>

                <dl className="mt-5 flex flex-wrap gap-x-12 gap-y-3 border-t border-black/5 pt-4">
                  <Stat label="Week" value={w ?? "—"} />
                  <Stat label="Modules" value={String(b.moduleCount)} />
                  <Stat label="Lessons done" value={`${b.resourcesDone} of ${b.resourceCount}`} />
                  <Stat
                    label="Attendance"
                    value={attendance === null ? "—" : `${attendance}%`}
                    // Below 75% is the line that puts a certificate at risk, so
                    // it stops being a neutral number and starts being a warning.
                    tone={
                      attendance === null ? undefined
                      : attendance >= 75 ? "text-emerald-700"
                      : "text-amber-700"
                    }
                  />
                  {b.sessionCount > 0 ? (
                    <Stat
                      label="Recordings"
                      value={`${b.recordedCount} of ${b.sessionCount}`}
                    />
                  ) : null}
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
