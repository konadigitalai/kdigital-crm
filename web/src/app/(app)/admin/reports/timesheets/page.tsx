import Link from "next/link";
import { Topbar } from "@/components/shell/Topbar";
import { getTimesheetReport, getUsers } from "@/lib/api";
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

  const [users, rows] = await Promise.all([
    getUsers(),
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
            Hours by person across any date range. Filter to specific users, then download a CSV.
          </p>
        </div>

        <TimesheetReport
          users={users}
          initialFrom={from}
          initialTo={to}
          initialRows={rows}
        />
      </div>
    </>
  );
}
