import { Topbar } from "@/components/shell/Topbar";
import { getCurrentUser, getWaBroadcast } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { WaBroadcastDetailView } from "@/components/whatsapp/WaBroadcastDetailView";
import Link from "next/link";
import { notFound } from "next/navigation";

export default async function WaBroadcastDetailPage({
  params,
}: { params: Promise<{ id: string }> }) {
  await requirePagePermission("whatsapp.read");
  const { id } = await params;
  const [me] = await Promise.all([getCurrentUser()]);
  const canBroadcast = me?.permissions.includes("whatsapp.broadcast") ?? false;

  let detail;
  try {
    detail = await getWaBroadcast(id);
  } catch {
    notFound();
  }

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/inbox" className="cursor-pointer hover:text-ink">WhatsApp</Link>
            <span className="text-hint">/</span>
            <Link href="/whatsapp/broadcasts" className="cursor-pointer hover:text-ink">Broadcasts</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">{detail.broadcast.name}</b>
          </>
        }
        status={detail.broadcast.status}
      />
      <div className="px-9 pb-[60px] pt-7">
        <WaBroadcastDetailView initialDetail={detail} canBroadcast={canBroadcast} />
      </div>
    </>
  );
}
