import { Topbar } from "@/components/shell/Topbar";
import { getCatalog, getCurrentUser, getLeads, getSavedViews } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { NewLeadButton } from "@/components/leads/NewLeadDialog";
import { LeadsBoard, LEADS_SEARCH_SLOT_ID } from "@/components/leads/LeadsBoard";

export default async function LeadsPage() {
  await requirePagePermission("leads.read");
  // Note: dropped getSummary() — the subtitle line it fed is gone (per user
  // request 2026-07-06 to declutter the header).
  const [leads, me, catalog, views] = await Promise.all([
    getLeads(),
    getCurrentUser(),
    getCatalog(),
    getSavedViews("pipeline_list"),
  ]);
  const canWrite  = me?.permissions.includes("leads.write")  ?? false;
  const canDelete = me?.permissions.includes("leads.delete") ?? false;

  return (
    <>
      <Topbar
        crumb={<>Edify CRM <span className="text-hint">/</span> <b className="font-semibold text-ink">Leads</b></>}
        status="Scoring live"
        centerSlot={
          // Empty mount point. Search rides in the Topbar rather than the
          // board's toolbar — it jumps straight to a record, so it's
          // navigation, not a grid filter — but the list it searches lives in
          // LeadsBoard's client state (optimistic edits, the 30s poller), not
          // in this server component's snapshot. So the page owns the slot's
          // *position* and LeadsBoard portals the live input into it.
          <div id={LEADS_SEARCH_SLOT_ID} className="w-[min(530px,40vw)]" />
        }
      />

      <div className="px-9 pb-[60px] pt-7">
        {/* Header stripped 2026-07-06 — the Topbar breadcrumb already says
            "Leads". The "New lead" button rides on the view-tabs row via
            LeadsBoard's headerSlot so it sits right next to the tabs. */}
        <LeadsBoard
          initialLeads={leads}
          catalog={catalog}
          initialViews={views}
          currentUser={me}
          canWrite={canWrite}
          canDelete={canDelete}
          headerSlot={canWrite ? <NewLeadButton label="New lead" /> : null}
        />
      </div>
    </>
  );
}
