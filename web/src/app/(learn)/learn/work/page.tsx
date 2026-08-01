import { getLmsWork } from "@/lib/api";
import { WorkList } from "@/components/learn/WorkList";

export const dynamic = "force-dynamic";

export default async function MyWork({
  searchParams,
}: { searchParams: Promise<{ item?: string }> }) {
  // ?item=<courseworkId> comes from a lesson's "Quiz me". Read here rather
  // than with useSearchParams inside WorkList, which would need the whole
  // route wrapped in a Suspense boundary to keep its rendering mode.
  const [{ item }, work] = await Promise.all([
    searchParams,
    getLmsWork().catch(() => ({
      items: [], stats: { dueThisWeek: 0, graded: 0, averagePct: null },
    })),
  ]);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-serif text-4xl tracking-tight">My work</h1>
        <p className="mt-2 max-w-xl text-ink/60">
          Labs, assignments and assessments across every batch you&rsquo;re in &mdash; with what you scored.
        </p>
      </header>
      <WorkList work={work} focusId={item} />
    </div>
  );
}
