import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
import { getAccounts } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { AccountsTable } from "@/components/b2b/AccountsTable";

export default async function AccountsPage() {
  await requirePagePermission("accounts.read");
  const accounts = await getAccounts();

  return (
    <>
      <Topbar crumb={<b className="font-semibold text-ink">Accounts</b>} status="Synced" />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px]">
          <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Accounts</h1>
          <p className="mt-2 max-w-[680px] text-[13.5px] text-mute">
            The organisations on the other side of the business — the ones that buy training for their
            teams and the ones that hire our graduates. Often the same company doing both.
          </p>
        </div>

        <div className="mb-5 flex items-center gap-3 rounded-[14px] border border-rule2 bg-grad-soft p-[14px_18px] text-[13.5px] text-ink2">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-grad text-white">
            <Icon name="info" size={16} strokeWidth={1.8} />
          </span>
          <div>
            <b className="font-bold text-ink">Accounts are organisations, not leads.</b>{" "}
            A lead is one person who wants to learn something. An account is a company with contacts,
            deals and open roles hanging off it — and marking one a hiring partner is what lets you
            raise requisitions against it.
          </div>
        </div>

        <AccountsTable initial={accounts} />
      </div>
    </>
  );
}
