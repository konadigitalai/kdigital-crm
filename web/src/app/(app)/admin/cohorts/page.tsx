import Link from "next/link";
import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
import { getBatches, getCatalog, getCourses } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { BatchesTable } from "@/components/admin/BatchesTable";

export default async function AdminCohortsPage() {
  await requirePagePermission("admin.batches.manage");
  const [batches, courses, catalog] = await Promise.all([getBatches(), getCourses(), getCatalog()]);
  const activeCourses = courses.filter((c) => c.enabled && c.programEnabled);

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/admin/programs" className="cursor-pointer hover:text-ink">Admin</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Batches</b>
          </>
        }
        status="Synced"
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Batches</h1>
            <p className="mt-2 max-w-[640px] text-[13.5px] text-mute">
              A batch is a time-fenced run of one course. Learners can be assigned to multiple batches
              (one per course they take). Inactive batches are hidden from new assignments.
            </p>
          </div>
        </div>

        <div className="mb-5 flex items-center gap-3 rounded-[14px] border border-rule2 bg-grad-soft p-[14px_18px] text-[13.5px] text-ink2">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-grad text-white">
            <Icon name="info" size={16} strokeWidth={1.8} />
          </span>
          <div>
            <b className="font-bold text-ink">Status guide.</b>{" "}
            <span className="font-mono text-[12px]">upcoming</span> · {" "}
            <span className="font-mono text-[12px]">running</span> · {" "}
            <span className="font-mono text-[12px]">completed</span> · {" "}
            <span className="font-mono text-[12px]">cancelled</span>.
            Slot can be morning · afternoon · evening.
          </div>
        </div>

        <BatchesTable initial={batches} courses={activeCourses} staff={catalog.staff} />
      </div>
    </>
  );
}
