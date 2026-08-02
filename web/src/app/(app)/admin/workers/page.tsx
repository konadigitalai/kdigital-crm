import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
import { getWorkers } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { WorkersTable } from "@/components/admin/WorkersTable";
import Link from "next/link";

export default async function AdminWorkersPage() {
  await requirePagePermission("workers.read");
  // Exited staff included: the directory is also the historical record of who
  // taught what, and hiding them makes old batches look unstaffed.
  const workers = await getWorkers({ includeExited: true });

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/settings" className="cursor-pointer hover:text-ink">Settings</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Workforce</b>
          </>
        }
        status="Synced"
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Workforce</h1>
            <p className="mt-2 max-w-[680px] text-[13.5px] text-mute">
              Trainers, advisors, recruiters and the rest of the team. A worker record is an
              employment record — designation, reporting line, shift and skills. Name, email and
              phone belong to the person and are edited on their party record.
            </p>
          </div>
        </div>

        <div className="mb-5 flex items-center gap-3 rounded-[14px] border border-rule2 bg-grad-soft p-[14px_18px] text-[13.5px] text-ink2">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-grad text-white">
            <Icon name="info" size={16} strokeWidth={1.8} />
          </span>
          <div>
            <b className="font-bold text-ink">&ldquo;Can train&rdquo; is what fills the trainer pickers.</b>{" "}
            Before this directory existed, the Batches board offered every user with a login — which is
            why a finance admin could be assigned to teach Python. Nobody is listed here who is not staff,
            and no salary or personal document is stored.
          </div>
        </div>

        <WorkersTable initial={workers} />
      </div>
    </>
  );
}
