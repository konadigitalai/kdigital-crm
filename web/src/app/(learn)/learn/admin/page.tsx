import Link from "next/link";
import { getLmsAdminBatches } from "@/lib/api";
import { cn } from "@/lib/cn";

export const dynamic = "force-dynamic";

const STATUS_CHIP: Record<string, string> = {
  running: "bg-indigo-100 text-indigo-800",
  upcoming: "bg-sky-100 text-sky-800",
  completed: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-black/10 text-ink/60",
};

export default async function LmsAdminHome({
  searchParams,
}: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const batches = await getLmsAdminBatches(q).catch(() => []);

  const empty = batches.filter((b) => b.moduleCount === 0).length;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink/45">Admin</p>
          <h1 className="mt-1 font-serif text-4xl tracking-tight">Batch content</h1>
          <p className="mt-2 max-w-xl text-ink/60">
            Every batch, and what learners can currently see in it. Modules live inside a batch,
            so each run of a course gets its own material.
          </p>
        </div>
        <Link href="/learn" className="text-sm text-indigo-700 hover:underline">← Learner view</Link>
      </header>

      <form className="flex gap-2" action="/learn/admin">
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search by batch name or code…"
          className="w-full max-w-sm rounded-full border border-black/10 bg-white px-4 py-2 text-sm outline-none focus:border-indigo-400"
        />
        <button type="submit" className="rounded-full border border-black/10 bg-white px-4 py-2 text-sm hover:bg-black/5">
          Search
        </button>
      </form>

      {empty > 0 ? (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {empty} {empty === 1 ? "batch has" : "batches have"} no modules yet — learners assigned to
          {empty === 1 ? " it" : " them"} see an empty portal.
        </p>
      ) : null}

      {batches.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-black/10 bg-white/50 p-10 text-center text-sm text-ink/50">
          No batches found. Batches are created in the CRM under Batches — this screen only manages their content.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-black/5 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/5 text-left font-mono text-[10px] uppercase tracking-wide text-ink/45">
                <th className="px-5 py-3 font-normal">Batch</th>
                <th className="px-5 py-3 font-normal">Status</th>
                <th className="px-5 py-3 text-right font-normal">Learners</th>
                <th className="px-5 py-3 text-right font-normal">Modules</th>
                <th className="px-5 py-3 text-right font-normal">Published</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} className="border-b border-black/5 last:border-0 hover:bg-black/[0.02]">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      {b.code ? (
                        <span className="rounded border border-black/10 px-1.5 py-0.5 font-mono text-[10px] text-ink/60">
                          {b.code}
                        </span>
                      ) : null}
                      <span className="font-medium">{b.name}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-ink/45">
                      {b.courseName ?? "—"}{b.trainerName ? ` · ${b.trainerName}` : ""}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <span className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-medium",
                      STATUS_CHIP[b.status] ?? "bg-black/10 text-ink/60")}>
                      {b.status}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">{b.learnerCount}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{b.moduleCount}</td>
                  <td className={cn("px-5 py-3 text-right tabular-nums",
                    b.moduleCount > 0 && b.publishedCount === 0 ? "text-amber-700" : "")}>
                    {b.publishedCount}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Link href={`/learn/admin/${b.id}`} className="text-indigo-700 hover:underline">
                      Manage →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
