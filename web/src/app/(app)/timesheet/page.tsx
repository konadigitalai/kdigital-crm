import Link from "next/link";
import { Topbar } from "@/components/shell/Topbar";
import { getMyClients, getTimesheetRange } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { TimesheetView } from "@/components/timesheet/TimesheetView";

// IST date helpers — keep server and DB consistent.
function istNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (5 * 60 + 30) * 60_000);
}

function istDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Monday-anchored week of 7 ISO dates including today's IST date.
function weekDatesIST(): string[] {
  const today = istNow();
  // Sunday = 0, Monday = 1, ..., Saturday = 6
  const dow = today.getUTCDay();
  const sinceMon = (dow + 6) % 7;
  const monday = new Date(today);
  monday.setUTCDate(monday.getUTCDate() - sinceMon);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + i);
    return istDateString(d);
  });
}

export default async function TimesheetPage() {
  await requirePagePermission("timesheets.read.self");
  const week = weekDatesIST();
  const todayISO = istDateString(istNow());
  const [range, myClients] = await Promise.all([
    getTimesheetRange(week[0]!, week[week.length - 1]!),
    getMyClients(),
  ]);

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/timesheet" className="cursor-pointer hover:text-ink">Timesheet</Link>
          </>
        }
        status="Synced"
      />
      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px]">
          <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Timesheet</h1>
          <p className="mt-2 max-w-[640px] text-[13.5px] text-mute">
            Add time blocks for whatever you worked on — pick a client, set start &amp; end, jot a short note. Edit anytime.
          </p>
        </div>
        <TimesheetView
          initialWeek={range}
          myClients={myClients}
          weekDates={week}
          todayISO={todayISO}
        />
      </div>
    </>
  );
}
