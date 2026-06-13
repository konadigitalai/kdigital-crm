import { Topbar } from "@/components/shell/Topbar";
import { getLearners } from "@/lib/api";
import { LearnersTable } from "@/components/learner/LearnersTable";

export default async function LearnersPage() {
  const learners = await getLearners();
  const activeCount = learners.filter((l) => l.activeBatches > 0).length;
  const totalEnrol  = learners.reduce((s, l) => s + l.activeBatches, 0);

  return (
    <>
      <Topbar
        crumb={<>Edify CRM <span className="text-hint">/</span> <b className="font-semibold text-ink">Learners</b></>}
        search="Search learners…"
        status={`${activeCount} active`}
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Learners</h1>
            <p className="mt-2 text-[13.5px] text-mute">
              Everyone who's enrolled. {learners.length} total · {totalEnrol} active enrolments across batches.
            </p>
          </div>
        </div>

        <LearnersTable learners={learners} />
      </div>
    </>
  );
}
