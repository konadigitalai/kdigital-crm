import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
import { getAdvisors } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { AdvisorsTable } from "@/components/admin/AdvisorsTable";
import Link from "next/link";

export default async function AdminAdvisorsPage() {
  // Same permission as the legacy user management page — admins only.
  await requirePagePermission("users.manage");
  const advisors = await getAdvisors();

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/settings" className="cursor-pointer hover:text-ink">Settings</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Advisors</b>
          </>
        }
        status="Synced"
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Manage Advisors</h1>
            <p className="mt-2 max-w-[720px] text-[13.5px] text-mute">
              Add, edit, or deactivate the people who get assigned leads. Adding an advisor here lets them be picked
              immediately; they can sign in once they authenticate through Auth0 with the same email.
            </p>
          </div>
        </div>

        <div className="mb-5 flex items-center gap-3 rounded-[14px] border border-rule2 bg-grad-soft p-[14px_18px] text-[13.5px] text-ink2">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-grad text-white">
            <Icon name="info" size={16} strokeWidth={1.8} />
          </span>
          <div>
            <b className="font-bold text-ink">Deactivate to retire.</b>{" "}
            Deactivating hides an advisor from every picker but keeps historical assignments intact.
          </div>
        </div>

        <AdvisorsTable initial={advisors} />
      </div>
    </>
  );
}
