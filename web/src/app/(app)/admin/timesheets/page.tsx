import Link from "next/link";
import { Topbar } from "@/components/shell/Topbar";
import { getTimesheetRange, getUsers } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { TimesheetGrid, type UserTimesheet } from "@/components/admin/TimesheetGrid";

function istNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (5 * 60 + 30) * 60_000);
}
function istDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}
// The initial server load mirrors what TimesheetGrid will request for the
// default Week scope around today: the IST week starting Monday.
function weekDatesIST(): string[] {
  const today = istNow();
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

export default async function AdminTimesheetsPage() {
  await requirePagePermission("timesheets.read.all");
  const week = weekDatesIST();
  const todayISO = istDateString(istNow());
  const from = week[0]!;
  const to = week[week.length - 1]!;

  const users = await getUsers();
  const activeUsers = users.filter((u) => u.active);

  const rows: UserTimesheet[] = await Promise.all(
    activeUsers.map(async (u) => {
      try {
        const r = await getTimesheetRange(from, to, u.id);
        return {
          user: { id: u.id, name: u.name ?? u.email, email: u.email, role: u.role },
          sessions: r.sessions,
          blocks: r.blocks,
          leaves: r.leaves,
        };
      } catch {
        return {
          user: { id: u.id, name: u.name ?? u.email, email: u.email, role: u.role },
          sessions: [], blocks: [], leaves: [],
        };
      }
    }),
  );

  rows.sort((a, b) => {
    const aH = a.blocks.length;
    const bH = b.blocks.length;
    if (aH !== bH) return bH - aH;
    return a.user.name.localeCompare(b.user.name);
  });

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/admin/timesheets" className="cursor-pointer hover:text-ink">Admin</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Timesheets</b>
          </>
        }
        status="Synced"
      />
      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px]">
          <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Team timesheets</h1>
          <p className="mt-2 max-w-[640px] text-[13.5px] text-mute">
            Hours logged across the team. Use the date controls to flip between days, weeks, or months. Click any cell to drill into that day's blocks.
          </p>
        </div>
        <TimesheetGrid
          users={users}
          initialAnchorISO={todayISO}
          initialScope="week"
          initialFrom={from}
          initialTo={to}
          initialRows={rows}
        />
      </div>
    </>
  );
}
