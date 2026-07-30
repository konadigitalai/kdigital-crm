import Link from "next/link";
import { getLmsBatches } from "@/lib/api";
import { pct } from "@/lib/lmsUi";
import { cn } from "@/lib/cn";
import { batchStatusCls, batchStatusLabel, BATCH_STATUS_PILL } from "@/lib/batchStatus";

export const dynamic = "force-dynamic";

function range(start: string | null, end: string | null): string {
  const f = (s: string) => new Date(s).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  if (start && end) return `${f(start)} – ${f(end)}`;
  if (start) return `From ${f(start)}`;
  if (end) return `Until ${f(end)}`;
  return "Dates to be confirmed";
}

export default async function MyLearning() {
  const batches = await getLmsBatches().catch(() => []);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-serif text-4xl tracking-tight">My learning</h1>
        <p className="mt-2 max-w-xl text-ink/60">
          Every batch you&rsquo;re assigned to. Each one holds its own modules, videos and coursework.
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
            return (
              <li key={b.id} className="rounded-2xl border border-black/5 bg-white p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
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
                    <h2 className="mt-2 font-serif text-2xl leading-tight">{b.name}</h2>
                    <p className="mt-1 text-sm text-ink/55">
                      {b.courseName ? `${b.courseName} · ` : ""}{range(b.startDate, b.endDate)}
                      {b.trainerName ? ` · ${b.trainerName}` : ""}
                    </p>
                  </div>

                  <div className="w-full max-w-xs shrink-0 sm:w-64">
                    <div className="flex items-baseline justify-end gap-2">
                      <span className="text-3xl font-semibold">{p}%</span>
                    </div>
                    <span className="mt-2 block h-2 overflow-hidden rounded-full bg-black/10">
                      <span
                        className={cn("block h-full rounded-full", done ? "bg-emerald-500" : "bg-indigo-500")}
                        style={{ width: `${p}%` }}
                      />
                    </span>
                    <p className="mt-1.5 text-right text-xs text-ink/50">
                      {b.resourcesDone} of {b.resourceCount} items
                    </p>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-black/5 pt-4">
                  <dl className="flex flex-wrap gap-8">
                    <div>
                      <dt className="font-mono text-[10px] uppercase tracking-wide text-ink/45">Modules</dt>
                      <dd className="mt-0.5 font-medium">{b.moduleCount}</dd>
                    </div>
                    <div>
                      <dt className="font-mono text-[10px] uppercase tracking-wide text-ink/45">Items done</dt>
                      <dd className="mt-0.5 font-medium">{b.resourcesDone} of {b.resourceCount}</dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap items-center gap-2">
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
                        "rounded-full px-5 py-2.5 text-sm font-medium transition",
                        done ? "border border-black/10 hover:bg-black/5" : "bg-ink text-white hover:bg-ink/90",
                      )}
                    >
                      {done ? "Review batch" : "Open batch"}
                    </Link>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
