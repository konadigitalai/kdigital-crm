// Types shared between API responses and components. Kept narrow.

export type Stage = "new" | "qual" | "demo" | "neg" | "won";
export type Heat = "hot" | "warm" | "cold";
// Human-set lead rating. Replaces the auto-derived `heat` for UI purposes.
// Also drives the pipeline columns.
export type LeadRating =
  | "new lead"
  | "attempted"
  | "cold"
  | "warm"
  | "hot"
  | "superhot"
  | "enrolled";
export const LEAD_RATINGS: LeadRating[] = [
  "new lead",
  "attempted",
  "cold",
  "warm",
  "hot",
  "superhot",
  "enrolled",
];
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
  rating: LeadRating;
  avatar: AvatarGrad;
  nbaIcon: NbaIcon;
  nbaLabel: string;
  nbaGhost: boolean;
  // Phase H+: cadence dates (also exposed for filtering on /leads).
  nextFollowupAt: string | null;
  demoAttendedAt: string | null;
}

export interface PipelineColumn {
  key: LeadRating;
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
  payload: { subject?: string; verbAfter?: string | null; approvalId?: string | null };
  ts: string;
  workItemNumber: string | null;
}

export interface RecentRun {
  id?: string;
  label: string;
  status: "run" | "done" | "wait";
}

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: string;
  initials: string;
  permissions: string[];
}

// ─── User management ──────────────────────────────────────────────────────

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  active: boolean;
  has_password: boolean;
  groups: { id: string; name: string }[];
  clients: { id: string; name: string; active: boolean }[];
}

export interface UserGroupSummary {
  id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  permissions: string[];
  member_count: number;
}

// ─── Agent catalog ─────────────────────────────────────────────────────────

export type AgentMode = "auto" | "supervised" | "manual";
export type AgentRunStatus = "running" | "completed" | "failed";

export interface AgentRunStep {
  label: string;
  state: "queued" | "active" | "done" | "failed";
  detail?: string;
}

export interface AgentLastRun {
  workItemId: string;
  startedAt: string;
  finishedAt: string | null;
  status: AgentRunStatus;
  target: string | null;
  live: boolean;
  steps: AgentRunStep[];
}

export interface AgentCatalogEntry {
  key: string;
  name: string;
  domain: "sales" | "service";
  operatesOn: string;
  enabled: boolean;
  mode: AgentMode;
  lastRun: AgentLastRun | null;
  runsToday: number;
  status: "live" | "stub";
  capabilities: string[];
  phase: string | null;
  missing: string | null;
}

export interface AgentRunRecord {
  workItemId: string;
  number: string;
  agentKey: string;
  status: AgentRunStatus;
  target: string | null;
  live: boolean;
  steps: AgentRunStep[];
  startedAt: string;
  finishedAt: string | null;
}

// ─── Forecast Agent ────────────────────────────────────────────────────────

export interface ForecastNumbers {
  generatedAt: string;
  totals: {
    activeLeads: number;
    enrolledLast30d: number;
    parsedPipelineINR: number;
    weightedPipelineINR: number;
    collectedFeeINR: number;
    feeDueINR: number;
  };
  ratingFunnel: Array<{ rating: string; count: number; parsedValueINR: number }>;
  byProgram: Array<{
    programId: string;
    programName: string;
    price: number | null;
    leadsByRating: Record<string, number>;
    enrolments: number;
    enrolmentsLast30d: number;
    expectedFromOpenLeadsINR: number;
  }>;
  cohorts: Array<{
    cohortId: string;
    cohortName: string;
    programName: string | null;
    seats: number | null;
    assigned: number;
    startDate: string | null;
    fillPct: number | null;
    status: string;
  }>;
  atRisk: {
    silent7d: number;
    overdueFees: number;
    missingProgram: number;
  };
  topOpenLeads: Array<{
    number: string;
    name: string;
    program: string | null;
    rating: string;
    score: number | null;
    parsedValueINR: number;
    daysSinceLastTouch: number | null;
  }>;
}

export interface ForecastNarrative {
  headline: string;
  healthSummary: string;
  risks: Array<{ title: string; detail: string; severity: "low" | "med" | "high" }>;
  opportunities: Array<{ title: string; detail: string }>;
  priorityLeads: Array<{ leadNumber: string; reason: string }>;
  monthTargetReadout: string;
}

export interface ForecastSnapshot {
  generatedAt: string;
  numbers: ForecastNumbers;
  narrative: ForecastNarrative;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

// ─── Edify chat assistant ──────────────────────────────────────────────────

export type EdifyCitationKind =
  | "lead" | "learner" | "ticket" | "program" | "cohort" | "user" | "agent";

export interface EdifyCitation {
  kind: EdifyCitationKind;
  ref: string;
  label: string;
}

export type EdifySuggestedActionKind =
  | "draft_outreach" | "rescore_lead" | "refresh_nba" | "rescore_all" | "run_forecast";

export interface EdifySuggestedAction {
  action: EdifySuggestedActionKind;
  leadNumber?: string;
  label: string;
  rationale: string;
}

export interface EdifyAnswer {
  messageId: string;
  sessionId: string;
  question: string;
  answer: string;
  citations: EdifyCitation[];
  suggestedAction: EdifySuggestedAction | null;
  askedAt: string;
}

export interface EdifySessionSummary {
  id: string;
  title: string | null;
  createdAt: string;
  lastAt: string;
  messageCount: number;
  preview: string | null;
}

// ─── Phase G: Time tracking, leaves, clients, calendar ─────────────────────

export interface Client {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  active: boolean;
  createdAt: string;
  memberCount?: number;
}

export interface ClientMember {
  id: string;
  name: string | null;
  email: string;
  role: string;
  active: boolean;
}

export interface WorkSession {
  id: string;
  userId?: string;
  date: string;            // YYYY-MM-DD
  clockIn: string;
  clockOut: string | null;
  notes: string | null;
}

export interface TimeBlock {
  id: string;
  sessionId: string | null;
  userId?: string;
  date: string;
  startAt: string;
  endAt: string;
  clientId: string | null;
  clientName: string | null;
  note: string | null;
  billable: boolean;
}

export type LeaveKind = "sick" | "personal" | "vacation" | "wfh" | "holiday";
export type LeaveHalfDay = "full" | "am" | "pm";

export interface LeaveDay {
  id: string;
  userId?: string;
  date: string;
  kind: LeaveKind;
  halfDay: LeaveHalfDay;
  note: string | null;
  createdAt?: string;
}

// One row of the admin timesheet report — pre-aggregated by user × client × day.
export interface TimesheetReportRow {
  userId: string;
  userName: string | null;
  userEmail: string;
  clientId: string | null;
  clientName: string | null;
  date: string;
  mins: number;
  blocks: number;
}

// Returned in 409 bodies from POST / PATCH /timesheets/blocks so the UI can
// show the conflicting block inline.
export interface TimeBlockConflict {
  id: string;
  startAt: string;
  endAt: string;
  clientId: string | null;
  clientName: string | null;
  note: string | null;
}

export type EventRsvp = "pending" | "accepted" | "declined" | "tentative";

export interface CalendarEventSummary {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  organizerId: string;
  organizerName: string | null;
  organizerEmail?: string | null;
  isOrganizer: boolean;
  rsvp: EventRsvp | null;
  respondedAt: string | null;
}

export interface CalendarInvitee {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  rsvp: EventRsvp;
  respondedAt: string | null;
}

export interface CalendarEventDetail {
  event: {
    id: string;
    title: string;
    description: string | null;
    location: string | null;
    startAt: string;
    endAt: string;
    allDay: boolean;
    organizerId: string;
    organizerName: string | null;
  };
  invitees: CalendarInvitee[];
}

export interface GroupsResponse {
  groups: UserGroupSummary[];
  catalog: string[];
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
export type WeekDay     = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

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
  // Phase H — structured trainer assignment + cadence (powers the calendar).
  trainerId:     string | null;
  trainerName:   string | null;
  coTrainerId:   string | null;
  coTrainerName: string | null;
  daysOfWeek:    WeekDay[] | null;
  startTime:     string | null;   // "HH:MM"
  endTime:       string | null;
}

export interface BatchSession {
  cohortId: string;
  title: string;
  programName: string | null;
  courseName: string | null;
  startAt: string;
  endAt: string;
  isTrainer: boolean;
  isCoTrainer: boolean;
  trainerName: string | null;
  coTrainerName: string | null;
  location: string | null;
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
  // Phase H
  trainerId?:    string | null;
  coTrainerId?:  string | null;
  daysOfWeek?:   WeekDay[] | null;
  startTime?:    string | null;
  endTime?:      string | null;
}

export interface CatalogResponse {
  programs: { id: string; name: string; track: string | null; price: string | null }[];
  courses: { id: string; name: string; code: string | null; programId: string; programName: string }[];
  advisors: { id: string; name: string; email: string; role: string }[];
  employees: { id: string; name: string; email: string; role: string }[];
  staff: { id: string; name: string; email: string; role: string }[];
  sources: { key: string; label: string }[];
  ticketCategories: { key: TicketCategory; label: string }[];
  ticketPriorities: { value: TicketPriority; label: string }[];
  ticketStatuses:   { key: TicketStatus; label: string }[];
  resolutionCodes:  { key: TicketResolutionCode; label: string }[];
}

// ── Tickets ────────────────────────────────────────────────────────────────

export type TicketStatus = "open" | "in_progress" | "pending" | "resolved" | "closed" | "cancelled";
export type TicketPriority = 1 | 2 | 3 | 4;
export type TicketCategory =
  | "billing" | "technical" | "content_lms" | "onboarding"
  | "cohort_batch" | "refund" | "certificate" | "other";
export type TicketRequesterKind = "lead" | "learner" | "external";
export type TicketResolutionCode = "fixed" | "duplicate" | "wont_fix" | "no_action";

export interface Ticket {
  id: string;
  number: string;
  createdAt: string;
  updatedAt: string;
  subject: string;
  description: string | null;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  requesterName: string;
  requesterEmail: string;
  requesterPhone: string;
  requesterKind: TicketRequesterKind;
  partyId: string | null;
  dueAt: string | null;
  remindAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  resolution: string | null;
  resolutionCode: TicketResolutionCode | null;
  assigneeId: string | null;
  assigneeName: string | null;
  isOverdue: boolean;
}

export interface TicketDetail {
  ticket: Ticket & {
    assigneeEmail: string | null;
    createdByName: string | null;
    partyName: string | null;
    partyEmail: string | null;
    partyPhone: string | null;
  };
  timeline: TimelineRow[];
  linked: { kind: "lead" | "learner"; href: string; label: string } | null;
}

export interface TicketDashboard {
  counts: {
    total: number; open: number; inProgress: number; pending: number;
    resolved: number; closed: number; cancelled: number;
    overdue: number; dueToday: number; dueThisWeek: number; closedThisWeek: number;
  };
  byPriority: { priority: number; count: number }[];
  byCategory: { category: TicketCategory; count: number }[];
  byAssignee: {
    assigneeId: string; name: string; role: string;
    open: number; overdue: number; closedThisWeek: number;
  }[];
  oldestOpen: {
    id: string; number: string; subject: string; status: TicketStatus; priority: TicketPriority;
    dueAt: string | null; requesterName: string; assigneeName: string | null;
    createdAt: string; isOverdue: boolean;
  }[];
  recentClosed: {
    id: string; number: string; subject: string; status: TicketStatus; priority: TicketPriority;
    closedAt: string | null; requesterName: string; assigneeName: string | null;
    resolution: string | null;
  }[];
}

export interface CreateTicketInput {
  requesterName: string;
  requesterEmail: string;
  requesterPhone: string;
  requesterKind: TicketRequesterKind;
  partyId?: string | null;
  subject: string;
  description?: string;
  category?: TicketCategory;
  priority?: TicketPriority;
  assigneeId?: string;
  dueAt?: string;
  remindAt?: string;
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
  rating?: LeadRating;
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
  tickets: { open: number; overdue: number };
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
      nextFollowupAt?: string | null;
      demoAttendedAt?: string | null;
      paymentProofUrl?: string | null;
      // Phase H+: contact details split out + lead-level display tz
      phoneCountryCode?: string | null;
      timeZone?: string | null;
      // online | offline | hybrid — how the lead wants the program delivered.
      deliveryMode?: "online" | "offline" | "hybrid" | null;
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
