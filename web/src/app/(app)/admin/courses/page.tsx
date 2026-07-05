import Link from "next/link";
import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
import { getCourses } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { CoursesTable } from "@/components/admin/CoursesTable";

export default async function AdminCoursesPage() {
  await requirePagePermission("admin.courses.manage");
  const courses = await getCourses();

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/settings" className="cursor-pointer hover:text-ink">Settings</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Courses</b>
          </>
        }
        status="Synced"
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Courses</h1>
            <p className="mt-2 max-w-[640px] text-[13.5px] text-mute">
              A course is a reusable module — programs pick which courses to include. Each course is
              delivered as one or more batches. Inactive courses are hidden from new batch assignments.
            </p>
          </div>
        </div>

        <div className="mb-5 flex items-center gap-3 rounded-[14px] border border-rule2 bg-grad-soft p-[14px_18px] text-[13.5px] text-ink2">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-grad text-white">
            <Icon name="info" size={16} strokeWidth={1.8} />
          </span>
          <div>
            <b className="font-bold text-ink">One course, many programs.</b>{" "}
            Create <i>Python</i> or <i>SQL</i> once — then include it in <i>AI &amp; Data Science</i>, <i>Full Stack + AI</i>, and any future program that needs it.
          </div>
        </div>

        <CoursesTable initial={courses} />
      </div>
    </>
  );
}
