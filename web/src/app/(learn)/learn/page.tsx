import Link from "next/link";
import { getLmsMe, getLmsToday, getLmsBatches } from "@/lib/api";
import {
  clockLabel, dateLabel, dueLabel, hms, pct, remainingLabel,
  COURSEWORK_CHIP, COURSEWORK_LABEL,
} from "@/lib/lmsUi";
import { cn } from "@/lib/cn";

export const dynamic = "force-dynamic";

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

/** One sentence describing the day, so the header says something useful
 *  rather than a generic welcome. Built from counts we already have. */
function summaryLine(batches: number, due: number, classes: number): string {
  const bits: string[] = [];
  if (batches > 0) bits.push(batches === 1 ? "You're on one programme" : `You're running ${batches} programmes side by side`);
  if (due > 0) bits.push(due === 1 ? "one thing is due this week" : `${due} things are due this week`);
  if (classes > 0) bits.push(classes === 1 ? "and you have a class coming up" : "and you have classes coming up");
  if (!bits.length) return "Nothing scheduled right now. Enjoy the quiet.";
  return bits.join(", ").replace(/^./, (m) => m.toUpperCase()) + ".";
}

export default async function LearnToday() {
  const [me, today, batches] = await Promise.all([
    getLmsMe().catch(() => null),
    getLmsToday().catch(() => ({ nextClasses: [], dueSoon: [], resume: [] })),
    getLmsBatches().catch(() => []),
  ]);

  const first = me?.name?.split(" ")[0] ?? "there";
  const next = today.nextClasses[0];
  const active = batches.filter((b) => b.status !== "completed" && b.status !== "cancelled");
  const completed = batches.filter((b) => b.status === "completed");

  return (
    <div className="space-y-8">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink/45">
          {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
        </p>
        <h1 className="mt-2 font-serif text-4xl tracking-tight">
          {greeting()}, {first}.
        </h1>
        <p className="mt-2 max-w-2xl text-ink/60">
          {summaryLine(active.length, today.dueSoon.length, today.nextClasses.length)}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {next ? (
            <section className="overflow-hidden rounded-2xl bg-gradient-to-br from-[#221c2e] to-[#3b2a52] p-7 text-white">
              <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/55">
                Your next live class · {dateLabel(next.sessionDate)}
              </p>
              <h2 className="mt-3 font-serif text-3xl leading-tight">
                {next.batchName}
                {next.trainerName ? <span className="text-white/70"> with {next.trainerName}</span> : null}
              </h2>
              <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-white/70">
                {next.batchCode ? (
                  <span className="rounded border border-white/20 px-2 py-0.5 font-mono text-xs">{next.batchCode}</span>
                ) : null}
                <span>
                  {clockLabel(next.startTime)}
                  {next.endTime ? `–${clockLabel(next.endTime)}` : ""} IST
                </span>
              </div>
              <div className="mt-6 flex flex-wrap gap-3">
                {next.joinUrl ? (
                  <a
                    href={next.joinUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-full bg-white px-5 py-2.5 text-sm font-medium text-ink transition hover:bg-white/90"
                  >
                    Join at {clockLabel(next.startTime)}
                  </a>
                ) : (
                  <span className="rounded-full bg-white/10 px-5 py-2.5 text-sm text-white/60">
                    Join link not published yet
                  </span>
                )}
                <Link
                  href="/learn/schedule"
                  className="rounded-full border border-white/25 px-5 py-2.5 text-sm transition hover:bg-white/10"
                >
                  Full schedule
                </Link>
              </div>
            </section>
          ) : (
            <section className="rounded-2xl border border-black/5 bg-white p-7">
              <h2 className="font-serif text-2xl">No classes scheduled</h2>
              <p className="mt-2 text-sm text-ink/55">
                Once your trainer publishes the timetable, your next class shows up here.
              </p>
            </section>
          )}

          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink/45">Due this week</h2>
              <Link href="/learn/work" className="text-sm text-indigo-700 hover:underline">All work →</Link>
            </div>
            {today.dueSoon.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-black/10 bg-white/50 p-6 text-sm text-ink/50">
                Nothing due in the next seven days.
              </p>
            ) : (
              <ul className="space-y-2">
                {today.dueSoon.map((d) => (
                  <li key={d.id}>
                    <Link
                      href="/learn/work"
                      className="flex items-center gap-4 rounded-2xl border border-black/5 bg-white p-4 transition hover:border-black/15"
                    >
                      <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-xl font-mono text-[10px] font-semibold", COURSEWORK_CHIP[d.type])}>
                        {COURSEWORK_LABEL[d.type]}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{d.title}</span>
                        <span className="block truncate text-sm text-ink/50">
                          {d.batchName}{d.moduleTitle ? ` · ${d.moduleTitle}` : ""}
                        </span>
                      </span>
                      <span className="shrink-0 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900">
                        {dueLabel(d.dueAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {today.resume.length > 0 ? (
            <section>
              <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[0.12em] text-ink/45">
                Pick up where you left off
              </h2>
              <ul className="space-y-2">
                {today.resume.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/learn/batches/${r.cohortId}?r=${r.id}`}
                      className="flex items-center gap-4 rounded-2xl border border-black/5 bg-white p-4 transition hover:border-black/15"
                    >
                      <span className="grid h-14 w-24 shrink-0 place-items-center rounded-xl bg-ink text-white">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-mono text-[10px] uppercase tracking-wide text-ink/45">
                          {r.batchName} · {r.moduleTitle}
                        </span>
                        <span className="mt-0.5 block truncate font-medium">{r.title}</span>
                        {r.durationSeconds ? (
                          <span className="mt-2 flex items-center gap-2">
                            <span className="h-1 w-40 overflow-hidden rounded-full bg-black/10">
                              <span
                                className="block h-full rounded-full bg-indigo-500"
                                style={{ width: `${pct(r.positionSeconds, r.durationSeconds)}%` }}
                              />
                            </span>
                            <span className="font-mono text-[11px] text-ink/45">
                              {remainingLabel({ durationSeconds: r.durationSeconds, positionSeconds: r.positionSeconds }) ?? hms(r.durationSeconds)}
                            </span>
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 rounded-full bg-ink px-4 py-2 text-sm font-medium text-white">Resume</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <aside className="space-y-6">
          <section className="rounded-2xl border border-black/5 bg-white p-5">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink/45">Enrolled</h2>
            <p className="mt-3 text-3xl font-semibold">
              {active.length}
              <span className="ml-2 text-base font-normal text-ink/55">
                active{completed.length ? ` · ${completed.length} completed` : ""}
              </span>
            </p>
            <Link href="/learn/batches" className="mt-3 inline-block text-sm text-indigo-700 hover:underline">
              See all programmes →
            </Link>
          </section>

          {today.nextClasses.length > 0 ? (
            <section className="rounded-2xl border border-black/5 bg-white p-5">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink/45">Next live classes</h2>
              <ul className="mt-4 space-y-4">
                {today.nextClasses.map((c) => (
                  <li key={c.id} className="border-l-2 border-indigo-400 pl-3">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-sm">{clockLabel(c.startTime)}</span>
                      <span className="text-xs text-ink/45">{dateLabel(c.sessionDate)}</span>
                    </div>
                    <div className="mt-0.5 font-medium leading-snug">{c.batchName}</div>
                    <div className="text-xs text-ink/50">
                      {c.batchCode ? <span className="font-mono">{c.batchCode}</span> : null}
                      {c.trainerName ? ` · ${c.trainerName}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {active.length > 0 ? (
            <section className="rounded-2xl border border-black/5 bg-white p-5">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink/45">Your programmes</h2>
              <ul className="mt-4 space-y-4">
                {active.map((b) => {
                  const p = pct(b.resourcesDone, b.resourceCount);
                  return (
                    <li key={b.id}>
                      <Link href={`/learn/batches/${b.id}`} className="group block">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="truncate font-medium group-hover:underline">{b.name}</span>
                          <span className="shrink-0 text-sm font-medium text-indigo-700">{p}%</span>
                        </div>
                        <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-black/10">
                          <span className="block h-full rounded-full bg-indigo-500" style={{ width: `${p}%` }} />
                        </span>
                        <span className="mt-1 block text-xs text-ink/45">
                          {b.resourcesDone} of {b.resourceCount} items done
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          <section className="rounded-2xl border border-black/5 bg-white p-5">
            <h2 className="font-medium">Stuck on something?</h2>
            <p className="mt-2 text-sm text-ink/55">
              Ask your trainer, or raise a request and an advisor replies within a day.
            </p>
            <Link
              href="/learn/help"
              className="mt-4 inline-block rounded-full border border-black/10 px-4 py-2 text-sm transition hover:bg-black/5"
            >
              Get help
            </Link>
          </section>
        </aside>
      </div>
    </div>
  );
}
