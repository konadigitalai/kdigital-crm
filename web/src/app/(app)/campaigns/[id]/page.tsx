import { Topbar } from "@/components/shell/Topbar";
import { requirePagePermission } from "@/lib/guards";
import { CampaignDetailView } from "@/components/campaigns/CampaignDetailView";
import Link from "next/link";

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePagePermission("messaging.read");
  const { id } = await params;
  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/campaigns" className="cursor-pointer hover:text-ink">Campaigns</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Detail</b>
          </>
        }
        status="Live"
      />
      <div className="px-9 pb-[60px] pt-7">
        <CampaignDetailView id={id} />
      </div>
    </>
  );
}
