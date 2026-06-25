import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
import {
  getWaConfig, getWaTags, getWaTemplates, getCurrentUser,
} from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { WaConnectionCard } from "@/components/admin/WaConnectionCard";
import { WaTemplatesCard } from "@/components/admin/WaTemplatesCard";
import { WaTagsCard } from "@/components/admin/WaTagsCard";
import Link from "next/link";

export default async function AdminWhatsAppIntegrationPage() {
  await requirePagePermission("whatsapp.read");
  const [config, templates, tags, me] = await Promise.all([
    getWaConfig(),
    getWaTemplates(),
    getWaTags(),
    getCurrentUser(),
  ]);
  const canManage = me?.permissions.includes("whatsapp.manage") ?? false;

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/settings" className="cursor-pointer hover:text-ink">Settings</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Integrations · WhatsApp</b>
          </>
        }
        status={canManage ? "Manage" : "Read-only"}
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">WhatsApp</h1>
            <p className="mt-2 max-w-[720px] text-[13.5px] text-mute">
              Direct Meta Cloud API connection. Paste your phone number ID, WABA ID, app ID, app secret,
              system user token, and webhook verify token, then run <b className="text-ink">Verify</b>,{" "}
              <b className="text-ink">Register</b>, and <b className="text-ink">Subscribe</b> in order.
              Skipping the last two will silently misroute incoming webhooks.
            </p>
          </div>
        </div>

        <div className="mb-5 flex items-center gap-3 rounded-[14px] border border-rule2 bg-grad-soft p-[14px_18px] text-[13.5px] text-ink2">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-grad text-white">
            <Icon name="info" size={16} strokeWidth={1.8} />
          </span>
          <span>
            Webhook URL — point Meta at <code className="rounded bg-paper px-1.5 py-0.5 font-mono text-[12.5px] text-ink">{`{API_URL}/webhooks/whatsapp`}</code>{" "}
            and use the same verify token you saved here. Inbound messages and delivery callbacks both arrive on this URL.
          </span>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <WaConnectionCard initialConfig={config} canManage={canManage} />
          <WaTagsCard initialTags={tags} canManage={canManage} />
        </div>

        <div className="mt-6">
          <WaTemplatesCard initialTemplates={templates} canManage={canManage} />
        </div>
      </div>
    </>
  );
}
