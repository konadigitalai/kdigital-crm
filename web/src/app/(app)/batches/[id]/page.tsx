import Link from "next/link";
import { Topbar } from "@/components/shell/Topbar";
import { ApiError, getBatchDetail, getBatchDetailSessions, getCurrentUser } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { BatchDetail } from "@/components/batch/BatchDetail";
import type { BatchDetailData, BatchSessionDetail, CurrentUser } from "@/lib/types";

export default async function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission("admin.batches.manage");
  const { id } = await params;

  let detail: BatchDetailData;
  let sessions: BatchSessionDetail[];
  let me: CurrentUser | null;

  try {
    [detail, sessions, me] = await Promise.all([
      getBatchDetail(id),
      getBatchDetailSessions(id),
      getCurrentUser(),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return (
        <>
          <Topbar
            crumb={
              <>
                Edify CRM <span className="text-hint">/</span>{" "}
                <Link href="/batches" className="cursor-pointer hover:text-ink">Batches</Link>
                <span className="text-hint">/</span> <b className="font-semibold text-ink">Not found</b>
              </>
            }
          />
          <div className="px-9 pb-[60px] pt-7">
            <div className="rounded-2xl border border-dashed border-rule p-12 text-center text-[13px] text-mute">
              Batch not found.
              <Link href="/batches" className="ml-2 font-semibold text-brand-violet hover:underline">
                Back to Batches
              </Link>
            </div>
          </div>
        </>
      );
    }
    throw err;
  }

  const canWrite = me?.permissions.includes("admin.batches.manage") ?? false;

  return (
    <>
      <Topbar
        crumb={
          <>
            Edify CRM <span className="text-hint">/</span>{" "}
            <Link href="/batches" className="cursor-pointer hover:text-ink">Batches</Link>
            <span className="text-hint">/</span> <b className="font-semibold text-ink">{detail.code ?? detail.name}</b>
          </>
        }
        status={detail.status}
      />

      <div className="px-9 pb-[60px] pt-7">
        <BatchDetail detail={detail} initialSessions={sessions} canWrite={canWrite} />
      </div>
    </>
  );
}
