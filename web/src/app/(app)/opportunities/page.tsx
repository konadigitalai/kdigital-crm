import { Topbar } from "@/components/shell/Topbar";
import { getAccounts, getOpportunities } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { OpportunityBoard } from "@/components/b2b/OpportunityBoard";

export default async function OpportunitiesPage() {
  await requirePagePermission("opportunities.read");
  // Closed deals come down too — the board hides them by default but the
  // toggle should not need a second round trip.
  const [{ opportunities, stageTotals }, accounts] = await Promise.all([
    getOpportunities({ includeClosed: true }),
    getAccounts(),
  ]);

  return (
    <>
      <Topbar crumb={<b className="font-semibold text-ink">Opportunities</b>} status="Synced" />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px]">
          <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Opportunities</h1>
          <p className="mt-2 max-w-[680px] text-[13.5px] text-mute">
            The corporate pipeline. Every deal belongs to an account, and the days-in-stage counter on
            each card comes from the database, not from guessing at the activity feed — so a deal that
            has quietly stopped moving is visible without anyone having to notice.
          </p>
        </div>

        <OpportunityBoard
          initial={opportunities}
          stageTotals={stageTotals}
          accounts={accounts.filter((a) => a.status === "active")}
        />
      </div>
    </>
  );
}
