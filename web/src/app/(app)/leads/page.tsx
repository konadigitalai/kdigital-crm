import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
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
        search={`Search ${o.total} lead${o.total === 1 ? "" : "s"}…`}
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

        {o.pendingApprovals > 0 && (
          <div className="mb-5 flex items-center gap-4 rounded-[14px] border border-rule2 p-[16px_20px]" style={{ background: "linear-gradient(120deg,rgba(31,63,207,.06),rgba(199,25,122,.05))" }}>
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[11px] bg-grad">
              <Icon name="star" size={18} strokeWidth={1.8} className="text-white" />
            </div>
            <div className="flex-1 text-[14px] leading-[1.45] text-ink2">
              <b className="font-bold text-ink">Lead Scoring Agent:</b> {o.hotOvernight} lead{o.hotOvernight === 1 ? "" : "s"} crossed the "hot" threshold overnight.{" "}
              {o.pendingApprovals} already have drafted follow-ups waiting — approving them now could save ~3 hours.
            </div>
            <button className="whitespace-nowrap rounded-full bg-ink px-4 py-[9px] text-[12.5px] font-semibold text-white">
              Review {o.pendingApprovals} draft{o.pendingApprovals === 1 ? "" : "s"} →
            </button>
          </div>
        )}

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
