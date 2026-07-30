import Link from "next/link";
import { getLmsSchedule } from "@/lib/api";
import { clockLabel, COURSEWORK_CHIP, COURSEWORK_LABEL, isOverdue } from "@/lib/lmsUi";
import { cn } from "@/lib/cn";

export const dynamic = "force-dynamic";

type Entry =
  | { kind: "class"; at: Date; id: string; title: string; batchName: string; batchCode: string | null;
      trainerName: string | null; joinUrl: string | null; startTime: string | null; endTime: string | null }
  | { kind: "deadline"; at: Date; id: string; title: string; batchName: string; batchCode: string | null;
      type: "lab" | "assignment" | "assessment"; submitted: boolean };

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayHeading(key: string): string {
  const d = new Date(key + "T00:00:00");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  const label = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }).toUpperCase();
  if (diff === 0) return `TODAY · ${label}`;
  if (diff === 1) return `TOMORROW · ${label}`;
  return label;
}

export default async function Schedule() {
  const { classes, deadlines } = await getLmsSchedule(21).catch(() => ({ classes: [], deadlines: [] }));

  // Classes and deadlines are two different shapes on the API but one list to
  // a learner — merge, then group by day.
  const entries: Entry[] = [
    ...classes.map((c): Entry => ({
      kind: "class",
      at: new Date(`${c.sessionDate}T${c.startTime ?? "00:00:00"}`),
      id: c.id, title: c.batchName, batchName: c.batchName, batchCode: c.batchCode,
      trainerName: c.trainerName, joinUrl: c.joinUrl, startTime: c.startTime, endTime: c.endTime,
    })),
    ...deadlines.filter((d) => d.dueAt).map((d): Entry => ({
      kind: "deadline",
      at: new Date(d.dueAt as string),
      id: d.id, title: d.title, batchName: d.batchName, batchCode: d.batchCode,
      type: d.type, submitted: d.submissionStatus != null && d.submissionStatus !== "draft",
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  const days = new Map<string, Entry[]>();
  for (const e of entries) {
    const k = dayKey(e.at);
    days.set(k, [...(days.get(k) ?? []), e]);
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-serif text-4xl tracking-tight">Schedule</h1>
        <p className="mt-2 max-w-xl text-ink/60">
          Live classes and deadlines across every batch you&rsquo;re in, for the next three weeks. Times are IST.
        </p>
      </header>

      {days.size === 0 ? (
        <div className="rounded-2xl border border-dashed border-black/10 bg-white/50 p-10 text-center">
          <h2 className="font-serif text-2xl">Nothing scheduled</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink/55">
            No classes or deadlines in the next three weeks.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {[...days.entries()].map(([key, items]) => (
            <section key={key}>
              <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[0.12em] text-indigo-700">
                {dayHeading(key)}
              </h2>
              <ul className="space-y-2">
                {items.map((e) => (
                  <li
                    key={`${e.kind}-${e.id}`}
                    className="flex flex-wrap items-center gap-4 rounded-2xl border border-black/5 bg-white p-4"
                  >
                    <div className="w-20 shrink-0">
                      <div className="font-mono text-sm">
                        {e.kind === "class"
                          ? clockLabel(e.startTime)
                          : e.at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      </div>
                      <div className="font-mono text-[10px] uppercase text-ink/40">
                        {e.kind === "class" ? "90 min" : "deadline"}
                      </div>
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {e.kind === "deadline" ? (
                          <span className={cn("rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold", COURSEWORK_CHIP[e.type])}>
                            {COURSEWORK_LABEL[e.type]}
                          </span>
                        ) : null}
                        <span className="truncate font-medium">{e.title}</span>
                      </div>
                      <div className="mt-0.5 truncate text-sm text-ink/50">
                        {e.batchCode ? <span className="font-mono text-xs">{e.batchCode}</span> : null}
                        {e.batchCode ? " · " : ""}
                        {e.batchName}
                        {e.kind === "class" && e.trainerName ? ` · ${e.trainerName}` : ""}
                      </div>
                    </div>

                    <div className="shrink-0">
                      {e.kind === "class" ? (
                        e.joinUrl ? (
                          <a href={e.joinUrl} target="_blank" rel="noreferrer"
                             className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90">
                            Join class
                          </a>
                        ) : (
                          <span className="rounded-full bg-indigo-100 px-3 py-1.5 text-xs font-medium text-indigo-800">
                            Live class
                          </span>
                        )
                      ) : e.submitted ? (
                        <span className="rounded-full bg-emerald-100 px-3 py-1.5 text-xs font-medium text-emerald-800">
                          Submitted
                        </span>
                      ) : (
                        <Link
                          href="/learn/work"
                          className={cn(
                            "rounded-full px-4 py-2 text-sm font-medium transition",
                            isOverdue(e.at.toISOString())
                              ? "bg-rose-100 text-rose-800 hover:bg-rose-200"
                              : "border border-black/10 hover:bg-black/5",
                          )}
                        >
                          Submit in My work
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
