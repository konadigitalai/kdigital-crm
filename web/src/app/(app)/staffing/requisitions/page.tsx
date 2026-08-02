import { Topbar } from "@/components/shell/Topbar";
import Link from "next/link";
import { getAccounts, getRequisitions, getWorkers } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { RequisitionsTable } from "@/components/staffing/RequisitionsTable";
import { StaffingTabs } from "@/components/staffing/StaffingTabs";

export default async function RequisitionsPage() {
  await requirePagePermission("staffing.read");
  const [requisitions, accounts, workers] = await Promise.all([
    // Cancelled and closed roles are excluded by the API's default; passing an
    // empty status keeps that behaviour and the filter bar can widen it.
    getRequisitions(),
    getAccounts(),
    getWorkers(),
  ]);

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/staffing/requisitions" className="cursor-pointer hover:text-ink">Staffing</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Requisitions</b>
          </>
        }
        status="Synced"
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-5">
          <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Staffing</h1>
          <p className="mt-2 max-w-[680px] text-[13.5px] text-mute">
            The last stretch of the Academy end-to-end: a learner who is employable gets placed.
            Roles come from hiring-partner accounts, candidates come from learners who are both
            qualified and have consented, and applications join the two.
          </p>
        </div>

        <StaffingTabs active="requisitions" />

        <RequisitionsTable initial={requisitions} accounts={accounts} recruiters={workers} />
      </div>
    </>
  );
}
