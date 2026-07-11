import { Topbar } from "@/components/shell/Topbar";
import { requirePagePermission } from "@/lib/guards";
import { TemplatesAdmin } from "@/components/campaigns/TemplatesAdmin";
import Link from "next/link";

export default async function TemplatesPage() {
  await requirePagePermission("messaging.send");
  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/campaigns" className="cursor-pointer hover:text-ink">Campaigns</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Templates</b>
          </>
        }
        status="Meta approvals"
      />
      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-6">
          <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Templates</h1>
          <p className="mt-2 max-w-[720px] text-[13.5px] text-mute">
            Every proactive WhatsApp message outside a 24-hour session window must be a
            Meta-approved template. Draft here, submit for approval, then pick from the campaign wizard.
          </p>
        </div>
        <TemplatesAdmin />
      </div>
    </>
  );
}
