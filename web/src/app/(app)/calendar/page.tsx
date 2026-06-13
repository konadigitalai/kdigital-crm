import Link from "next/link";
import { redirect } from "next/navigation";
import { Topbar } from "@/components/shell/Topbar";
import {
  getBatchSessions,
  getCatalog,
  getCurrentUser,
  getEvents,
  getTimesheetRange,
} from "@/lib/api";
import { CalendarShell } from "@/components/calendar/CalendarShell";

function istNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (5 * 60 + 30) * 60_000);
}
function istDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}
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

export default async function CalendarPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const week = weekDatesIST();
  const todayISO = istDateString(istNow());
  const from = week[0]!;
  const to = week[week.length - 1]!;

  const [events, range, catalog, sessions] = await Promise.all([
    getEvents(from, to),
    getTimesheetRange(from, to),
    getCatalog(),
    getBatchSessions(from, to),
  ]);

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/calendar" className="cursor-pointer hover:text-ink">Calendar</Link>
          </>
        }
        status="Synced"
      />
      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px]">
          <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Calendar</h1>
          <p className="mt-2 max-w-[640px] text-[13.5px] text-mute">
            Day, week, and month views of your meetings, batch sessions, and time blocks. Click any slot to schedule — invitees see it the moment they refresh.
          </p>
        </div>
        <CalendarShell
          meId={me.id}
          people={catalog.employees}
          initialAnchorISO={todayISO}
          initialView="week"
          initialEvents={events}
          initialBlocks={range.blocks}
          initialLeaves={range.leaves}
          initialSessions={sessions}
          initialFrom={from}
          initialTo={to}
        />
      </div>
    </>
  );
}
