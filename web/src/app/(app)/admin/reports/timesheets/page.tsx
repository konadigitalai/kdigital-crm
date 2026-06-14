import Link from "next/link";
import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
import { getClients, getTimesheetReport, getUsers } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { TimesheetReport } from "@/components/admin/TimesheetReport";

// Default: rolling last 30 days (IST), inclusive.
function istShift(days: number): string {
  const ist = new Date(Date.now() + (5 * 60 + 30) * 60_000);
  ist.setUTCDate(ist.getUTCDate() + days);
  return ist.toISOString().slice(0, 10);
}

export default async function AdminTimesheetReportPage() {
  await requirePagePermission("timesheets.read.all");
  const from = istShift(-29);
  const to   = istShift(0);

  const [users, clients, rows] = await Promise.all([
    getUsers(),
    getClients(),
    getTimesheetReport(from, to),
  ]);

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/admin/users" className="cursor-pointer hover:text-ink">Admin</Link>
            <span className="text-hint">/</span>
            <Link href="/admin/reports/timesheets" className="cursor-pointer hover:text-ink">Reports</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Timesheets</b>
          </>
        }
        status="Synced"
      />
      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px]">
          <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Timesheet report</h1>
          <p className="mt-2 max-w-[680px] text-[13.5px] text-mute">
            Hours by person and client across any date range. Filter to specific users or clients,
            then download a CSV for downstream invoicing.
          </p>
        </div>

        <div className="mb-5 flex items-center gap-3 rounded-[14px] border border-rule2 bg-grad-soft p-[14px_18px] text-[13.5px] text-ink2">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-grad text-white">
            <Icon name="info" size={16} strokeWidth={1.8} />
          </span>
          <div>
            Hours are aggregated per <b className="font-bold text-ink">user × client × day</b>. Blocks
            from before the client requirement landed appear under the{" "}
            <span className="font-semibold text-state-warn">Unassigned</span> column —
            ask the user to fix or delete them on their <b className="font-bold text-ink">Timesheet</b> page.
          </div>
        </div>

        <TimesheetReport
          users={users}
          clients={clients}
          initialFrom={from}
          initialTo={to}
          initialRows={rows}
        />
      </div>
    </>
  );
}
