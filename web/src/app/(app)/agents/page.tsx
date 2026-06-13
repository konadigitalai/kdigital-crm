import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
import { getAgentCatalog, getCurrentUser } from "@/lib/api";
import { AgentCatalog } from "@/components/agents/AgentCatalog";
import Link from "next/link";

export default async function AgentsPage() {
  const [agents, currentUser] = await Promise.all([getAgentCatalog(), getCurrentUser()]);
  const canManage = currentUser?.permissions.includes("users.manage") ?? false;

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/agents" className="cursor-pointer hover:text-ink">Agents</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Catalog</b>
          </>
        }
        status="Synced"
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Agents</h1>
            <p className="mt-2 max-w-[640px] text-[13.5px] text-mute">
              Every agent that operates on your CRM. Run them on demand, review run history, and
              control autonomy mode.
            </p>
          </div>
        </div>

        <div className="mb-5 flex items-center gap-3 rounded-[14px] border border-rule2 bg-grad-soft p-[14px_18px] text-[13.5px] text-ink2">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-grad text-white">
            <Icon name="info" size={16} strokeWidth={1.8} />
          </span>
          <div>
            <b className="font-bold text-ink">Supervised mode</b> queues every action behind your
            approval — drafts go to the lead's record and the activity feed.{" "}
            <b className="font-bold text-ink">Auto</b> writes immediately (use only for low-risk
            agents like Scoring).{" "}
            <b className="font-bold text-ink">Manual</b> means the agent only runs when you click.
          </div>
        </div>

        <AgentCatalog initial={agents} canManage={canManage} />
      </div>
    </>
  );
}
