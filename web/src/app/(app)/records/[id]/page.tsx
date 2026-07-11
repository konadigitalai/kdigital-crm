import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Topbar } from "@/components/shell/Topbar";
import { Icon, type IconName } from "@/components/ui/Icon";
import { getCatalog, getCurrentUser, getRecord } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { avatarGradClass } from "@/lib/ui";
import { cn } from "@/lib/cn";
import { ConvertButton } from "@/components/record/ConvertDialog";
import { DeleteLeadButton } from "@/components/record/DeleteLeadButton";
import { EditLeadButton, type LeadEditable } from "@/components/record/EditLeadDialog";
import { ShareToSlackButton } from "@/components/share/ShareToSlackButton";
import { SendMessageButton } from "@/components/record/SendMessageButton";
import { TimelineTabs } from "@/components/record/TimelineTabs";
import { AgentActions } from "@/components/record/AgentActions";
import { ApprovalCard } from "@/components/record/ApprovalCard";
import { NbaCard } from "@/components/record/NbaCard";
import { InlineLeadField } from "@/components/record/InlineLeadField";
import { LeadNavArrows } from "@/components/record/LeadNavArrows";
import { GlobalLeadSearch } from "@/components/record/GlobalLeadSearch";
import { PhoneField } from "@/components/record/PhoneField";
import { PhoneCodeField } from "@/components/record/PhoneCodeField";

// Curated tz options for the lead-header inline picker. Storing IANA names so
// downstream rendering with toLocaleString() Just Works.
const TIMEZONE_OPTIONS = [
  { value: "Asia/Kolkata",      label: "IST · India" },
  { value: "America/New_York",  label: "ET · US Eastern" },
  { value: "America/Chicago",   label: "CT · US Central" },
  { value: "America/Denver",    label: "MT · US Mountain" },
  { value: "America/Los_Angeles", label: "PT · US Pacific" },
  { value: "Europe/London",     label: "UK · London" },
];

// How the lead wants the program delivered. Stored as the lowercase key.
const DELIVERY_MODE_OPTIONS = [
  { value: "online",    label: "Online"    },
  { value: "classroom", label: "Classroom" },
  { value: "hybrid",    label: "Hybrid"    },
];

export default async function RecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // `?asLead=1` keeps us on the lead-record page even when the person has
  // been converted to a learner — used by the learner page's "View lead
  // record" link so it doesn't redirect right back where it came from.
  searchParams?: Promise<{ asLead?: string }>;
}) {
  await requirePagePermission("leads.read");
  const { id } = await params;
  const sp = (await searchParams) ?? {};
  const [data, catalog, me] = await Promise.all([getRecord(id), getCatalog(), getCurrentUser()]);
  if (!data) notFound();

  // A converted lead is a learner now — bounce to the learner page unless
  // the caller explicitly asked to view the lead-side of the record.
  if (data.isLearner && sp.asLead !== "1") {
    redirect(`/learners/${data.lead.partyId}`);
  }

  const lead = data.lead;
  const attrs = lead.attributes ?? {};
  const canWriteLead   = me?.permissions.includes("leads.write")    ?? false;
  const canDeleteLead  = me?.permissions.includes("leads.delete")   ?? false;
  // Once a lead has been converted to a learner, the lead-side automations
  // (NBA, scoring, outreach drafts, "Convert to learner") aren't applicable
  // any more — we're only viewing the historical lead record. Gate every
  // such control on `!isConverted`.
  const isConverted    = !!data.isLearner;
  const canConvert     = !isConverted && (me?.permissions.includes("leads.write") ?? false);
  const canRunAgents   = !isConverted && (me?.permissions.includes("agents.run")  ?? false);
  const canDecideApproval = me?.permissions.includes("agents.run")  ?? false;
  const canSendMessage    = me?.permissions.includes("messaging.send") ?? false;
  const canUploadMedia    = me?.permissions.includes("media.upload") ?? false;
  const canManageMedia    = me?.permissions.includes("media.manage") ?? false;
  const sourceKey = (lead as { leadSource?: string | null }).leadSource ?? null;
  const advisorId = (lead as { advisorId?: string | null }).advisorId ?? null;

  const programOptions    = catalog.programs.map((p) => ({ value: p.id, label: p.name }));
  const sourceOptions     = catalog.sources.map((s) => ({ value: s.key, label: s.label }));
  const advisorOptions    = catalog.advisors.map((a) => ({ value: a.id, label: a.name }));
  const leadStatusOptions = (catalog.leadStatuses ?? []).map((s) => ({ value: s.key, label: s.label }));
  // When source changes, also write the human label so dropdown text persists.
  const sourceExtraByValue = Object.fromEntries(
    catalog.sources.map((s) => [s.key, { sourceLabel: s.label }]),
  );

  const leadForEdit: LeadEditable = {
    name: lead.name,
    email: attrs.email ?? null,
    phone: attrs.phone ?? null,
    phoneCountryCode: attrs.phoneCountryCode ?? null,
    timeZone: attrs.timeZone ?? null,
    deliveryMode: attrs.deliveryMode ?? null,
    leadStatus: attrs.leadStatus ?? null,
    city: attrs.city ?? lead.city ?? null,
    programId: lead.programId,
    programName: lead.program,
    source: sourceKey,
    sourceLabel: attrs.source ?? null,
    advisorId,
    advisorName: attrs.advisor ?? null,
    value: lead.value,
    description: attrs.description ?? null,
    feePaid: attrs.feePaid ?? null,
    feeDue: attrs.feeDue ?? null,
    dueDate: attrs.dueDate ?? null,
    registeredDate: attrs.registeredDate ?? null,
    nextFollowupAt: attrs.nextFollowupAt ?? null,
    demoAttendedAt: attrs.demoAttendedAt ?? null,
    visitedDate:    attrs.visitedDate    ?? null,
    visitingDate:   attrs.visitingDate   ?? null,
    paymentProofUrl: attrs.paymentProofUrl ?? null,
    score: lead.score,
    heat: lead.heat,
    rating: lead.rating,
    nbaLabel: lead.nbaLabel,
  };
  const recordSignals = attrs.signals ?? [];
  const agentsOnLead = attrs.agentsOnLead ?? [];
  const nbaCard = attrs.nbaCard;

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
        centerSlot={
          <div className="flex items-center gap-3">
            <GlobalLeadSearch currentNumber={lead.number} />
            <LeadNavArrows currentNumber={lead.number} />
          </div>
        }
        status={isConverted ? "Converted to learner" : "Agent watching"}
      />

      <div
        className="grid"
        style={{ gridTemplateColumns: "1.7fr 1fr", minHeight: "calc(100vh - 49px)" }}
      >
        {/* MAIN */}
        <div className="border-r border-rule px-9 pb-[60px] pt-7">
          {!canWriteLead && (
            <div className="mb-5 flex items-start gap-3 rounded-[10px] border border-state-amber/30 bg-state-amber/5 px-3 py-2.5 text-[12.5px] text-ink2">
              <Icon name="info" size={14} strokeWidth={2} className="mt-0.5 flex-shrink-0 text-state-amber" />
              <span>
                <b className="font-semibold">Read-only.</b>{" "}
                You can view this lead but not edit fields, run agents, or convert.
                Ask an admin for the <span className="font-mono">leads.write</span> permission.
              </span>
            </div>
          )}
          {/* HERO */}
          <div className="mb-6 flex items-start gap-[18px]">
            <div className={cn("flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-[18px] text-[24px] font-bold text-white", avatarGradClass[lead.avatar])}>
              {lead.initials}
            </div>
            <div className="min-w-0">
              <InlineLeadField
                leadNumber={lead.number}
                field="name"
                ariaLabel="Lead name"
                kind={{ kind: "text", value: lead.name }}
                required
                className="-ml-2 block px-2 py-0.5"
                valueClass="font-serif text-[38px] font-normal leading-none tracking-[-.01em]"
              />
              <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[11px] tracking-[.06em] text-mute">
                <InlineLeadField
                  leadNumber={lead.number}
                  field="rating"
                  ariaLabel="Lead rating"
                  kind={{ kind: "rating", value: lead.rating }}
                />
                <span className="font-mono text-[11px] tracking-[.06em]">{lead.number}</span>
                <span>·</span>
                <InlineLeadField
                  leadNumber={lead.number}
                  field="deliveryMode"
                  ariaLabel="Delivery mode"
                  kind={{ kind: "select", value: attrs.deliveryMode ?? null, options: DELIVERY_MODE_OPTIONS, placeholder: "— mode —" }}
                  idleStyle={{ kind: "select-label", options: DELIVERY_MODE_OPTIONS }}
                  valueClass="font-sans text-[12px] normal-case tracking-normal text-mute"
                />
                <span>·</span>
                <InlineLeadField
                  leadNumber={lead.number}
                  field="timeZone"
                  ariaLabel="Time zone"
                  kind={{ kind: "select", value: attrs.timeZone ?? "Asia/Kolkata", options: TIMEZONE_OPTIONS, placeholder: "— pick a tz —" }}
                  idleStyle={{ kind: "select-label", options: TIMEZONE_OPTIONS }}
                  valueClass="font-sans text-[12px] normal-case tracking-normal text-mute"
                />
              </div>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {canRunAgents && (
                <AgentActions
                  leadNumber={lead.number}
                  hasPendingApproval={!!data.approval}
                />
              )}
              {canConvert && (
                <ConvertButton
                  leadNumber={lead.number}
                  leadName={lead.name}
                  programId={lead.programId}
                />
              )}
              {/* Share-to-Slack and Delete are only meaningful while the
                  record is still an active lead — once converted to a
                  learner, Slack outreach goes via the learner page and the
                  lead row is preserved for audit. */}
              {!isConverted && (
                <ShareToSlackButton surface="leads" recordId={lead.number} />
              )}
              {!isConverted && canSendMessage && (
                <SendMessageButton
                  leadNumber={lead.number}
                  leadPhone={composeE164(attrs.phoneCountryCode ?? null, attrs.phone ?? null)}
                  canUpload={canUploadMedia}
                  canAddToLibrary={canManageMedia}
                />
              )}
              {!isConverted && canDeleteLead && (
                <DeleteLeadButton leadNumber={lead.number} leadName={lead.name} />
              )}
            </div>
          </div>

          {data.approval && (
            <ApprovalCard approval={data.approval} canDecide={canDecideApproval} />
          )}

          {/* NBA — only meaningful while the person is still a lead. Once
              they're a learner the funnel is over, so hide it. */}
          {!isConverted && (
            <NbaCard
              leadNumber={lead.number}
              fallbackLabel={lead.nbaLabel}
              fallbackReason={lead.scoreReason ?? null}
              nbaCard={nbaCard ? { confidence: nbaCard.confidence ?? null, headline: nbaCard.headline, why: nbaCard.why } : null}
              nbaIcon={lead.nbaIcon}
              canRefresh={canRunAgents}
            />
          )}

          {isConverted && (
            <div className="mb-6 flex items-start gap-3 rounded-[12px] border border-rule bg-warm/40 px-4 py-3 text-[13px] text-ink2">
              <Icon name="info" size={14} strokeWidth={2} className="mt-0.5 flex-shrink-0 text-brand-violet" />
              <div>
                <b className="font-semibold text-ink">This lead has been converted to a learner.</b>{" "}
                Scoring, NBA and outreach automations no longer run.{" "}
                <Link href={`/learners/${lead.partyId}`} className="font-semibold text-brand-violet hover:underline">
                  Open learner record →
                </Link>
              </div>
            </div>
          )}

          {/* Timeline / Emails / Notes — interactive tabs */}
          <TimelineTabs
            leadNumber={lead.number}
            timeline={data.timeline}
            partyId={lead.partyId}
            hasPhone={!!composeE164(attrs.phoneCountryCode ?? null, attrs.phone ?? null)}
            canSendMessage={canSendMessage}
          />
        </div>

        {/* ASIDE */}
        <aside className="bg-warm px-[26px] pb-[60px] pt-6">
          {/* AI score — hidden once the lead is a learner. The score is
              frozen at conversion time and no agent is going to update it. */}
          {!isConverted && (
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
              <div className="min-w-0">
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
                <div className="mt-2 flex items-center gap-2 text-[11px] text-mute">
                  <span>Override score:</span>
                  <InlineLeadField
                    leadNumber={lead.number}
                    field="score"
                    ariaLabel="Score"
                    kind={{ kind: "number", value: lead.score, min: 0, max: 100 }}
                    valueClass="font-mono"
                  />
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
          )}

          {/* Lead details — every value is inline-editable. */}
          <div className="acard mb-3.5">
            <H4 right={canWriteLead ? <EditLeadButton leadNumber={lead.number} lead={leadForEdit} /> : null}>
              Lead details
            </H4>

            <DetailRow label="Email">
              <InlineLeadField
                leadNumber={lead.number}
                field="email"
                ariaLabel="Email"
                kind={{ kind: "email", value: attrs.email ?? null }}
                idleStyle={{ kind: "mailto" }}
                valueClass="text-[13px] font-semibold"
              />
            </DetailRow>
            <DetailRow label="Phone CC">
              <PhoneCodeField
                leadNumber={lead.number}
                value={attrs.phoneCountryCode ?? null}
                valueClass="text-[13px] font-semibold text-ink"
              />
            </DetailRow>
            <DetailRow label="Phone">
              <PhoneField
                leadNumber={lead.number}
                countryCode={attrs.phoneCountryCode ?? null}
                number={attrs.phone ?? null}
                valueClass="text-[13px] font-semibold text-ink"
              />
            </DetailRow>
            <DetailRow label="City">
              <InlineLeadField
                leadNumber={lead.number}
                field="city"
                ariaLabel="City"
                kind={{ kind: "text", value: attrs.city ?? lead.city ?? null }}
                valueClass="text-[13px] font-semibold text-ink"
              />
            </DetailRow>
            <DetailRow label="Program">
              <InlineLeadField
                leadNumber={lead.number}
                field="programId"
                ariaLabel="Program"
                kind={{ kind: "select", value: lead.programId, options: programOptions, placeholder: "— pick a program —" }}
                idleStyle={{ kind: "select-label", options: programOptions }}
                valueClass="text-[13px] font-semibold text-ink"
              />
            </DetailRow>
            <DetailRow label="Source">
              <InlineLeadField
                leadNumber={lead.number}
                field="source"
                ariaLabel="Source"
                kind={{ kind: "select", value: sourceKey, options: sourceOptions }}
                idleStyle={{ kind: "select-label", options: sourceOptions }}
                extraByValue={sourceExtraByValue}
                valueClass="text-[13px] font-semibold text-ink"
              />
            </DetailRow>
            <DetailRow label="Lead status">
              <InlineLeadField
                leadNumber={lead.number}
                field="leadStatus"
                ariaLabel="Lead status"
                kind={{ kind: "select", value: attrs.leadStatus ?? null, options: leadStatusOptions, placeholder: "— none —" }}
                idleStyle={{ kind: "select-label", options: leadStatusOptions }}
                valueClass="text-[13px] font-semibold text-ink"
              />
            </DetailRow>
            <DetailRow label="Advisor">
              <InlineLeadField
                leadNumber={lead.number}
                field="advisorId"
                ariaLabel="Advisor"
                kind={{ kind: "select", value: advisorId, options: advisorOptions, placeholder: "— auto-assign —" }}
                idleStyle={{ kind: "select-label", options: advisorOptions }}
                valueClass="text-[13px] font-semibold text-ink"
              />
            </DetailRow>
            <DetailRow label="Price quoted">
              <InlineLeadField
                leadNumber={lead.number}
                field="value"
                ariaLabel="Price quoted"
                kind={{ kind: "money", value: lead.value ?? null }}
                valueClass="font-mono text-[13px] font-semibold text-ink"
              />
            </DetailRow>
            <DetailRow label="Next follow-up">
              <InlineLeadField
                leadNumber={lead.number}
                field="nextFollowupAt"
                ariaLabel="Next follow-up date"
                kind={{ kind: "date", value: attrs.nextFollowupAt ?? null }}
                valueClass="font-mono text-[13px] text-ink2"
              />
            </DetailRow>
            <DetailRow label="Lead created">
              <span className="font-mono text-[13px] text-mute" title={lead.createdAt ?? ""}>
                {lead.createdAt
                  ? new Date(lead.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
                  : "—"}
              </span>
            </DetailRow>
            <DetailRow label="Demo attended">
              <InlineLeadField
                leadNumber={lead.number}
                field="demoAttendedAt"
                ariaLabel="Demo attended date"
                kind={{ kind: "date", value: attrs.demoAttendedAt ?? null }}
                valueClass="font-mono text-[13px] text-ink2"
              />
            </DetailRow>
            <DetailRow label="Visited">
              <InlineLeadField
                leadNumber={lead.number}
                field="visitedDate"
                ariaLabel="Visited date"
                kind={{ kind: "date", value: attrs.visitedDate ?? null }}
                valueClass="font-mono text-[13px] text-ink2"
              />
            </DetailRow>
            <DetailRow label="Visiting">
              <InlineLeadField
                leadNumber={lead.number}
                field="visitingDate"
                ariaLabel="Visiting date"
                kind={{ kind: "date", value: attrs.visitingDate ?? null }}
                valueClass="font-mono text-[13px] text-ink2"
              />
            </DetailRow>
          </div>

          {/* Description — inline editable textarea, click anywhere on the text. */}
          <div className="acard mb-3.5">
            <H4>Description</H4>
            <InlineLeadField
              leadNumber={lead.number}
              field="description"
              ariaLabel="Description"
              kind={{
                kind: "textarea",
                value: attrs.description ?? null,
                placeholder: "Click to add context — what did the lead say in the last call? What objections came up?",
                minRows: 4,
              }}
              className="block w-full px-2 py-1.5"
              valueClass="whitespace-pre-line text-[13px] leading-[1.55] text-ink2"
            />
          </div>

          {/* Payment — every cell editable. */}
          <div className="acard mb-3.5">
            <H4>Payment</H4>
            <DetailRow label="Fee paid">
              <InlineLeadField
                leadNumber={lead.number}
                field="feePaid"
                ariaLabel="Fee paid"
                kind={{ kind: "money", value: attrs.feePaid ?? null }}
                valueClass="font-mono text-[13px] text-ink2"
              />
            </DetailRow>
            <DetailRow label="Fee due">
              <InlineLeadField
                leadNumber={lead.number}
                field="feeDue"
                ariaLabel="Fee due"
                kind={{ kind: "money", value: attrs.feeDue ?? null }}
                valueClass="font-mono text-[13px] text-ink2"
              />
            </DetailRow>
            <DetailRow label="Registered">
              <InlineLeadField
                leadNumber={lead.number}
                field="registeredDate"
                ariaLabel="Registered date"
                kind={{ kind: "date", value: attrs.registeredDate ?? null }}
                valueClass="font-mono text-[13px] text-ink2"
              />
            </DetailRow>
            <DetailRow label="Due date">
              <InlineLeadField
                leadNumber={lead.number}
                field="dueDate"
                ariaLabel="Due date"
                kind={{ kind: "date", value: attrs.dueDate ?? null }}
                valueClass="font-mono text-[13px] text-ink2"
              />
            </DetailRow>
            <DetailRow label="Proof">
              <InlineLeadField
                leadNumber={lead.number}
                field="paymentProofUrl"
                ariaLabel="Payment proof URL"
                kind={{ kind: "url", value: attrs.paymentProofUrl ?? null }}
                idleStyle={{ kind: "url", linkLabel: "View screenshot →" }}
                valueClass="text-[13px] font-semibold"
              />
            </DetailRow>
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

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-dashed border-rule py-[9px] text-[13px] last:border-b-0">
      <span className="font-medium text-mute">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

// Build a bare-E.164 phone string from the split (countryCode, number) that
// the record page exposes. Returns null when either half is missing so the
// SendMessageButton renders disabled with an explanatory tooltip.
function composeE164(cc: string | null, phone: string | null): string | null {
  const c = (cc ?? "").trim();
  const p = (phone ?? "").replace(/\D/g, "");
  if (!p) return null;
  if (!c) return `+${p}`;
  const ccDigits = c.replace(/\D/g, "");
  return ccDigits ? `+${ccDigits}${p}` : `+${p}`;
}
