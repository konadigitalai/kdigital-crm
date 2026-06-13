import Link from "next/link";
import { notFound } from "next/navigation";
import { Topbar } from "@/components/shell/Topbar";
import { getTicket } from "@/lib/api";
import { TicketDetailView } from "@/components/tickets/TicketDetail";

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  const { number } = await params;
  const data = await getTicket(number);
  if (!data) notFound();

  return (
    <>
      <Topbar
        crumb={
          <>
            Edify CRM <span className="text-hint">/</span>{" "}
            <Link href="/tickets" className="hover:text-brand-violet">Tickets</Link>{" "}
            <span className="text-hint">/</span>{" "}
            <b className="font-semibold text-ink">{data.ticket.number}</b>
          </>
        }
      />

      <div className="px-9 pb-[60px] pt-7">
        <TicketDetailView data={data} />
      </div>
    </>
  );
}
