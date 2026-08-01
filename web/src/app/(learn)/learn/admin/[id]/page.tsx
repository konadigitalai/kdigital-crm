import Link from "next/link";
import { notFound } from "next/navigation";
import { getLmsAdminBatches, getLmsAdminContent } from "@/lib/api";
import { ContentEditor } from "@/components/learn/ContentEditor";

export const dynamic = "force-dynamic";

export default async function ManageBatch({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // There's no single-batch admin endpoint — the list is small and already
  // carries the counts, so filtering it avoids a route we'd only call once.
  const [batches, content] = await Promise.all([
    getLmsAdminBatches().catch(() => []),
    getLmsAdminContent(id).catch(() => ({ modules: [], resources: [], coursework: [] })),
  ]);
  const batch = batches.find((b) => b.id === id);
  if (!batch) notFound();

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-2 text-sm text-ink/50">
        <Link href="/learn/admin" className="hover:underline">Batch content</Link>
        <span aria-hidden>/</span>
        <span className="text-ink/70">{batch.name}</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {batch.code ? (
              <span className="rounded border border-black/10 px-2 py-0.5 font-mono text-[11px] text-ink/60">
                {batch.code}
              </span>
            ) : null}
            <span className="text-sm text-ink/55">{batch.courseName ?? "—"}</span>
            {batch.programmeName ? (
              <Link
                href={`/learn/admin?programme=${encodeURIComponent(batch.programmeId!)}`}
                className="text-sm text-indigo-700 hover:underline"
              >
                {batch.programmeCode ? `${batch.programmeCode} · ` : ""}{batch.programmeName}
              </Link>
            ) : null}
          </div>
          <h1 className="mt-2 font-serif text-4xl tracking-tight">{batch.name}</h1>
          <p className="mt-1 text-sm text-ink/55">
            {batch.learnerCount} {batch.learnerCount === 1 ? "learner" : "learners"} assigned
            {batch.trainerName ? ` · ${batch.trainerName}` : ""}
          </p>
          {batch.programmeCount && batch.programmeCount > 1 ? (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              This batch&rsquo;s course sits in {batch.programmeCount} programmes — content edited
              here is what learners on all of them see.
            </p>
          ) : null}
        </div>
      </header>

      <ContentEditor batch={batch} content={content} />
    </div>
  );
}
