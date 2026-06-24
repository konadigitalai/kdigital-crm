import Link from "next/link";
import { Topbar } from "@/components/shell/Topbar";
import { getCurrentUser, getCases } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { CasesTable } from "@/components/cases/CasesTable";
import { NewCaseButton } from "@/components/cases/NewCaseDialog";

export default async function CasesListPage() {
  await requirePagePermission("cases.read");
  const [cases, me] = await Promise.all([getCases(), getCurrentUser()]);
  const canWrite = me?.permissions.includes("cases.write") ?? false;

  return (
    <>
      <Topbar
        crumb={
          <>
            Edify CRM <span className="text-hint">/</span>{" "}
            <Link href="/cases" className="hover:text-brand-violet">Cases</Link>{" "}
            <span className="text-hint">/</span>{" "}
            <b className="font-semibold text-ink">All cases</b>
          </>
        }
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-6 flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">All cases</h1>
            <p className="mt-2 text-[13.5px] text-mute">
              Filter, sort, and dive into any record. Use the dashboard for the high-level view.
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <Link
              href="/cases"
              className="rounded-full border border-rule bg-paper px-4 py-2 text-[12.5px] font-semibold text-ink2 hover:border-rule2"
            >
              ← Dashboard
            </Link>
            {canWrite && <NewCaseButton />}
          </div>
        </div>

        <CasesTable cases={cases} />
      </div>
    </>
  );
}
