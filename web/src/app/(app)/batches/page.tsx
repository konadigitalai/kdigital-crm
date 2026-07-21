import Link from "next/link";
import { Topbar } from "@/components/shell/Topbar";
import { getCurrentUser, getBatchesBoard, getBatchesSummary, getSavedViews } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { Icon } from "@/components/ui/Icon";
import { BatchesBoard, BATCHES_SEARCH_SLOT_ID } from "@/components/batch/BatchesBoard";

export default async function BatchesPage() {
  await requirePagePermission("admin.batches.manage");

  // Summary is decorative KPI chrome — if it fails, the board still renders, so
  // it must never take the page down with it.
  const [batches, summary, me, views] = await Promise.all([
    getBatchesBoard(),
    getBatchesSummary().catch(() => null),
    getCurrentUser(),
    getSavedViews("batches_list"),
  ]);
  const canWrite = me?.permissions.includes("admin.batches.manage") ?? false;

  return (
    <>
      <Topbar
        crumb={<>Edify CRM <span className="text-hint">/</span> <b className="font-semibold text-ink">Batches</b></>}
        status={`${batches.length} total`}
        centerSlot={
          // Search rides in the Topbar (it navigates to a record), but the list
          // it searches lives in BatchesBoard's client state (poller). The
          // page owns the slot's position; the board portals the live input in.
          <div id={BATCHES_SEARCH_SLOT_ID} className="w-[min(530px,40vw)]" />
        }
      />

      <div className="px-9 pb-[60px] pt-7">
        <BatchesBoard
          initialBatches={batches}
          summary={summary}
          initialViews={views}
          currentUser={me}
          canWrite={canWrite}
          headerSlot={canWrite ? <NewBatchButton /> : null}
        />
      </div>
    </>
  );
}

// Batch creation lives in the admin CRUD (structured trainer + cadence form),
// so this routes to Admin · Batches rather than faking a create dialog here.
function NewBatchButton() {
  return (
    <Link
      href="/admin/cohorts"
      title="Batches are created in Admin · Batches — open it to add one."
      className="btn-grad inline-flex items-center gap-1.5 whitespace-nowrap"
    >
      <Icon name="plus" size={14} strokeWidth={2} />
      New batch
    </Link>
  );
}
