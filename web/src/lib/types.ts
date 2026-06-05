// Types shared between API responses and components. Kept narrow.

export type Stage = "new" | "qual" | "demo" | "neg" | "won";
export type Heat = "hot" | "warm" | "cold";
export type AvatarGrad = "magenta" | "violet" | "blue" | "ochre" | "ok" | "mute" | "vm";
export type NbaIcon = "send" | "clock" | "mail" | "star" | "check" | "info" | "money";

export interface Lead {
  id: string;
  number: string;
  name: string;
  initials: string;
  city: string;
  program: string;
  value: string;
  stage: Stage;
  stageLabel: string;
  score: number;
  heat: Heat;
  avatar: AvatarGrad;
  nbaIcon: NbaIcon;
  nbaLabel: string;
  nbaGhost: boolean;
}

export interface PipelineColumn {
  key: Stage;
  label: string;
  count: number;
  sum: string;
  aiNote: string | null;
  leads: Lead[];
}

export interface AgentCard {
  id: string;
  name: string;
  status: string;
  target: string | null;
  metricLabel: string;
  metricValue: string;
  rightPill: string;
  glyph: AvatarGrad;
  iconKey: "spark" | "star" | "clock" | "chart";
  live: boolean;
  desc: string;
}

export interface FeedItem {
  id: string;
  actorType: string;
  actorName: string;
  verb: string;
  detail: string;
  tag: "auto" | "sent" | "need";
  iconKey: "spark" | "star" | "clock" | "mail";
  iconBg: string;
  iconStroke: string;
  payload: { subject?: string; verbAfter?: string | null };
  ts: string;
  workItemNumber: string | null;
}

export interface RecentRun {
  label: string;
  status: "run" | "done" | "wait";
}

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: string;
  initials: string;
}

export interface Program {
  id: string;
  name: string;
  track: string | null;
  price: string | null;
  enabled: boolean;
  leadCount: number;
  courseCount: number;
  batchCount: number;
  enrolmentCount: number;
}

export interface Course {
  id: string;
  name: string;
  code: string | null;
  enabled: boolean;
  programId: string;
  programName: string;
  programEnabled: boolean;
  batchCount: number;
  runningBatchCount: number;
  activeLearners: number;
}

export interface CourseInput {
  programId: string;
  name: string;
  code?: string | null;
  enabled?: boolean;
}

export type BatchStatus = "upcoming" | "running" | "completed" | "cancelled";
export type BatchSlot   = "morning" | "afternoon" | "evening";

export interface Batch {
  id: string;
  name: string;
  code: string | null;
  slot: BatchSlot | null;
  timeLabel: string | null;
  schedule: string | null;
  startDate: string | null;
  endDate: string | null;
  seats: number | null;
  status: BatchStatus;
  enabled: boolean;
  // Course is the canonical parent of a batch; program is denormalized for labels.
  courseId: string | null;
  courseName: string | null;
  courseCode: string | null;
  courseEnabled: boolean | null;
  programId: string | null;
  programName: string | null;
  programEnabled: boolean | null;
  enrolmentCount: number;
  activeCount: number;
}

export type EnrolmentStatus = "active" | "completed" | "dropped" | "deferred";

export interface LearnerSummary {
  partyId: string;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  attributes: { initials?: string };
  learnerSince: string;
  totalCourses: number;
  activeCourses: number;
  totalBatches: number;
  activeBatches: number;
  primaryEnrolment: {
    id: string;
    programId: string;
    programName: string;
    status: EnrolmentStatus;
  } | null;
}

export interface CourseAssignment {
  id: string;
  status: EnrolmentStatus;
  assignedAt: string;
  enrolmentId: string;
  courseId: string;
  courseName: string;
  courseCode: string | null;
  programId: string;
  programName: string;
}

export interface ProgramEnrolment {
  id: string;
  status: EnrolmentStatus;
  pricePaid: string | null;
  enrolledAt: string;
  programId: string;
  programName: string;
  programPrice: string | null;
}

export interface BatchAssignment {
  id: string;
  status: EnrolmentStatus;
  assignedAt: string;
  enrolmentId: string;
  courseAssignmentId: string | null;
  cohortId: string;
  cohortName: string;
  cohortCode: string | null;
  slot: BatchSlot | null;
  timeLabel: string | null;
  schedule: string | null;
  startDate: string | null;
  endDate: string | null;
  batchStatus: BatchStatus;
  courseId: string;
  courseName: string;
  courseCode: string | null;
  programId: string;
  programName: string;
}

export interface LearnerRecord {
  party: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    city: string | null;
    attributes: { initials?: string };
    learnerSince: string;
    leadSince: string | null;
  };
  enrolments: ProgramEnrolment[];
  courseAssignments: CourseAssignment[];
  assignments: BatchAssignment[];
  timeline: TimelineRow[];
  originLead: { number: string; workItemId: string; score: number; heat: Heat } | null;
}

export interface BatchInput {
  courseId: string;
  name: string;
  code?: string | null;
  slot?: BatchSlot | null;
  timeLabel?: string | null;
  schedule?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  seats?: number | null;
  status?: BatchStatus;
  enabled?: boolean;
}

export interface CatalogResponse {
  programs: { id: string; name: string; track: string | null; price: string | null }[];
  courses: { id: string; name: string; code: string | null; programId: string; programName: string }[];
  advisors: { id: string; name: string; email: string; role: string }[];
  sources: { key: string; label: string }[];
}

export interface CreateLeadInput {
  name: string;
  email?: string;
  phone?: string;
  city?: string;
  program?: string;
  value?: string;
  source?: string;
  sourceLabel?: string;
  stage?: Stage;
  score?: number;
  heat?: Heat;
  nbaLabel?: string;
  nbaIcon?: string;
  advisorId?: string;
}

export interface SummaryResponse {
  overall: {
    total: number;
    hot: number;
    warm: number;
    cold: number;
    hotOvernight: number;
    pendingApprovals: number;
    liveAgents: number;
  };
  byStage: { stage: Stage; count: number; deal_value_sum: string | null }[];
}

export interface RecordResponse {
  lead: Lead & {
    partyId: string;
    programId: string | null;
    scoreReason: string | null;
    attributes: {
      stageLabel?: string;
      email?: string | null;
      phone?: string | null;
      city?: string | null;
      source?: string | null;
      advisor?: string | null;
      scoreLabel?: string | null;
      scoreDesc?: string | null;
      description?: string | null;
      feePaid?: string | null;
      feeDue?: string | null;
      dueDate?: string | null;
      registeredDate?: string | null;
      paymentProofUrl?: string | null;
      signals?: { text: string; weight: string; kind: "pos" | "neg" | "neu" }[];
      nbaCard?: { confidence: number; headline: string; why: string } | null;
      agentsOnLead?: { name: string; status: string; glyph: AvatarGrad; icon: "spark" | "star" | "clock"; badge: { label: string; kind: "done" | "run" } }[];
    };
  };
  timeline: TimelineRow[];
  approval: { id: string; actionType: string; mode: string; status: string; proposed: unknown } | null;
  isLearner: boolean;
}

export interface TimelineRow {
  id?: string;
  actorType: string;
  actorName: string;
  verb: string;
  detail: string;
  tag: "ai" | "you";
  payload: {
    when?: string;
    quote?: string | null;
    kind?: string;
    edits?: { at: string; previous: string }[];
  };
  ts: string;
}
