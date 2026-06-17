import { Topbar } from "@/components/shell/Topbar";
import {
  getCurrentUser, getUsers, getWaAutomation, getWaAutomationRuns,
  getWaTags, getWaTemplates,
} from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { WaAutomationEditor } from "@/components/whatsapp/WaAutomationEditor";
import { WaAutomationRuns } from "@/components/whatsapp/WaAutomationRuns";
import Link from "next/link";
import { notFound } from "next/navigation";

export default async function WaAutomationDetailPage({
  params,
}: { params: Promise<{ id: string }> }) {
  await requirePagePermission("whatsapp.read");
  const { id } = await params;
  let automation;
  try {
    automation = await getWaAutomation(id);
  } catch {
    notFound();
  }
  const [templates, tags, users, runs, me] = await Promise.all([
    getWaTemplates(), getWaTags(), getUsers(), getWaAutomationRuns(id, 50), getCurrentUser(),
  ]);
  const canManage = me?.permissions.includes("whatsapp.manage") ?? false;
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
            <b className="font-semibold text-ink">{automation.name}</b>
          </>
        }
        status={automation.enabled ? "Enabled" : "Disabled"}
      />
      <div className="space-y-8 px-9 pb-[60px] pt-7">
        {canManage ? (
          <WaAutomationEditor mode="edit" initial={automation} templates={templates} tags={tags} users={activeUsers} />
        ) : (
          <div className="rounded-[14px] border border-rule bg-paper p-6 text-[13px] text-mute">
            You don&apos;t have permission to edit this automation. Ask an admin for the <span className="font-mono">whatsapp.manage</span> permission.
          </div>
        )}
        <WaAutomationRuns automationId={automation.id} initialRuns={runs} />
      </div>
    </>
  );
}
