import Link from "next/link";
import { getLmsAdminBatches, getLmsAdminProgrammes } from "@/lib/api";
import { cn } from "@/lib/cn";
import { shortRangeLabel } from "@/lib/lmsUi";
import { batchStatusCls, batchStatusLabel, BATCH_STATUS_PILL } from "@/lib/batchStatus";

export const dynamic = "force-dynamic";

// Batch content, filterable by programme.
//
// A batch is the unit of authoring — modules hang off it — and it is what the
// learner portal shows too, so this stays a batch table.
//
// The programme filter is an ADMIN convenience only, not a level learners
// ever see. Batches are sold in programmes from the CRM catalog, and "show me
// everything under PRG-11 so I can see what still has no content" is a
// question an admin arrives with and a learner never does.

export default async function LmsAdminHome({
  searchParams,
}: { searchParams: Promise<{ q?: string; programme?: string }> }) {
  const { q, programme } = await searchParams;

  const [batches, programmes] = await Promise.all([
    getLmsAdminBatches(q, programme).catch(() => []),
    getLmsAdminProgrammes().catch(() => []),
  ]);

  const empty = batches.filter((b) => b.moduleCount === 0).length;
  const unpublished = batches.filter((b) => b.moduleCount > 0 && b.publishedCount === 0).length;
  const selected = programmes.find((p) => p.id === programme) ?? null;
  const filtered = !!q || !!programme;

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

      <form className="flex flex-wrap items-center gap-2" action="/learn/admin">
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search by batch name or code…"
          className="w-full max-w-sm rounded-full border border-black/10 bg-white px-4 py-2 text-sm outline-none focus:border-indigo-400"
        />
        <select
          name="programme"
          defaultValue={programme ?? ""}
          className="rounded-full border border-black/10 bg-white px-4 py-2 text-sm outline-none focus:border-indigo-400"
        >
          <option value="">All programmes</option>
          {programmes.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code ? `${p.code} · ` : ""}{p.name} ({p.courseCount})
            </option>
          ))}
        </select>
        <button type="submit" className="rounded-full border border-black/10 bg-white px-4 py-2 text-sm hover:bg-black/5">
          Apply
        </button>
        {filtered ? (
          <Link href="/learn/admin" className="px-2 text-sm text-ink/50 hover:text-ink/80">
            Clear
          </Link>
        ) : null}
      </form>

      {selected ? (
        <div className="rounded-2xl border border-black/5 bg-white p-5">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink/45">
              {selected.code ?? "Programme"}
            </span>
            <h2 className="font-serif text-2xl leading-tight">{selected.name}</h2>
          </div>
          <dl className="mt-4 flex flex-wrap gap-x-10 gap-y-3">
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-wide text-ink/45">Courses</dt>
              <dd className="mt-0.5 font-medium">{selected.courseCount}</dd>
            </div>
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-wide text-ink/45">Batches</dt>
              <dd className="mt-0.5 font-medium">{selected.batchCount}</dd>
            </div>
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-wide text-ink/45">Nothing published</dt>
              <dd className={cn("mt-0.5 font-medium", selected.emptyCount > 0 ? "text-amber-700" : "text-emerald-700")}>
                {selected.emptyCount}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}

      {empty > 0 || unpublished > 0 ? (
        <div className="space-y-2">
          {empty > 0 ? (
            <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
              {empty} {empty === 1 ? "batch has" : "batches have"} no modules yet — learners assigned to
              {empty === 1 ? " it" : " them"} see an empty portal.
            </p>
          ) : null}
          {unpublished > 0 ? (
            <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
              {unpublished} {unpublished === 1 ? "batch has" : "batches have"} modules but nothing
              published — the work is written and still invisible.
            </p>
          ) : null}
        </div>
      ) : null}

      {batches.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-black/10 bg-white/50 p-10 text-center text-sm text-ink/50">
          {filtered
            ? "No batches match that filter."
            : "No batches found. Batches are created in the CRM under Batches — this screen only manages their content."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-black/5 bg-white">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="border-b border-black/5 text-left font-mono text-[10px] uppercase tracking-wide text-ink/45">
                <th className="px-5 py-3 font-normal">Batch</th>
                <th className="px-5 py-3 font-normal">Programme</th>
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
                      {[
                        b.courseName ?? "—",
                        b.trainerName,
                        shortRangeLabel(b.startDate, b.endDate),
                      ].filter(Boolean).join(" · ")}
                    </div>
                  </td>

                  <td className="px-5 py-3">
                    {b.programmeName ? (
                      <>
                        <Link
                          href={`/learn/admin?programme=${encodeURIComponent(b.programmeId!)}`}
                          className="hover:underline"
                        >
                          {b.programmeName}
                        </Link>
                        <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-ink/45">
                          {b.programmeCode ?? ""}
                          {/* A course reused across programmes means edits here
                              land in all of them. Worth saying before someone
                              rewrites a module for one cohort. */}
                          {b.programmeCount && b.programmeCount > 1
                            ? ` · in ${b.programmeCount} programmes`
                            : ""}
                        </div>
                      </>
                    ) : (
                      <span className="text-xs text-amber-700" title="This batch's course isn't in any programme">
                        Unlinked
                      </span>
                    )}
                  </td>

                  <td className="px-5 py-3">
                    <span className={cn(BATCH_STATUS_PILL, batchStatusCls(b.status))}>
                      {batchStatusLabel(b.status)}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">{b.learnerCount}</td>
                  <td className={cn("px-5 py-3 text-right tabular-nums",
                    b.moduleCount === 0 ? "text-amber-700" : "")}>
                    {b.moduleCount}
                  </td>
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
