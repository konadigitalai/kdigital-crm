import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
import { getCurrentUser, getDeletedLeads } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { DeletedLeadsTable } from "@/components/admin/DeletedLeadsTable";
import Link from "next/link";

export default async function AdminDeletedLeadsPage() {
  await requirePagePermission("leads.delete");
  const [leads, me] = await Promise.all([getDeletedLeads(), getCurrentUser()]);
  const canPurge = me?.permissions.includes("leads.purge") ?? false;

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/settings" className="cursor-pointer hover:text-ink">Settings</Link>
            <span className="text-hint">/</span>
            <Link href="/leads" className="cursor-pointer hover:text-ink">Leads</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Deleted</b>
          </>
        }
        status={canPurge ? "Manage + purge" : "Restore-only"}
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Deleted leads</h1>
            <p className="mt-2 max-w-[640px] text-[13.5px] text-mute">
              Leads that have been soft-deleted from the pipeline. Their activity history is intact —
              click <b className="text-ink">Restore</b> to bring one back.
              {canPurge && (
                <>
                  {" "}
                  <b className="text-ink">Permanently delete</b> wipes the lead row, signals, agent assignments and timeline. There is no undo.
                </>
              )}
            </p>
          </div>
        </div>

        {!canPurge && (
          <div className="mb-5 flex items-start gap-3 rounded-[14px] border border-rule2 bg-grad-soft p-[14px_18px] text-[13.5px] text-ink2">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-grad text-white">
              <Icon name="info" size={16} strokeWidth={1.8} />
            </span>
            <div>
              <b className="font-bold text-ink">Permanent delete is admin-only.</b>{" "}
              You can restore any lead here. Ask an admin if you need a record permanently erased.
            </div>
          </div>
        )}

        <DeletedLeadsTable initial={leads} canPurge={canPurge} />
      </div>
    </>
  );
}
