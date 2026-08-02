import { Topbar } from "@/components/shell/Topbar";
import Link from "next/link";
import { getApplications } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { ApplicationsTable } from "@/components/staffing/ApplicationsTable";
import { StaffingTabs } from "@/components/staffing/StaffingTabs";

export default async function ApplicationsPage() {
  await requirePagePermission("staffing.read");
  const applications = await getApplications();

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/staffing/requisitions" className="cursor-pointer hover:text-ink">Staffing</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Applications</b>
          </>
        }
        status="Synced"
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-5">
          <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Applications</h1>
          <p className="mt-2 max-w-[680px] text-[13.5px] text-mute">
            Every candidate put forward for a role. Hiring, rejecting and withdrawing are separately
            permissioned from ordinary edits — and a rejection has to carry a reason, because a
            pipeline nobody can review afterwards is not a record of anything.
          </p>
        </div>

        <StaffingTabs active="applications" />

        <ApplicationsTable initial={applications} />
      </div>
    </>
  );
}
