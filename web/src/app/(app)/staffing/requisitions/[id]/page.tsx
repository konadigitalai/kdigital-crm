import Link from "next/link";
import { notFound } from "next/navigation";
import { Topbar } from "@/components/shell/Topbar";
import { getCandidates, getRequisition } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { RequisitionPipeline } from "@/components/staffing/RequisitionPipeline";
import { Pill, formatMoney, formatMonths, humanise } from "@/components/admin/formKit";

export default async function RequisitionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePagePermission("staffing.read");
  const { id } = await params;

  // These two don't depend on each other, so they go out together — one round
  // trip to the API instead of two back-to-back. The permission gate above
  // stays sequential on purpose: nothing should be fetched for a caller who
  // hasn't cleared it.
  //
  // Only people who pass the eligibility gate can be offered. Asking the server
  // for the eligible set rather than filtering client-side means the rule lives
  // in one place — the candidate_eligible view.
  const [requisition, eligible] = await Promise.all([
    getRequisition(id).catch(() => null),
    getCandidates({ eligibleOnly: true }),
  ]);
  if (!requisition) notFound();

  const alreadyApplied = new Set((requisition.applications ?? []).map((a) => a.candidatePartyId));
  const available = eligible.filter((c) => !alreadyApplied.has(c.partyId));

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/staffing/requisitions" className="cursor-pointer hover:text-ink">Staffing</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">{requisition.number}</b>
          </>
        }
        status="Synced"
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-6">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-serif text-[36px] font-normal leading-none tracking-[-.01em]">
              {requisition.jobTitle}
            </h1>
            <span className="font-mono text-[12px] text-hint">{requisition.number}</span>
            <Pill tone={requisition.status === "open" ? "good" : "neutral"}>
              {humanise(requisition.status)}
            </Pill>
            {requisition.approvalStatus === "pending" && <Pill tone="warn">approval pending</Pill>}
            {!requisition.budgetApproved && <Pill tone="warn">budget not approved</Pill>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-4 text-[13px] text-mute">
            <Link href={`/accounts/${requisition.accountPartyId}`} className="hover:text-brand-violet">
              {requisition.accountName}
            </Link>
            {requisition.department && <span>{requisition.department}</span>}
            {requisition.workMode && <span>{humanise(requisition.workMode)}</span>}
            {requisition.workLocation && <span>{requisition.workLocation}</span>}
            {requisition.recruiterName && <span>Recruiter · {requisition.recruiterName}</span>}
          </div>
        </div>

        <div className="mb-7 grid grid-cols-4 gap-4">
          <Stat
            label="Seats left"
            value={String(requisition.openSeats)}
            sub={`${requisition.hiredCount} hired of ${requisition.openings}`}
          />
          <Stat label="Applicants" value={String(requisition.applicationCount)} sub="all stages" />
          <Stat
            label="Experience"
            value={
              requisition.minimumExperienceMonths == null && requisition.maximumExperienceMonths == null
                ? "Any"
                : `${formatMonths(requisition.minimumExperienceMonths ?? 0)}–${formatMonths(requisition.maximumExperienceMonths)}`
            }
            sub={requisition.requiredQualification ?? "no qualification specified"}
          />
          <Stat
            label="Salary range"
            value={
              requisition.salaryMin || requisition.salaryMax
                ? `${formatMoney(requisition.salaryMin, requisition.currency)}–${formatMoney(requisition.salaryMax, requisition.currency)}`
                : "—"
            }
            sub={requisition.targetCloseDate ? `target ${requisition.targetCloseDate}` : "no target date"}
          />
        </div>

        {(requisition.requiredSkills.length > 0 || requisition.preferredSkills.length > 0) && (
          <div className="mb-7 grid grid-cols-2 gap-6">
            <SkillList title="Required skills" skills={requisition.requiredSkills} tone="brand" />
            <SkillList title="Preferred skills" skills={requisition.preferredSkills} tone="neutral" />
          </div>
        )}

        {requisition.jobDescription && (
          <section className="mb-7 rounded-2xl border border-rule bg-paper p-5">
            <h2 className="mono-cap mb-2 text-[10px] font-semibold tracking-[.12em] text-mute">
              Job description
            </h2>
            <p className="whitespace-pre-wrap text-[13.5px] leading-[1.65] text-ink2">
              {requisition.jobDescription}
            </p>
          </section>
        )}

        <RequisitionPipeline
          requisitionId={requisition.id}
          requisitionOpen={requisition.status === "open"}
          initial={requisition.applications ?? []}
          availableCandidates={available}
        />
      </div>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[14px] border border-rule bg-paper p-4">
      <div className="mono-cap text-[9.5px] font-semibold tracking-[.12em] text-mute">{label}</div>
      <div className="mt-1.5 font-mono text-[22px] leading-none tracking-[-.01em]">{value}</div>
      {sub && <div className="mt-1.5 text-[11.5px] text-mute">{sub}</div>}
    </div>
  );
}

function SkillList({
  title, skills, tone,
}: {
  title: string; skills: string[]; tone: "brand" | "neutral";
}) {
  if (skills.length === 0) return null;
  return (
    <div>
      <h2 className="mono-cap mb-2 text-[10px] font-semibold tracking-[.12em] text-mute">{title}</h2>
      <div className="flex flex-wrap gap-1.5">
        {skills.map((s) => <Pill key={s} tone={tone}>{s}</Pill>)}
      </div>
    </div>
  );
}
