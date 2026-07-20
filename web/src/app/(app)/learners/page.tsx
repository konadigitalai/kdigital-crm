import Link from "next/link";
import { Topbar } from "@/components/shell/Topbar";
import { getCurrentUser, getLearners, getLearnerSummary, getSavedViews } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { Icon } from "@/components/ui/Icon";
import { LearnersBoard, LEARNERS_SEARCH_SLOT_ID } from "@/components/learner/LearnersBoard";

export default async function LearnersPage() {
  await requirePagePermission("learners.read");

  // Summary is decorative KPI chrome — if it fails, the board still renders, so
  // it must never take the page down with it.
  const [learners, summary, me, views] = await Promise.all([
    getLearners(),
    getLearnerSummary().catch(() => null),
    getCurrentUser(),
    getSavedViews("learners_list"),
  ]);
  const canWrite = me?.permissions.includes("learners.write") ?? false;

  return (
    <>
      <Topbar
        crumb={<>Edify CRM <span className="text-hint">/</span> <b className="font-semibold text-ink">Learners</b></>}
        status={`${learners.length} total`}
        centerSlot={
          // Search rides in the Topbar (it navigates to a record), but the list
          // it searches lives in LearnersBoard's client state (poller). The
          // page owns the slot's position; the board portals the live input in.
          <div id={LEARNERS_SEARCH_SLOT_ID} className="w-[min(530px,40vw)]" />
        }
      />

      <div className="px-9 pb-[60px] pt-7">
        <LearnersBoard
          initialLearners={learners}
          summary={summary}
          initialViews={views}
          currentUser={me}
          canWrite={canWrite}
          headerSlot={canWrite ? <EnrollLearnerButton /> : null}
        />
      </div>
    </>
  );
}

// A learner is created by converting a verified enrollment — there's no direct
// "new learner" form. This routes to Enrollments, where that conversion
// happens, rather than faking a create dialog.
function EnrollLearnerButton() {
  return (
    <Link
      href="/enrollments"
      title="Learners are created by converting a verified enrollment — open Enrollments to start."
      className="btn-grad inline-flex items-center gap-1.5 whitespace-nowrap"
    >
      <Icon name="user-plus" size={14} strokeWidth={2} />
      Enroll a learner
    </Link>
  );
}
