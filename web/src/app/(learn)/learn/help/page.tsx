import Link from "next/link";
import { getLmsBatches, getLmsMe } from "@/lib/api";

export const dynamic = "force-dynamic";

// Help is intentionally three routes rather than a chat widget: a technical
// doubt, a scheduling/fees question, and anything needing a record. Each goes
// somewhere a person actually reads.
//
// "Raise a request" links into the CRM's existing case system rather than
// inventing a second ticket store — but a learner holds no cases.* permission,
// so the link is a mailto until the case-intake endpoint accepts
// lms.requests.write.self. Tracked, not forgotten.

export default async function Help() {
  const [me, batches] = await Promise.all([
    getLmsMe().catch(() => null),
    getLmsBatches().catch(() => []),
  ]);
  const trainers = [...new Set(batches.map((b) => b.trainerName).filter(Boolean))] as string[];

  const subject = encodeURIComponent(`[Academy] Request from ${me?.learnerNumber ?? me?.name ?? "learner"}`);
  const body = encodeURIComponent(
    `Learner: ${me?.name ?? ""} (${me?.learnerNumber ?? ""})\n` +
    `Batches: ${batches.map((b) => b.code ?? b.name).join(", ") || "—"}\n\n` +
    `What do you need help with?\n\n`,
  );

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-serif text-4xl tracking-tight">Help</h1>
        <p className="mt-2 max-w-xl text-ink/60">
          Three ways to get unstuck. Pick whichever fits &mdash; a person answers every one of them.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <section className="rounded-2xl border border-black/5 bg-white p-6">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-100 font-mono text-sm font-semibold text-indigo-800">1</span>
          <h2 className="mt-4 font-medium">Ask your trainer</h2>
          <p className="mt-2 text-sm text-ink/55">
            {trainers.length
              ? `${trainers.join(" and ")} ${trainers.length > 1 ? "run" : "runs"} your batches. Fastest for a technical doubt.`
              : "Your trainer is the fastest route for a technical doubt."}
          </p>
          <p className="mt-4 font-mono text-[10px] uppercase tracking-wide text-ink/40">Usually &lt; 2h</p>
        </section>

        <section className="rounded-2xl border border-black/5 bg-white p-6">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-100 font-mono text-sm font-semibold text-emerald-800">2</span>
          <h2 className="mt-4 font-medium">Book your advisor</h2>
          <p className="mt-2 text-sm text-ink/55">
            For pace, fees or deadlines. Your advisor can move a deadline or transfer you between batches.
          </p>
          <p className="mt-4 font-mono text-[10px] uppercase tracking-wide text-ink/40">Reply in 1 day</p>
        </section>

        <section className="rounded-2xl border border-black/5 bg-white p-6">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-amber-100 font-mono text-sm font-semibold text-amber-800">3</span>
          <h2 className="mt-4 font-medium">Raise a request</h2>
          <p className="mt-2 text-sm text-ink/55">
            Certificates, batch transfers, invoices &mdash; anything that needs a record.
          </p>
          <a
            href={`mailto:support@kdigital.ai?subject=${subject}&body=${body}`}
            className="mt-4 inline-block rounded-full bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90"
          >
            New request
          </a>
        </section>
      </div>

      <section className="rounded-2xl border border-black/5 bg-white p-6">
        <h2 className="font-serif text-2xl">Common questions</h2>
        <dl className="mt-5 space-y-5">
          <div>
            <dt className="font-medium">Can I be in more than one batch at once?</dt>
            <dd className="mt-1 text-sm text-ink/60">
              Yes. You&rsquo;re currently in {batches.length === 0 ? "none" : batches.length === 1 ? "one" : batches.length}.
              Each keeps its own modules, coursework and progress. Today, Schedule and My work combine across them.
            </dd>
          </div>
          <div>
            <dt className="font-medium">What is a batch code and why does every batch have one?</dt>
            <dd className="mt-1 text-sm text-ink/60">
              Each batch runs with its own trainer, timetable and cohort. The code identifies it exactly &mdash;
              quote it whenever you raise a request.
            </dd>
          </div>
          <div>
            <dt className="font-medium">My progress bar didn&rsquo;t move after I watched a video.</dt>
            <dd className="mt-1 text-sm text-ink/60">
              Progress saves every 15 seconds and when you leave the page, and a video counts as complete at 95%.
              If it&rsquo;s still wrong, use &ldquo;Mark complete&rdquo; on the video &mdash; that always sticks.
            </dd>
          </div>
          <div>
            <dt className="font-medium">I missed a deadline. What happens?</dt>
            <dd className="mt-1 text-sm text-ink/60">
              You can still submit &mdash; it&rsquo;s flagged late and your trainer decides. Once the window
              closes, submission stops and you&rsquo;ll need your advisor to reopen it.
            </dd>
          </div>
        </dl>
      </section>

      <p className="text-sm text-ink/45">
        <Link href="/learn" className="hover:underline">← Back to Today</Link>
      </p>
    </div>
  );
}
