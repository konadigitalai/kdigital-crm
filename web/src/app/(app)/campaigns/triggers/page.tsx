import { Topbar } from "@/components/shell/Topbar";
import { requirePagePermission } from "@/lib/guards";
import { TriggersAdmin } from "@/components/campaigns/TriggersAdmin";
import Link from "next/link";

export default async function TriggersPage() {
  await requirePagePermission("messaging.send");
  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/campaigns" className="cursor-pointer hover:text-ink">Campaigns</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Triggers</b>
          </>
        }
        status="Auto-send"
      />
      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-6">
          <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Triggers</h1>
          <p className="mt-2 max-w-[720px] text-[13.5px] text-mute">
            Fire an approved template automatically when a lead enters a stage, is created, or its
            rating changes. Cooldown prevents the same trigger from firing twice for the same person.
          </p>
        </div>
        <TriggersAdmin />
      </div>
    </>
  );
}
