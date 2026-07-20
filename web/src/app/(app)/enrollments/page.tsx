import Link from "next/link";
import { Topbar } from "@/components/shell/Topbar";
import { getCurrentUser, getEnrollments, getEnrollmentSummary, getSavedViews } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { Icon } from "@/components/ui/Icon";
import { EnrollmentsBoard, ENROLLMENTS_SEARCH_SLOT_ID } from "@/components/enrollment/EnrollmentsBoard";

export default async function EnrollmentsPage() {
  await requirePagePermission("learners.read");

  // Summary is decorative KPI chrome — if it fails, the board still renders, so
  // it must never take the page down with it.
  const [enrollments, summary, me, views] = await Promise.all([
    getEnrollments(),
    getEnrollmentSummary().catch(() => null),
    getCurrentUser(),
    getSavedViews("enrollments_list"),
  ]);
  const canWrite = me?.permissions.includes("learners.write") ?? false;

  return (
    <>
      <Topbar
        crumb={<>Edify CRM <span className="text-hint">/</span> <b className="font-semibold text-ink">Enrollments</b></>}
        status={`${enrollments.length} total`}
        centerSlot={
          // Search rides in the Topbar (it navigates to a record), but the list
          // it searches lives in EnrollmentsBoard's client state (poller). The
          // page owns the slot's position; the board portals the live input in.
          <div id={ENROLLMENTS_SEARCH_SLOT_ID} className="w-[min(530px,40vw)]" />
        }
      />

      <div className="px-9 pb-[60px] pt-7">
        <EnrollmentsBoard
          initialEnrollments={enrollments}
          summary={summary}
          initialViews={views}
          currentUser={me}
          canWrite={canWrite}
          headerSlot={canWrite ? <NewEnrollmentButton /> : null}
        />
      </div>
    </>
  );
}

// New enrollments start life as a lead that's converted (lead → enrolled →
// learner). Until a dedicated create-flow exists, this routes to Leads where
// that conversion happens, rather than faking a stub dialog.
function NewEnrollmentButton() {
  return (
    <Link
      href="/leads"
      title="Enrollments begin by converting a lead — open Leads to start."
      className="btn-grad inline-flex items-center gap-1.5 whitespace-nowrap"
    >
      <Icon name="user-plus" size={14} strokeWidth={2} />
      New enrollment
    </Link>
  );
}
