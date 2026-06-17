import { Topbar } from "@/components/shell/Topbar";
import { getCurrentUser, getWaBroadcasts } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { WaBroadcastsList } from "@/components/whatsapp/WaBroadcastsList";
import Link from "next/link";

export default async function WaBroadcastsPage() {
  await requirePagePermission("whatsapp.read");
  const [broadcasts, me] = await Promise.all([getWaBroadcasts(), getCurrentUser()]);
  const canBroadcast = me?.permissions.includes("whatsapp.broadcast") ?? false;

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/inbox" className="cursor-pointer hover:text-ink">WhatsApp</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Broadcasts</b>
          </>
        }
        status={canBroadcast ? "Manage" : "Read-only"}
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Broadcasts</h1>
            <p className="mt-2 max-w-[720px] text-[13.5px] text-mute">
              Send an approved template to many recipients at once. Each broadcast tracks its own per-recipient
              delivery state. Marketing templates respect Meta's 24h-window opt-in rules.
            </p>
          </div>
          {canBroadcast && (
            <Link href="/whatsapp/broadcasts/new"
              className="rounded-md bg-brand-violet px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90">
              + New broadcast
            </Link>
          )}
        </div>

        <WaBroadcastsList initialBroadcasts={broadcasts} />
      </div>
    </>
  );
}
