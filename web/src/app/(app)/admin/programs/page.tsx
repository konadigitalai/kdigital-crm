import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
import { getPrograms } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { ProgramsTable } from "@/components/admin/ProgramsTable";
import Link from "next/link";

export default async function AdminProgramsPage() {
  await requirePagePermission("admin.programs.manage");
  const programs = await getPrograms();

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/admin/programs" className="cursor-pointer hover:text-ink">Admin</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Programs</b>
          </>
        }
        status="Synced"
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Programs</h1>
            <p className="mt-2 max-w-[640px] text-[13.5px] text-mute">
              Add, rename, or retire the programs you sell. Inactive programs are hidden from
              new-lead dropdowns but their history (leads, batches, enrolments) stays intact.
            </p>
          </div>
        </div>

        <div className="mb-5 flex items-center gap-3 rounded-[14px] border border-rule2 bg-grad-soft p-[14px_18px] text-[13.5px] text-ink2">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-grad text-white">
            <Icon name="info" size={16} strokeWidth={1.8} />
          </span>
          <div>
            <b className="font-bold text-ink">Cohorts live under each program.</b>{" "}
            When a sale closes, the lead is converted to a learner and a cohort is assigned at that point.
          </div>
        </div>

        <ProgramsTable initial={programs} />
      </div>
    </>
  );
}
