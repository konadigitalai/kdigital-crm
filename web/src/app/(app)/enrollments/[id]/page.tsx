import Link from "next/link";
import { notFound } from "next/navigation";
import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
import { getEnrollment } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { cn } from "@/lib/cn";
import { EnrollmentFeeLedger } from "@/components/enrollment/EnrollmentFeeLedger";
import { EnrollmentActions } from "@/components/enrollment/EnrollmentActions";
import { PaymentHealthBadge } from "@/components/enrollment/PaymentHealthBadge";
import { TimelineTabs } from "@/components/record/TimelineTabs";
import { ShareToSlackButton } from "@/components/share/ShareToSlackButton";

// Enrollment record — mirrors the learner record layout. The enrolment persists
// across the lead → enrolled → learner workflow, so this page renders whether
// the party is still 'enrolled' or already a 'learner'.
export default async function EnrollmentRecordPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission("learners.read");
  const { id } = await params;
  const data = await getEnrollment(id);
  if (!data) notFound();

  const { enrolment, party, programName, timeline, originLead } = data;
  const isLearner = party.role === "learner";
  const initials = party.attributes?.initials ?? party.name.slice(0, 2).toUpperCase();

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/enrollments" className="cursor-pointer hover:text-ink">Enrollments</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">{party.name}</b>
          </>
        }
        status={isLearner ? "Learner" : "Enrolled"}
      />

      <div className="grid" style={{ gridTemplateColumns: "1.7fr 1fr", minHeight: "calc(100vh - 49px)" }}>
        <div className="border-r border-rule px-9 pb-[60px] pt-7">
          <div className="mb-6 flex items-start gap-[18px]">
            <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-[18px] bg-grad-violet text-[24px] font-bold text-white">
              {initials.slice(0, 2)}
            </div>
            <div>
              <h1 className="font-serif text-[38px] font-normal leading-none tracking-[-.01em]">{party.name}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[11px] tracking-[.06em] text-mute">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-grad-soft px-2.5 py-1 font-sans text-[11.5px] font-semibold normal-case tracking-normal text-brand-violet">
                  <span className="h-1.5 w-1.5 rounded-full bg-brand-violet" />
                  {isLearner ? "Learner" : "Enrolled"}
                </span>
                {enrolment.number && <span>{enrolment.number}</span>}
                {party.city && <span>{party.city}</span>}
                {originLead && (
                  <>
                    <span>·</span>
                    <Link href={`/records/${originLead.number}?asLead=1`} className="hover:text-ink">
                      from {originLead.number}
                    </Link>
                  </>
                )}
              </div>
            </div>
            <div className="ml-auto flex gap-2">
              <ShareToSlackButton surface="learners" recordId={party.id} />
            </div>
          </div>

          <EnrollmentActions
            enrolmentId={enrolment.id}
            partyId={party.id}
            paymentVerifiedAt={enrolment.paymentVerifiedAt}
            verifiedByName={enrolment.verifiedByName}
            isLearner={isLearner}
          />

          <EnrollmentFeeLedger
            enrolmentId={enrolment.id}
            initial={{
              feeQuoted:     enrolment.feeQuoted,
              feePaid:       enrolment.feePaid,
              dueDate:       enrolment.dueDate,
              paymentStatus: enrolment.paymentStatus,
              paymentProofs: enrolment.paymentProofs ?? [],
              feeNotes:      enrolment.feeNotes,
            }}
          />

          {/* Activity */}
          <div className="mb-5 mt-10 flex items-center gap-[9px]">
            <span className="h-[1.5px] w-[18px] bg-brand-violet" />
            <span className="mono-cap text-[11px] font-semibold tracking-[.16em] text-brand-violet">Activity</span>
          </div>
          {originLead ? (
            <TimelineTabs leadNumber={originLead.number} timeline={timeline} />
          ) : (
            <div className="tl-rail">
              {timeline.length === 0 && <div className="text-[13px] text-mute">No activity yet.</div>}
              {timeline.map((t, i) => (
                <div key={i} className={cn("tl-node", t.tag === "ai" ? "ai" : "human")}>
                  <div className="mono-cap mb-1.5 text-[10px] tracking-[.08em] text-hint">
                    {t.payload?.when ?? new Date(t.ts).toLocaleString()}
                  </div>
                  <div className="rounded-[13px] border border-rule bg-paper p-[15px_17px]">
                    <div className="mb-[7px] flex items-center gap-2.5">
                      <span className="text-[13px] font-bold tracking-[-.005em]">{t.actorName}</span>
                      <span className={cn("mono-cap rounded-full px-2 py-0.5 text-[8.5px] font-semibold tracking-[.08em]", t.tag === "ai" ? "bg-[rgba(107,31,184,.10)] text-brand-violet" : "bg-[rgba(31,63,207,.08)] text-brand-blue")}>
                        {t.verb}
                      </span>
                    </div>
                    <p className="whitespace-pre-line text-[13px] leading-[1.55] text-ink2">{t.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <aside className="bg-warm px-[26px] pb-[60px] pt-6">
          <div className="acard mb-3.5">
            <H4>Enrolment</H4>
            <Field k="Number"  v={enrolment.number} />
            <Field k="Program" v={programName} />
            <FieldNode k="Status">
              <span className={cn("mono-cap inline-flex items-center rounded-full px-2 py-0.5 text-[9.5px] font-semibold",
                enrolment.status === "active"
                  ? "bg-[rgba(46,158,106,.10)] text-state-ok"
                  : enrolment.status === "pending"
                    ? "bg-[rgba(224,138,30,.12)] text-state-amber"
                    : "bg-warm2 text-mute",
              )}>
                {enrolment.status}
              </span>
            </FieldNode>
            <FieldNode k="Payment">
              <PaymentHealthBadge health={enrolment.paymentHealth} />
            </FieldNode>
          </div>

          <div className="acard mb-3.5">
            <H4>Contact</H4>
            <Field k="Email" v={party.email} link={!!party.email} />
            <Field k="Phone" v={party.phone} />
            <Field k="City"  v={party.city} />
          </div>

          <div className="acard">
            <H4>Fee</H4>
            <Field k="Quoted" v={enrolment.feeQuoted == null ? null : `₹${Number(enrolment.feeQuoted).toLocaleString("en-IN")}`} />
            <Field k="Paid"   v={enrolment.feePaid   == null ? null : `₹${Number(enrolment.feePaid).toLocaleString("en-IN")}`} />
            <Field k="Due"    v={enrolment.feeDue    == null ? null : `₹${Number(enrolment.feeDue).toLocaleString("en-IN")}`} />
            <Field k="Due date" v={fmtDate(enrolment.dueDate)} />
          </div>
        </aside>
      </div>
    </>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function H4({ children }: { children: React.ReactNode }) {
  return (
    <div className="mono-cap mb-3.5 flex items-center justify-between text-[10px] font-semibold tracking-[.14em] text-mute">
      <span>{children}</span>
    </div>
  );
}

function Field({ k, v, link }: { k: string; v: string | null; link?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-dashed border-rule py-[9px] text-[13px] last:border-b-0">
      <span className="font-medium text-mute">{k}</span>
      <span className={cn("text-right font-semibold", link ? "text-brand-violet" : "text-ink")}>{v ?? "—"}</span>
    </div>
  );
}

function FieldNode({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-dashed border-rule py-[9px] text-[13px] last:border-b-0">
      <span className="font-medium text-mute">{k}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
