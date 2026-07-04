import { Topbar } from "@/components/shell/Topbar";
import { getCatalog, getCurrentUser, getLeads, getSavedViews, getSummary } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { NewLeadButton } from "@/components/leads/NewLeadDialog";
import { LeadsBoard } from "@/components/leads/LeadsBoard";

export default async function LeadsPage() {
  await requirePagePermission("leads.read");
  const [leads, summary, me, catalog, views] = await Promise.all([
    getLeads(),
    getSummary(),
    getCurrentUser(),
    getCatalog(),
    getSavedViews("pipeline_list"),
  ]);
  const canWrite  = me?.permissions.includes("leads.write")  ?? false;
  const canDelete = me?.permissions.includes("leads.delete") ?? false;
  const o = summary.overall;

  return (
    <>
      <Topbar
        crumb={<>Edify CRM <span className="text-hint">/</span> <b className="font-semibold text-ink">Leads</b></>}
        status="Scoring live"
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Leads</h1>
            <p className="mt-2 text-[13.5px] text-mute">
              {o.total} lead{o.total === 1 ? "" : "s"} · {o.hotOvernight} went hot overnight ·
              your agents have {o.pendingApprovals} action{o.pendingApprovals === 1 ? "" : "s"} queued
            </p>
          </div>
          <div className="flex gap-2.5">
            {canWrite && <NewLeadButton label="New lead" />}
          </div>
        </div>

        <LeadsBoard
          initialLeads={leads}
          catalog={catalog}
          initialViews={views}
          currentUser={me}
          canWrite={canWrite}
          canDelete={canDelete}
        />
      </div>
    </>
  );
}
