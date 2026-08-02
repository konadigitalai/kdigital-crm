import { Topbar } from "@/components/shell/Topbar";
import Link from "next/link";
import { getCandidates } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { CandidatesTable } from "@/components/staffing/CandidatesTable";
import { StaffingTabs } from "@/components/staffing/StaffingTabs";

export default async function CandidatesPage() {
  await requirePagePermission("staffing.read");
  // Everyone with a profile, not just the eligible ones — a recruiter needs to
  // see who is blocked and on what, which is the whole point of the
  // eligibility column.
  const candidates = await getCandidates();

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/staffing/requisitions" className="cursor-pointer hover:text-ink">Staffing</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Candidates</b>
          </>
        }
        status="Synced"
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-5">
          <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Candidates</h1>
          <p className="mt-2 max-w-[680px] text-[13.5px] text-mute">
            Learners with a recruiting profile. Being offerable takes three things — qualified,
            consented, and a profile marked ready — and two of them belong to the learner, not to
            this screen. Consent withdrawn on a learner record removes them from here immediately.
          </p>
        </div>

        <StaffingTabs active="candidates" />

        <CandidatesTable initial={candidates} />
      </div>
    </>
  );
}
