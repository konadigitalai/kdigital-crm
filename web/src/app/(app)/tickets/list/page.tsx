import Link from "next/link";
import { Topbar } from "@/components/shell/Topbar";
import { getTickets } from "@/lib/api";
import { TicketsTable } from "@/components/tickets/TicketsTable";
import { NewTicketButton } from "@/components/tickets/NewTicketDialog";

export default async function TicketsListPage() {
  const tickets = await getTickets();

  return (
    <>
      <Topbar
        crumb={
          <>
            Edify CRM <span className="text-hint">/</span>{" "}
            <Link href="/tickets" className="hover:text-brand-violet">Tickets</Link>{" "}
            <span className="text-hint">/</span>{" "}
            <b className="font-semibold text-ink">All tickets</b>
          </>
        }
        search={`Search ${tickets.length} ticket${tickets.length === 1 ? "" : "s"}…`}
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-6 flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">All tickets</h1>
            <p className="mt-2 text-[13.5px] text-mute">
              Filter, sort, and dive into any record. Use the dashboard for the high-level view.
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <Link
              href="/tickets"
              className="rounded-full border border-rule bg-paper px-4 py-2 text-[12.5px] font-semibold text-ink2 hover:border-rule2"
            >
              ← Dashboard
            </Link>
            <NewTicketButton />
          </div>
        </div>

        <TicketsTable tickets={tickets} />
      </div>
    </>
  );
}
