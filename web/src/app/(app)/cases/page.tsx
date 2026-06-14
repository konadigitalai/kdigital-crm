import Link from "next/link";
import { Topbar } from "@/components/shell/Topbar";
import { getCurrentUser, getCaseDashboard } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { CaseDashboardCards } from "@/components/cases/CaseDashboardCards";
import { NewCaseButton } from "@/components/cases/NewCaseDialog";

export default async function CasesDashboardPage() {
  await requirePagePermission("cases.read");
  const [data, me] = await Promise.all([getCaseDashboard(), getCurrentUser()]);
  const canWrite = me?.permissions.includes("cases.write") ?? false;

  return (
    <>
      <Topbar
        crumb={<>Edify CRM <span className="text-hint">/</span> <b className="font-semibold text-ink">Cases</b></>}
        search="Search cases…"
        status={data.counts.open > 0 ? `${data.counts.open} open` : "all clear"}
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-6 flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Cases</h1>
            <p className="mt-2 text-[13.5px] text-mute">
              {data.counts.total} total · {data.counts.open + data.counts.inProgress + data.counts.pending} active ·{" "}
              {data.counts.overdue > 0 ? (
                <span className="font-semibold text-brand-magenta">{data.counts.overdue} overdue</span>
              ) : (
                <span>nothing overdue</span>
              )} · {data.counts.closedThisWeek} resolved this week
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <Link
              href="/cases/list"
              className="rounded-full border border-rule bg-paper px-4 py-2 text-[12.5px] font-semibold text-ink2 hover:border-rule2"
            >
              All cases →
            </Link>
            {canWrite && <NewCaseButton />}
          </div>
        </div>

        <CaseDashboardCards data={data} />
      </div>
    </>
  );
}
