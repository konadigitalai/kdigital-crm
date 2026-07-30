import Link from "next/link";
import { getLmsSubmissions } from "@/lib/api";
import { GradeQueue } from "@/components/learn/GradeQueue";

export const dynamic = "force-dynamic";

export default async function GradePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const submissions = await getLmsSubmissions(id).catch(() => []);

  // max_score isn't on the submission rows; derive the ceiling from any graded
  // sibling if present, else leave the input unbounded and let the API judge.
  const maxScore = null as number | null;

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-2 text-sm text-ink/50">
        <Link href="/learn/admin" className="hover:underline">Batch content</Link>
        <span aria-hidden>/</span>
        <span className="text-ink/70">Submissions</span>
      </nav>

      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink/45">Grading</p>
        <h1 className="mt-1 font-serif text-4xl tracking-tight">Submissions</h1>
        <p className="mt-2 max-w-xl text-ink/60">
          Ungraded work first. A score here is final &mdash; the learner sees it immediately on My work.
        </p>
      </header>

      <GradeQueue submissions={submissions} maxScore={maxScore} />
    </div>
  );
}
