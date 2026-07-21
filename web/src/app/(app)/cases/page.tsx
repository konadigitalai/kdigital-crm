import { Topbar } from "@/components/shell/Topbar";
import { getCurrentUser, getCases, getCaseDashboard, getSavedViews } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { NewCaseButton } from "@/components/cases/NewCaseDialog";
import { CasesBoard, CASES_SEARCH_SLOT_ID } from "@/components/cases/CasesBoard";

export default async function CasesPage() {
  await requirePagePermission("cases.read");

  // Dashboard is decorative KPI chrome — if it fails, the board still renders,
  // so it must never take the page down with it.
  const [cases, dashboard, me, views] = await Promise.all([
    getCases(),
    getCaseDashboard().catch(() => null),
    getCurrentUser(),
    getSavedViews("cases_list"),
  ]);
  const canWrite = me?.permissions.includes("cases.write") ?? false;

  return (
    <>
      <Topbar
        crumb={<>Edify CRM <span className="text-hint">/</span> <b className="font-semibold text-ink">Cases</b></>}
        status={`${cases.length} total`}
        centerSlot={
          // Search rides in the Topbar (it navigates to a record), but the list
          // it searches lives in CasesBoard's client state (poller). The page
          // owns the slot's position; the board portals the live input in.
          <div id={CASES_SEARCH_SLOT_ID} className="w-[min(530px,40vw)]" />
        }
      />

      <div className="px-9 pb-[60px] pt-7">
        <CasesBoard
          initialCases={cases}
          dashboard={dashboard}
          initialViews={views}
          currentUser={me}
          canWrite={canWrite}
          headerSlot={canWrite ? <NewCaseButton /> : null}
        />
      </div>
    </>
  );
}
