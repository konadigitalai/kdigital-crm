import { Topbar } from "@/components/shell/Topbar";
import { requirePagePermission } from "@/lib/guards";
import { NewCampaignWizard } from "@/components/campaigns/NewCampaignWizard";
import Link from "next/link";

export default async function NewCampaignPage() {
  await requirePagePermission("messaging.send");
  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/campaigns" className="cursor-pointer hover:text-ink">Campaigns</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">New</b>
          </>
        }
        status="Draft"
      />
      <div className="px-9 pb-[60px] pt-7">
        <h1 className="mb-6 font-serif text-[40px] font-normal leading-none tracking-[-.01em]">
          New campaign
        </h1>
        <NewCampaignWizard />
      </div>
    </>
  );
}
