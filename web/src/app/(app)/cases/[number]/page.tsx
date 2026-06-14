import Link from "next/link";
import { notFound } from "next/navigation";
import { Topbar } from "@/components/shell/Topbar";
import { getCase } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { CaseDetailView } from "@/components/cases/CaseDetail";

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  await requirePagePermission("cases.read");
  const { number } = await params;
  const data = await getCase(number);
  if (!data) notFound();

  return (
    <>
      <Topbar
        crumb={
          <>
            Edify CRM <span className="text-hint">/</span>{" "}
            <Link href="/cases" className="hover:text-brand-violet">Cases</Link>{" "}
            <span className="text-hint">/</span>{" "}
            <b className="font-semibold text-ink">{data.case.number}</b>
          </>
        }
      />

      <div className="px-9 pb-[60px] pt-7">
        <CaseDetailView data={data} />
      </div>
    </>
  );
}
