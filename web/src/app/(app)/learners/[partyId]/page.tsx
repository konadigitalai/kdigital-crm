import Link from "next/link";
import { notFound } from "next/navigation";
import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
import { getLearner } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { cn } from "@/lib/cn";
import type {
  BatchAssignment, BatchSlot, BatchStatus, CourseAssignment, EnrolmentStatus, ProgramEnrolment,
} from "@/lib/types";
import { AssignBatchButton, EnrolmentStatusMenu } from "@/components/learner/AssignBatchDialog";
import { AddCourseButton } from "@/components/learner/AddCourseDialog";
import { CourseStatusBadgeClient } from "@/components/learner/CourseStatusBadge";
import { ShareToSlackButton } from "@/components/share/ShareToSlackButton";

const BATCH_STATUS_CLS: Record<BatchStatus, string> = {
  upcoming:  "bg-[rgba(31,63,207,.08)]  text-brand-blue",
  running:   "bg-[rgba(46,158,106,.10)] text-state-ok",
  completed: "bg-warm2                  text-mute",
  cancelled: "bg-[rgba(217,83,79,.10)]  text-state-warn",
};

const SLOT_LABEL: Record<BatchSlot, string> = {
  morning:   "Morning",
  afternoon: "Afternoon",
  evening:   "Evening",
};

export default async function LearnerRecordPage({ params }: { params: Promise<{ partyId: string }> }) {
  await requirePagePermission("learners.read");
  const { partyId } = await params;
  const data = await getLearner(partyId);
  if (!data) notFound();

  const { party, enrolments, courseAssignments, assignments, timeline, originLead } = data;
  const initials = party.attributes?.initials ?? party.name.slice(0, 2).toUpperCase();

  // Group: program → its course-assignments → batches under each
  type ProgramGroup = {
    enrolment: ProgramEnrolment;
    courses: { assignment: CourseAssignment; batches: BatchAssignment[] }[];
    looseBatches: BatchAssignment[]; // legacy / unattached batch_assignments (shouldn't exist in new model)
  };
  const groups = new Map<string, ProgramGroup>();
  for (const e of enrolments) {
    groups.set(e.programId, { enrolment: e, courses: [], looseBatches: [] });
  }
  for (const ca of courseAssignments) {
    const g = groups.get(ca.programId);
    if (g) g.courses.push({ assignment: ca, batches: [] });
  }
  for (const ba of assignments) {
    const g = groups.get(ba.programId);
    if (!g) continue;
    if (ba.courseAssignmentId) {
      const cc = g.courses.find((c) => c.assignment.id === ba.courseAssignmentId);
      if (cc) cc.batches.push(ba);
      else g.looseBatches.push(ba);
    } else {
      // legacy: batch with no course_assignment_id (shouldn't happen now)
      g.looseBatches.push(ba);
    }
  }
  const allCourseIds = new Set(courseAssignments.map((ca) => ca.courseId));

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/learners" className="cursor-pointer hover:text-ink">Learners</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">{party.name}</b>
          </>
        }
        status="Learner"
      />

      <div className="grid" style={{ gridTemplateColumns: "1.7fr 1fr", minHeight: "calc(100vh - 49px)" }}>
        <div className="border-r border-rule px-9 pb-[60px] pt-7">
          <div className="mb-6 flex items-start gap-[18px]">
            <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-[18px] bg-grad-violet text-[24px] font-bold text-white">
              {initials.slice(0, 2)}
            </div>
            <div>
              <h1 className="font-serif text-[38px] font-normal leading-none tracking-[-.01em]">{party.name}</h1>
              <div className="mt-2 flex items-center gap-3 font-mono text-[11px] tracking-[.06em] text-mute">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-grad-soft px-2.5 py-1 font-sans text-[11.5px] font-semibold normal-case tracking-normal text-brand-violet">
                  <span className="h-1.5 w-1.5 rounded-full bg-brand-violet" />
                  Learner
                </span>
                {party.city && <span>{party.city}</span>}
                {originLead && (
                  <>
                    <span>·</span>
                    <Link href={`/records/${originLead.number}`} className="hover:text-ink">
                      from {originLead.number}
                    </Link>
                  </>
                )}
              </div>
            </div>
            <div className="ml-auto flex gap-2">
              <button className="btn"><Icon name="mail" size={14} strokeWidth={2} />Email</button>
              <button className="btn"><Icon name="clock" size={14} strokeWidth={2} />Schedule</button>
              <ShareToSlackButton surface="learners" recordId={partyId} />
            </div>
          </div>

          {[...groups.values()].length === 0 ? (
            <div className="rounded-2xl border border-dashed border-rule p-10 text-center text-[13px] text-mute">
              No programs yet.
            </div>
          ) : (
            [...groups.values()].map((g) => (
              <div key={g.enrolment.programId} className="mb-8 rounded-[18px] border border-rule bg-paper">
                {/* Program header */}
                <div className="flex items-start gap-4 border-b border-rule p-5">
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-[14px] bg-grad text-white">
                    <Icon name="stamp" size={22} strokeWidth={1.7} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="mono-cap text-[10px] font-semibold tracking-[.14em] text-brand-violet">Program</div>
                    <div className="mt-0.5 text-[18px] font-bold tracking-[-.005em]">{g.enrolment.programName}</div>
                    <div className="mt-1 flex items-center gap-3 text-[12px] text-mute">
                      <span>Enrolled {fmtDate(g.enrolment.enrolledAt)}</span>
                      {g.enrolment.pricePaid && <span>· ₹{Number(g.enrolment.pricePaid).toLocaleString("en-IN")}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn("mono-cap inline-flex items-center rounded-full px-2 py-0.5 text-[9.5px] font-semibold",
                      g.enrolment.status === "active"
                        ? "bg-[rgba(46,158,106,.10)] text-state-ok"
                        : "bg-warm2 text-mute"
                    )}>
                      {g.enrolment.status}
                    </span>
                    <AddCourseButton
                      partyId={party.id}
                      alreadyAssignedCourseIds={[...allCourseIds]}
                      label="Add courses"
                    />
                  </div>
                </div>

                {/* Courses inside the program */}
                {g.courses.length === 0 ? (
                  <div className="px-5 py-8 text-center text-[12.5px] text-mute">
                    No courses assigned yet. Click "Add courses" to start.
                  </div>
                ) : (
                  <div className="divide-y divide-rule">
                    {g.courses.map((c) => {
                      const enrolledCohortIds = c.batches.map((b) => b.cohortId);
                      return (
                        <div key={c.assignment.id} className="p-5">
                          <div className="mb-3 flex items-center gap-2">
                            <div className="mono-cap text-[10px] font-semibold tracking-[.14em] text-mute">Course</div>
                            <div className="text-[14px] font-semibold tracking-[-.005em]">{c.assignment.courseName}</div>
                            {c.assignment.courseCode && (
                              <span className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[9px] font-semibold text-mute">
                                {c.assignment.courseCode}
                              </span>
                            )}
                            <span className="ml-2 font-mono text-[10px] text-mute">
                              {c.batches.length} batch{c.batches.length === 1 ? "" : "es"}
                            </span>
                            <div className="ml-auto flex items-center gap-2">
                              <CourseStatusBadge partyId={party.id} courseAssignmentId={c.assignment.id} current={c.assignment.status} />
                              <AssignBatchButton
                                partyId={party.id}
                                courseId={c.assignment.courseId}
                                courseName={c.assignment.courseName}
                                alreadyEnrolledCohortIds={enrolledCohortIds}
                                variant="ghost"
                                label="+ Assign batch"
                              />
                            </div>
                          </div>

                          {c.batches.length === 0 ? (
                            <div className="rounded-[10px] border border-dashed border-rule p-3 text-center text-[12px] text-mute">
                              No batch assigned in this course yet.
                            </div>
                          ) : (
                            <div className="flex flex-col gap-2">
                              {c.batches.map((a) => (
                                <div key={a.id} className="flex items-start gap-3 rounded-[12px] border border-rule bg-warm/30 p-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="text-[13.5px] font-semibold tracking-[-.005em]">{a.cohortName}</div>
                                    <div className="mono-cap mt-0.5 text-[10px] tracking-[.04em] text-mute">
                                      {[
                                        a.cohortCode,
                                        a.slot ? SLOT_LABEL[a.slot] : null,
                                        a.timeLabel,
                                        a.schedule,
                                      ].filter(Boolean).join(" · ")}
                                    </div>
                                    {(a.startDate || a.endDate) && (
                                      <div className="mt-1 text-[11.5px] text-ink2">
                                        {a.startDate ? fmtDate(a.startDate) : "—"} → {a.endDate ? fmtDate(a.endDate) : "open-ended"}
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex flex-col items-end gap-1.5">
                                    <span className={cn("mono-cap inline-flex items-center rounded-full px-2 py-0.5 text-[9.5px] font-semibold", BATCH_STATUS_CLS[a.batchStatus])}>
                                      {a.batchStatus}
                                    </span>
                                    <EnrolmentStatusMenu partyId={party.id} enrolmentId={a.id} current={a.status} />
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))
          )}

          {/* Timeline */}
          <div className="mb-5 mt-10 flex items-center gap-[9px]">
            <span className="h-[1.5px] w-[18px] bg-brand-violet" />
            <span className="mono-cap text-[11px] font-semibold tracking-[.16em] text-brand-violet">Timeline</span>
          </div>
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
        </div>

        <aside className="bg-warm px-[26px] pb-[60px] pt-6">
          <div className="acard mb-3.5">
            <H4>Learner details</H4>
            <Field k="Email"  v={party.email}  link={!!party.email} />
            <Field k="Phone"  v={party.phone} />
            <Field k="City"   v={party.city} />
            <Field k="Joined" v={fmtDate(party.learnerSince)} />
            {party.leadSince && <Field k="First seen" v={fmtDate(party.leadSince)} />}
          </div>

          {originLead && (
            <div className="acard mb-3.5">
              <H4>Origin</H4>
              <Field k="Lead number" v={originLead.number} />
              <Field k="Score"       v={String(originLead.score)} />
              <Field k="Heat"        v={originLead.heat} />
              <Link href={`/records/${originLead.number}`} className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand-violet">
                View lead record →
              </Link>
            </div>
          )}

          <div className="acard">
            <H4>Stats</H4>
            <Field k="Programs"       v={String(enrolments.length)} />
            <Field k="Courses"        v={String(courseAssignments.length)} />
            <Field k="Active batches" v={String(assignments.filter((a) => a.status === "active").length)} />
            <Field k="Total batches"  v={String(assignments.length)} />
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

function H4({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mono-cap mb-3.5 flex items-center justify-between text-[10px] font-semibold tracking-[.14em] text-mute">
      <span>{children}</span>
      {right}
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

function CourseStatusBadge({ partyId, courseAssignmentId, current }: {
  partyId: string; courseAssignmentId: string; current: EnrolmentStatus;
}) {
  return <CourseStatusBadgeClient partyId={partyId} courseAssignmentId={courseAssignmentId} current={current} />;
}
