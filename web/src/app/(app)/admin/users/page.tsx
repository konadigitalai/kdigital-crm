import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
import { getClients, getGroups, getUsers } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { UsersTable } from "@/components/admin/UsersTable";
import Link from "next/link";

export default async function AdminUsersPage() {
  await requirePagePermission("users.manage");
  const [users, groupsResp, clients] = await Promise.all([getUsers(), getGroups(), getClients()]);
  // Show every client to the admin form so a user can be re-attached to a
  // currently-inactive client too. The filtering for "what shows up in the
  // timesheet picker" lives on /me/clients (server-side).
  const allClients = clients;

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/admin/users" className="cursor-pointer hover:text-ink">Admin</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Users</b>
          </>
        }
        status="Synced"
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Users</h1>
            <p className="mt-2 max-w-[640px] text-[13.5px] text-mute">
              Add, deactivate, or reset passwords for everyone in the CRM. Permissions come from the
              groups a user belongs to.
            </p>
          </div>
        </div>

        <div className="mb-5 flex items-center gap-3 rounded-[14px] border border-rule2 bg-grad-soft p-[14px_18px] text-[13.5px] text-ink2">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-grad text-white">
            <Icon name="info" size={16} strokeWidth={1.8} />
          </span>
          <div>
            <b className="font-bold text-ink">Roles vs. Groups.</b>{" "}
            The role tag (admin / advisor / service_rep / readonly) is a label only.
            What a user can actually do is decided by their group memberships in{" "}
            <Link href="/admin/groups" className="font-semibold text-brand-violet hover:underline">
              Groups
            </Link>.
          </div>
        </div>

        <UsersTable
          initial={users}
          groups={groupsResp.groups}
          clients={allClients}
          modules={groupsResp.modules}
        />
      </div>
    </>
  );
}
