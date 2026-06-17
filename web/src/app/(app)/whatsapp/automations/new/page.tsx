import { Topbar } from "@/components/shell/Topbar";
import { getUsers, getWaTags, getWaTemplates } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { WaAutomationEditor } from "@/components/whatsapp/WaAutomationEditor";
import Link from "next/link";

export default async function NewWaAutomationPage() {
  await requirePagePermission("whatsapp.manage");
  const [templates, tags, users] = await Promise.all([
    getWaTemplates(), getWaTags(), getUsers(),
  ]);
  const activeUsers = users.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name }));

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/inbox" className="cursor-pointer hover:text-ink">WhatsApp</Link>
            <span className="text-hint">/</span>
            <Link href="/whatsapp/automations" className="cursor-pointer hover:text-ink">Automations</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">New</b>
          </>
        }
        status="Draft"
      />
      <div className="px-9 pb-[60px] pt-7">
        <h1 className="mb-6 font-serif text-[40px] font-normal leading-none tracking-[-.01em]">New automation</h1>
        <WaAutomationEditor mode="new" templates={templates} tags={tags} users={activeUsers} />
      </div>
    </>
  );
}
