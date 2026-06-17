import { Topbar } from "@/components/shell/Topbar";
import { getWaTemplates } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { WaBroadcastWizard } from "@/components/whatsapp/WaBroadcastWizard";
import Link from "next/link";

export default async function NewWaBroadcastPage() {
  await requirePagePermission("whatsapp.broadcast");
  const templates = await getWaTemplates();
  const approved = templates.filter((t) => t.status === "approved");

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/inbox" className="cursor-pointer hover:text-ink">WhatsApp</Link>
            <span className="text-hint">/</span>
            <Link href="/whatsapp/broadcasts" className="cursor-pointer hover:text-ink">Broadcasts</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">New</b>
          </>
        }
        status="Draft"
      />

      <div className="px-9 pb-[60px] pt-7">
        <h1 className="mb-6 font-serif text-[40px] font-normal leading-none tracking-[-.01em]">New broadcast</h1>
        <WaBroadcastWizard approvedTemplates={approved} />
      </div>
    </>
  );
}
