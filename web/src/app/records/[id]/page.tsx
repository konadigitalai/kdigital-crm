import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Topbar } from "@/components/shell/Topbar";
import { Icon, type IconName } from "@/components/ui/Icon";
import { getRecord } from "@/lib/api";
import { avatarGradClass, stageStyles } from "@/lib/ui";
import { cn } from "@/lib/cn";
import { ConvertButton } from "@/components/record/ConvertDialog";
import { EditLeadButton, type LeadEditable } from "@/components/record/EditLeadDialog";
import { TimelineTabs } from "@/components/record/TimelineTabs";

export default async function RecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getRecord(id);
  if (!data) notFound();

  // A converted lead is a learner now — bounce to the learner page.
  if (data.isLearner) {
    redirect(`/learners/${data.lead.partyId}`);
  }

  const lead = data.lead;
  const attrs = lead.attributes ?? {};
  const fmtINR = (s: string | null | undefined) => s ? `₹${Number(s).toLocaleString("en-IN")}` : "—";
  const fmtDate = (s: string | null | undefined) => s ? new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
  const recordDetails = [
    { k: "Email",     v: attrs.email ?? "—", link: !!attrs.email },
    { k: "Phone",     v: attrs.phone ?? "—" },
    { k: "Program",   v: lead.program ?? "—" },
    { k: "Source",    v: attrs.source ?? "—" },
    { k: "Advisor",   v: attrs.advisor ?? "—" },
    { k: "Value",     v: lead.value ?? "—" },
  ];
  const paymentDetails = [
    { k: "Fee paid",   v: fmtINR(attrs.feePaid) },
    { k: "Fee due",    v: fmtINR(attrs.feeDue) },
    { k: "Registered", v: fmtDate(attrs.registeredDate) },
    { k: "Due date",   v: fmtDate(attrs.dueDate) },
    { k: "Proof",      v: attrs.paymentProofUrl ?? "—", link: !!attrs.paymentProofUrl, href: attrs.paymentProofUrl ?? undefined },
  ];
  const leadForEdit: LeadEditable = {
    name: lead.name,
    email: attrs.email ?? null,
    phone: attrs.phone ?? null,
    city: attrs.city ?? lead.city ?? null,
    programId: lead.programId,
    programName: lead.program,
    source: (lead as { leadSource?: string | null }).leadSource ?? null,
    sourceLabel: attrs.source ?? null,
    advisorId: (lead as { advisorId?: string | null }).advisorId ?? null,
    advisorName: attrs.advisor ?? null,
    value: lead.value,
    description: attrs.description ?? null,
    feePaid: attrs.feePaid ?? null,
    feeDue: attrs.feeDue ?? null,
    dueDate: attrs.dueDate ?? null,
    registeredDate: attrs.registeredDate ?? null,
    paymentProofUrl: attrs.paymentProofUrl ?? null,
    score: lead.score,
    heat: lead.heat,
    stage: lead.stage,
    nbaLabel: lead.nbaLabel,
  };
  const recordSignals = attrs.signals ?? [];
  const agentsOnLead = attrs.agentsOnLead ?? [];
  const nbaCard = attrs.nbaCard;
  const sc = stageStyles[lead.stage];

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/leads" className="cursor-pointer hover:text-ink">Leads</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">{lead.name}</b>
          </>
        }
        status="Agent watching"
      />

      <div
        className="grid"
        style={{ gridTemplateColumns: "1.7fr 1fr", minHeight: "calc(100vh - 49px)" }}
      >
        {/* MAIN */}
        <div className="border-r border-rule px-9 pb-[60px] pt-7">
          {/* HERO */}
          <div className="mb-6 flex items-start gap-[18px]">
            <div className={cn("flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-[18px] text-[24px] font-bold text-white", avatarGradClass[lead.avatar])}>
              {lead.initials}
            </div>
            <div>
              <h1 className="font-serif text-[38px] font-normal leading-none tracking-[-.01em]">{lead.name}</h1>
              <div className="mt-2 flex items-center gap-3 font-mono text-[11px] tracking-[.06em] text-mute">
                <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-sans text-[11.5px] font-semibold normal-case tracking-normal", sc.bg, sc.text)}>
                  <span className={cn("h-1.5 w-1.5 rounded-full", sc.dot)} />
                  {lead.stageLabel}
                </span>
                <span>{lead.number}</span>
                <span>·</span>
                <span>{lead.city} · IST</span>
              </div>
            </div>
            <div className="ml-auto flex gap-2">
              <button className="btn"><Icon name="mail" size={14} strokeWidth={2} />Email</button>
              <button className="btn"><Icon name="clock" size={14} strokeWidth={2} />Schedule</button>
              <ConvertButton
                leadNumber={lead.number}
                leadName={lead.name}
                programId={lead.programId}
              />
            </div>
          </div>

          {/* NBA DARK CARD */}
          <div className="nba-aurora relative mb-[22px] overflow-hidden rounded-[18px] bg-ink p-[22px] text-white">
            <div className="relative z-[1] mb-3.5 flex items-center gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-grad">
                <Icon name="star" size={15} strokeWidth={1.9} className="text-white" />
              </span>
              <span className="mono-cap text-[10px] font-semibold tracking-[.14em] text-white/60">
                Next best action · Edify Agent
              </span>
              {nbaCard && (
                <span className="mono-cap ml-auto font-mono text-[10px] tracking-[.08em] text-[#B7F35A]">
                  {nbaCard.confidence}% confidence
                </span>
              )}
            </div>
            <div className="relative z-[1] mb-2 font-serif text-[23px] leading-[1.25] text-white">
              {nbaCard?.headline ?? `Recommended action: ${lead.nbaLabel}`}
            </div>
            <div className="relative z-[1] mb-[18px] text-[13px] leading-[1.5] text-white/70">
              {nbaCard?.why ?? lead.scoreReason ?? "No suggestion yet."}
            </div>
            <div className="relative z-[1] flex gap-2.5">
              <button className="rounded-full border-0 bg-white px-4 py-2.5 text-[12.5px] font-semibold text-ink">
                Approve &amp; send draft →
              </button>
              <button className="rounded-full border border-white/20 bg-white/[.06] px-4 py-2.5 text-[12.5px] font-semibold text-white">
                Edit draft
              </button>
              <button className="rounded-full border border-white/20 bg-white/[.06] px-4 py-2.5 text-[12.5px] font-semibold text-white">
                Try a different action
              </button>
            </div>
          </div>

          {/* Timeline / Emails / Notes — interactive tabs */}
          <TimelineTabs leadNumber={lead.number} timeline={data.timeline} />
        </div>

        {/* ASIDE */}
        <aside className="bg-warm px-[26px] pb-[60px] pt-6">
          {/* AI score */}
          <div className="acard mb-3.5">
            <H4 right={<span className="mono-cap text-[9px] text-brand-violet">live</span>}>
              AI lead score
            </H4>
            <div className="flex items-center gap-4">
              <div
                className={cn(
                  "grid h-16 w-16 flex-shrink-0 place-items-center rounded-full",
                  lead.heat === "hot"  && "ring-hot",
                  lead.heat === "warm" && "ring-warm",
                  lead.heat === "cold" && "ring-cold",
                )}
                style={{ ["--p" as string]: `${lead.score}%` }}
              >
                <span
                  className={cn(
                    "grid h-[50px] w-[50px] place-items-center rounded-full bg-paper font-mono text-[18px] font-bold",
                    lead.heat === "hot"  && "text-brand-magenta",
                    lead.heat === "warm" && "text-state-amber",
                    lead.heat === "cold" && "text-mute",
                  )}
                >
                  {lead.score}
                </span>
              </div>
              <div>
                <div
                  className={cn(
                    "mono-cap text-[11px] font-semibold",
                    lead.heat === "hot"  && "text-brand-magenta",
                    lead.heat === "warm" && "text-state-amber",
                    lead.heat === "cold" && "text-mute",
                  )}
                >
                  {attrs.scoreLabel ?? `${lead.heat[0]!.toUpperCase()}${lead.heat.slice(1)} lead`}
                </div>
                <div className="mt-1 text-[13px] leading-[1.4] text-ink2">
                  {attrs.scoreDesc ?? lead.scoreReason ?? "—"}
                </div>
              </div>
            </div>
            <div className="mt-3.5 flex flex-col gap-2">
              {recordSignals.map((s, i) => (
                <div key={i} className="flex items-center gap-2.5 text-[12.5px] text-ink2">
                  <span
                    className={cn(
                      "h-[7px] w-[7px] flex-shrink-0 rounded-full",
                      s.kind === "pos" && "bg-state-ok",
                      s.kind === "neg" && "bg-state-warn",
                      s.kind === "neu" && "bg-state-amber",
                    )}
                  />
                  {s.text}
                  <span className="ml-auto font-mono text-[10px] text-mute">{s.weight}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Details */}
          <div className="acard mb-3.5">
            <H4 right={<EditLeadButton leadNumber={lead.number} lead={leadForEdit} />}>
              Lead details
            </H4>
            {recordDetails.map((d) => (
              <div
                key={d.k}
                className="flex items-center justify-between border-b border-dashed border-rule py-[9px] text-[13px] last:border-b-0"
              >
                <span className="font-medium text-mute">{d.k}</span>
                <span className={cn("text-right font-semibold", d.link ? "text-brand-violet" : "text-ink")}>
                  {d.v}
                </span>
              </div>
            ))}
          </div>

          {/* Description */}
          {attrs.description && (
            <div className="acard mb-3.5">
              <H4>Description</H4>
              <div className="whitespace-pre-line text-[13px] leading-[1.55] text-ink2">
                {attrs.description}
              </div>
            </div>
          )}

          {/* Payment trail */}
          <div className="acard mb-3.5">
            <H4>Payment</H4>
            {paymentDetails.map((d) => (
              <div
                key={d.k}
                className="flex items-center justify-between border-b border-dashed border-rule py-[9px] text-[13px] last:border-b-0"
              >
                <span className="font-medium text-mute">{d.k}</span>
                {d.link && d.href ? (
                  <a href={d.href} target="_blank" rel="noreferrer" className="text-right font-semibold text-brand-violet hover:underline">
                    View screenshot →
                  </a>
                ) : (
                  <span className={cn("text-right font-semibold", d.link ? "text-brand-violet" : "text-ink")}>
                    {d.v}
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* Agents on lead */}
          <div className="acard">
            <H4>Agents on this lead</H4>
            {agentsOnLead.map((a, i) => (
              <div key={i} className="flex items-center gap-[11px] border-b border-dashed border-rule py-2.5 last:border-b-0">
                <div className={cn("flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-[9px] text-white", avatarGradClass[a.glyph])}>
                  <Icon name={a.icon as IconName} size={14} strokeWidth={1.8} />
                </div>
                <div>
                  <div className="text-[12.5px] font-semibold">{a.name}</div>
                  <div className="mono-cap mt-px text-[9px] tracking-[.06em] text-mute">{a.status}</div>
                </div>
                <span
                  className={cn(
                    "mono-cap ml-auto rounded-full px-2 py-[3px] text-[9px] font-semibold tracking-[.06em]",
                    a.badge.kind === "done"
                      ? "bg-[rgba(46,158,106,.10)] text-state-ok"
                      : "bg-[rgba(31,63,207,.08)] text-brand-blue",
                  )}
                >
                  {a.badge.label}
                </span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </>
  );
}

function H4({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mono-cap mb-3.5 flex items-center justify-between text-[10px] font-semibold tracking-[.14em] text-mute">
      <span>{children}</span>
      {right}
    </div>
  );
}
