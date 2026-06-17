import { Topbar } from "@/components/shell/Topbar";
import { getCurrentUser, getWaAutomations } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { WaAutomationsList } from "@/components/whatsapp/WaAutomationsList";
import Link from "next/link";

export default async function WaAutomationsPage() {
  await requirePagePermission("whatsapp.read");
  const [automations, me] = await Promise.all([getWaAutomations(), getCurrentUser()]);
  const canManage = me?.permissions.includes("whatsapp.manage") ?? false;

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/inbox" className="cursor-pointer hover:text-ink">WhatsApp</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Automations</b>
          </>
        }
        status={canManage ? "Manage" : "Read-only"}
      />
      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Automations</h1>
            <p className="mt-2 max-w-[720px] text-[13.5px] text-mute">
              Run actions automatically on WhatsApp events. Pick a trigger (inbound keyword, new contact, lead created),
              add ordered actions (send template, tag, assign, etc.), enable, and forget.
            </p>
          </div>
          {canManage && (
            <Link href="/whatsapp/automations/new"
              className="rounded-md bg-brand-violet px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90">
              + New automation
            </Link>
          )}
        </div>
        <WaAutomationsList initialAutomations={automations} canManage={canManage} />
      </div>
    </>
  );
}
