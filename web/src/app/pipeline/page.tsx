import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
import { getPipeline, getSummary } from "@/lib/api";
import { NewLeadButton } from "@/components/leads/NewLeadDialog";
import { PipelineBoard } from "@/components/pipeline/PipelineBoard";

function formatINR(n: number): string {
  if (!n || isNaN(n)) return "—";
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(1).replace(/\.0$/, "")}Cr`;
  if (n >= 1_00_000) return `₹${Math.round(n / 1_00_000)}L`;
  if (n >= 1_000) return `₹${Math.round(n / 1_000)}k`;
  return `₹${Math.round(n)}`;
}

export default async function PipelinePage() {
  const [grouped, summary] = await Promise.all([getPipeline(), getSummary()]);
  const totalLeads = summary.overall.total;
  const openValue = summary.byStage.reduce((sum, s) => sum + Number(s.deal_value_sum ?? 0), 0);
  const openValueFromColumns = grouped.reduce((sum, c) => {
    const n = c.sum.match(/^₹([\d.]+)([CrLk]+)?$/);
    if (!n) return sum;
    const x = Number(n[1]!);
    if (!n[2]) return sum + x;
    if (n[2] === "Cr") return sum + x * 1_00_00_000;
    if (n[2] === "L") return sum + x * 1_00_000;
    if (n[2] === "k") return sum + x * 1_000;
    return sum;
  }, 0);
  const totalOpen = openValue || openValueFromColumns;

  return (
    <>
      <Topbar
        crumb={<>Edify CRM <span className="text-hint">/</span> <b className="font-semibold text-ink">Pipeline</b></>}
        search="Search pipeline…"
        status="Agents sorting"
      />

      <div className="px-7 pb-10 pt-6">
        <div className="mb-[18px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[38px] font-normal leading-none tracking-[-.01em]">Pipeline</h1>
            <p className="mt-[7px] text-[13px] text-mute">
              {totalLeads} lead{totalLeads === 1 ? "" : "s"} · {formatINR(totalOpen)} open ·
              your agents auto-move cards as intent changes
            </p>
          </div>
          <div className="flex gap-2.5">
            <NewLeadButton label="New lead" />
          </div>
        </div>

        <PipelineBoard columns={grouped} />
      </div>
    </>
  );
}
