import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
import { getGroups } from "@/lib/api";
import { GroupsTable } from "@/components/admin/GroupsTable";
import Link from "next/link";

export default async function AdminGroupsPage() {
  const { groups, catalog } = await getGroups();

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/admin/groups" className="cursor-pointer hover:text-ink">Admin</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Groups</b>
          </>
        }
        status="Synced"
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Groups</h1>
            <p className="mt-2 max-w-[640px] text-[13.5px] text-mute">
              A user's effective permissions are the union of every group they belong to. System
              groups are seeded once and cannot be deleted.
            </p>
          </div>
        </div>

        <div className="mb-5 flex items-center gap-3 rounded-[14px] border border-rule2 bg-grad-soft p-[14px_18px] text-[13.5px] text-ink2">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-grad text-white">
            <Icon name="info" size={16} strokeWidth={1.8} />
          </span>
          <div>
            <b className="font-bold text-ink">Assigning groups.</b>{" "}
            Add or remove members from a group on the{" "}
            <Link href="/admin/users" className="font-semibold text-brand-violet hover:underline">
              Users
            </Link>{" "}
            page.
          </div>
        </div>

        <GroupsTable initial={groups} catalog={catalog} />
      </div>
    </>
  );
}
