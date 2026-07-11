import { Topbar } from "@/components/shell/Topbar";
import { requirePagePermission } from "@/lib/guards";
import { CampaignsList } from "@/components/campaigns/CampaignsList";
import Link from "next/link";

export default async function CampaignsPage() {
  await requirePagePermission("messaging.send");
  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/" className="cursor-pointer hover:text-ink">Home</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Campaigns</b>
          </>
        }
        status="Live"
      />
      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Campaigns</h1>
            <p className="mt-2 max-w-[640px] text-[13.5px] text-mute">
              Send Meta-approved WhatsApp templates to any lead segment. Every send respects
              per-party consent; recipients who&apos;ve opted out are automatically skipped.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/campaigns/triggers" className="btn">Triggers</Link>
            <Link href="/templates"          className="btn">Templates</Link>
            <Link href="/campaigns/new"      className="btn-grad">New campaign</Link>
          </div>
        </div>
        <CampaignsList />
      </div>
    </>
  );
}
