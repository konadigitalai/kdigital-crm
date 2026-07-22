import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
import { getCurrentUser } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { InteraktCard } from "@/components/admin/InteraktCard";
import Link from "next/link";

export default async function AdminInteraktIntegrationPage() {
  await requirePagePermission("integrations.read");
  const me = await getCurrentUser();
  const canManage = me?.permissions.includes("integrations.manage") ?? false;

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/settings" className="cursor-pointer hover:text-ink">Settings</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Integrations · Interakt</b>
          </>
        }
        status={canManage ? "Manage" : "Read-only"}
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Interakt</h1>
            <p className="mt-2 max-w-[720px] text-[13.5px] text-mute">
              Push a lead's details to <b className="text-ink">Interakt</b> (WhatsApp Business) as a
              contact with custom traits. Configure the Secret Key here, then use the{" "}
              <b className="text-ink">Sync to Interakt</b> button on any lead record and the bulk action
              on the leads board.
            </p>
          </div>
        </div>

        <div className="mb-5 flex items-center gap-3 rounded-[14px] border border-rule2 bg-grad-soft p-[14px_18px] text-[13.5px] text-ink2">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-grad text-white">
            <Icon name="info" size={16} strokeWidth={1.8} />
          </span>
          <div>
            <b className="font-bold text-ink">The Secret Key is a secret.</b>{" "}
            Find it in Interakt → Settings → Developer Setting → Secret Key. Paste it here only —
            it is stored server-side and never shown in full again.
          </div>
        </div>

        <h2 className="mb-3 mt-8 font-serif text-[24px] tracking-[-.005em]">Connection</h2>
        <p className="mb-4 max-w-[720px] text-[13px] text-mute">
          Leads without a valid phone number are skipped when syncing. Syncing the same lead again
          updates the existing Interakt contact.
        </p>

        <InteraktCard canManage={canManage} />
      </div>
    </>
  );
}
