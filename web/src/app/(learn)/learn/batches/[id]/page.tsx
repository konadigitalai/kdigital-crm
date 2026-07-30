import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getLmsBatch } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { BatchPlayer } from "@/components/learn/BatchPlayer";

export const dynamic = "force-dynamic";

export default async function BatchDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // The API returns 404 for a batch this learner isn't assigned to — the same
  // response as one that doesn't exist, so ids can't be probed. Render the
  // normal not-found page either way.
  const detail = await getLmsBatch(id).catch((err) => {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  });
  if (!detail) notFound();

  const { batch } = detail;

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-2 text-sm text-ink/50">
        <Link href="/learn/batches" className="hover:underline">My learning</Link>
        <span aria-hidden>/</span>
        <span className="text-ink/70">{batch.name}</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {batch.code ? (
              <span className="rounded border border-black/10 px-2 py-0.5 font-mono text-[11px] text-ink/60">
                {batch.code}
              </span>
            ) : null}
            {batch.courseName ? <span className="text-sm text-ink/55">{batch.courseName}</span> : null}
          </div>
          <h1 className="mt-2 font-serif text-4xl tracking-tight">{batch.name}</h1>
          {batch.trainerName ? (
            <p className="mt-1 text-sm text-ink/55">Trainer · {batch.trainerName}</p>
          ) : null}
        </div>
        {batch.joinUrl ? (
          <a
            href={batch.joinUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white transition hover:bg-ink/90"
          >
            Join live class
          </a>
        ) : null}
      </header>

      {/* useSearchParams inside BatchPlayer needs a Suspense boundary or the
          whole route opts out of static rendering with a build-time warning. */}
      <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-black/5" />}>
        <BatchPlayer detail={detail} />
      </Suspense>
    </div>
  );
}
