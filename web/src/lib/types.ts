// Types shared between API responses and components. Kept narrow.

// ── Twilio messaging (SMS + WhatsApp) ────────────────────────────────────

export type TwChannel = "sms" | "whatsapp";
export type TwMessageDirection = "inbound" | "outbound";
export type TwMessageStatus = "queued" | "sent" | "delivered" | "read" | "failed" | "received";
export type TwConversationStatus = "open" | "closed";

export interface TwConversationListItem {
  id: string;
  channel: TwChannel;
  status: TwConversationStatus;
  assignedUserId: string | null;
  lastMessageText: string | null;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  unreadCount: number;
  isUnlinked: boolean;
  updatedAt: string;
  partyId: string;
  partyName: string;
  partyPhone: string | null;
  leadNumber: string | null;
}

export interface TwMessage {
  id: string;
  direction: TwMessageDirection;
  channel: TwChannel;
  fromNumber: string;
  toNumber: string;
  body: string | null;
  providerMessageId: string | null;
  status: TwMessageStatus;
  errorCode: string | null;
  errorMessage: string | null;
  senderUserId: string | null;
  sentAt: string;
  deliveredAt: string | null;
  /** File attachments in send/receive order. Empty array when none. */
  media?: TwMessageMedia[];
}

export interface TwMessageMedia {
  assetId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  providerHosted: boolean;
  ordinal: number;
  /** Short-lived signed URL the FE can drop into <img src=…>, <video>,
   *  <audio>, or a download link. Bypasses the authenticated
   *  /media/proxy endpoint (which can't receive a JWT from an <img> tag).
   *  Undefined when the server isn't configured to sign URLs. */
  fetchUrl?: string;
}

// ── Media library ────────────────────────────────────────────────────────

export interface MediaFolder {
  id: string;
  name: string;
  createdAt: string;
  createdBy: string | null;
  assetCount: number;
}

export interface MediaAsset {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  blobUrl: string;
  isLibrary: boolean;
  source: "user_upload" | "twilio_inbound";
  providerHosted: boolean;
  uploadedBy: string | null;
  folderId: string | null;
  folderName: string | null;
  createdAt: string;
}

export interface TwConversationDetail {
  conversation: TwConversationListItem & {
    partyEmail: string | null;
    partyCity: string | null;
    createdAt: string;
  };
  messages: TwMessage[];
}

export type Stage = "new" | "qual" | "demo" | "neg" | "won";
export type Heat = "hot" | "warm" | "cold";
// Human-set lead rating. Replaces the auto-derived `heat` for UI purposes.
// Also drives the pipeline columns.
export type LeadRating =
  | "new lead"
  | "attempted"
  | "cold"
  | "lukewarm"
  | "warm"
  | "hot"
  | "superhot"
  | "enrolled";
export const LEAD_RATINGS: LeadRating[] = [
  "new lead",
  "attempted",
  "cold",
  "lukewarm",
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
  visitedDate:    string | null;   // when the lead already visited the centre
  visitingDate:   string | null;   // when the lead is scheduled to visit
  // Pipeline-list editable fields. These are nullable because the slim
  // /leads endpoint doesn't surface them; the pipeline endpoint does.
  email?: string | null;
  phone?: string | null;
  phoneCountryCode?: string | null;
  description?: string | null;
  programId?: string | null;
  deliveryMode?: string | null;     // online | classroom | hybrid
  leadStatus?: string | null;       // see LEAD_STATUS_KEYS server-side
  timeZone?: string | null;          // IANA tz
  feePaid?: string | null;
  feeDue?: string | null;
  dueDate?: string | null;
  registeredDate?: string | null;
  source?: string | null;
  sourceLabel?: string | null;
  advisorId?: string | null;
  advisorName?: string | null;
  createdAt?: string | null;
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
  /** Key of the agent this run came from (e.g. "outreach", "scoring") —
   *  used by the sidebar to link each row to its agent page. */
  agentKey?: string;
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
}

// ─── Advisors (Manage Advisors admin page) ────────────────────────────────
// These are app_user rows with role 'admin' | 'advisor'. `auth0Sub` is null
// until the person actually signs in via Auth0 for the first time.

export type AdvisorRole = "admin" | "advisor";

export interface Advisor {
  id: string;
  partyId: string;
  email: string;
  name: string | null;
  phone: string | null;
  role: AdvisorRole;
  active: boolean;
  auth0Sub: string | null;
  createdAt: string;
  leadCount: number;
}

export interface AdvisorInput {
  name:  string;
  email: string;
  phone?: string | null;
  role?: AdvisorRole;
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
  | "lead" | "learner" | "case" | "program" | "cohort" | "user" | "agent";

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

// ─── Phase G: Leaves + calendar (timesheets removed) ──────────────────────

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

export interface ModuleLevel {
  key: string;
  label: string;
  permission: string;
}

export interface ModuleAccess {
  key: string;
  label: string;
  description?: string;
  levels: ModuleLevel[];
}

export interface PermissionPreset {
  key: string;
  name: string;
  description: string;
  permissions: string[];
}

export interface GroupsResponse {
  groups: UserGroupSummary[];
  catalog: string[];
  modules: ModuleAccess[];
  presets: PermissionPreset[];
}

// ─── Saved view ───────────────────────────────────────────────────────────
// A persisted snapshot of a list view's filter rules + visible columns.
// `scope` names the surface ('pipeline_list'); `filter` is the FilterBar
// state shape (`{ rules: [...] }`); `columns` is the ordered list of
// visible column keys.

export type SavedViewScope = "pipeline_list";
export type SavedViewVisibility = "personal" | "shared";

export interface SavedView {
  id: string;
  tenantId: string;
  ownerId: string;
  scope: SavedViewScope;
  name: string;
  visibility: SavedViewVisibility;
  filter: { rules?: unknown[] } & Record<string, unknown>;
  columns: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface SavedViewInput {
  name: string;
  visibility: SavedViewVisibility;
  filter: { rules?: unknown[] } & Record<string, unknown>;
  columns: string[] | null;
}

// Catalog v2 — Stack → Program → Course (many-to-many). Every program belongs
// to one stack; programs link to reusable courses via the program_course
// junction. Courses are just name + description now.

export interface Stack {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  programCount: number;
}

export type DurationUnit = "weeks" | "months";

export interface ProgramCourseRef {
  id: string;
  name: string;
  rank: number;
}

export interface Program {
  id: string;
  name: string;
  description: string | null;
  price: string | null;
  durationValue: number | null;
  durationUnit: DurationUnit | null;
  enabled: boolean;
  stackId: string;
  stackName: string | null;
  leadCount: number;
  courseCount: number;
  batchCount: number;
  enrolmentCount: number;
  courses: ProgramCourseRef[];
}

export interface ProgramInput {
  name: string;
  stackId: string;
  description?: string | null;
  price?: string | null;
  durationValue?: number | null;
  durationUnit?: DurationUnit | null;
  courseIds?: string[];
  enabled?: boolean;
}

export interface Course {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  programCount: number;
  batchCount: number;
  runningBatchCount: number;
  activeLearners: number;
}

export interface CourseInput {
  name: string;
  description?: string | null;
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
  // Course is the canonical parent of a batch. A course can live under many
  // programs, so there's no single program label on the batch anymore.
  courseId: string | null;
  courseName: string | null;
  courseEnabled: boolean | null;
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
  courseDescription: string | null;
  /** Whether the underlying course is enabled. Drives the learner page's
   *  static active/inactive badge — the lifecycle of the assignment itself
   *  (active/dropped/etc.) isn't exposed in the learner UI any more. */
  courseEnabled: boolean;
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
    // Fee ledger (single per learner, see post-0055/0056/0057-party-fee-*.sql).
    // feeDue is NOT stored — clients compute it as (feeQuoted − feePaid).
    // paymentProofs is the canonical ordered list of receipts (each item is a
    // plain URL or a data: URL). paymentProofUrl mirrors proofs[0] for one
    // release so any legacy reader stays coherent.
    feeQuoted:       string | null;
    feePaid:         string | null;
    dueDate:         string | null;
    paymentStatus:   PaymentStatus | null;
    paymentProofUrl: string | null;
    paymentProofs:   string[];
    feeNotes:        string | null;
  };
  enrolments: ProgramEnrolment[];
  courseAssignments: CourseAssignment[];
  assignments: BatchAssignment[];
  timeline: TimelineRow[];
  originLead: { number: string; workItemId: string; score: number; heat: Heat; description: string | null } | null;
}

export type PaymentStatus = "pending" | "paid" | "refund" | "on_hold";

export interface LearnerFeeInput {
  feeQuoted?:     string | null;
  feePaid?:       string | null;
  dueDate?:       string | null;
  paymentStatus?: PaymentStatus | null;
  paymentProofs?: string[];
  feeNotes?:      string | null;
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
  programs: { id: string; name: string; price: string | null; stackId: string | null; stackName: string | null }[];
  courses: { id: string; name: string; description: string | null }[];
  advisors: { id: string; name: string; email: string; role: string }[];
  employees: { id: string; name: string; email: string; role: string }[];
  staff: { id: string; name: string; email: string; role: string }[];
  sources: { key: string; label: string }[];
  leadStatuses: { key: string; label: string }[];
  caseCategories: { key: CaseCategory; label: string }[];
  casePriorities: { value: CasePriority; label: string }[];
  caseStatuses:   { key: CaseStatus; label: string }[];
  resolutionCodes:  { key: CaseResolutionCode; label: string }[];
  slackEvents: { type: SlackEventType; label: string; hint: string }[];
}

// ── Deleted lead (admin trash view) ───────────────────────────────────────

export interface DeletedLead {
  id: string;          // work_item id
  number: string;
  partyId: string;
  name: string;
  email: string | null;
  phone: string | null;
  program: string | null;
  source: string | null;
  sourceLabel: string | null;
  score: number | null;
  heat: string | null;
  rating: string | null;
  advisorName: string | null;
  deletedAt: string;
}

// ── Slack integration ─────────────────────────────────────────────────────

export type SlackEventType = "lead.created" | "case.opened" | "case.closed";

export interface SlackRule {
  id: string;
  tenantId: string;
  name: string;
  eventType: SlackEventType;
  enabled: boolean;
  filter: Record<string, unknown>;
  webhookUrl: string | null;
  channel: string | null;
  template: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SlackRuleInput {
  name: string;
  eventType: SlackEventType;
  enabled?: boolean;
  filter?: Record<string, unknown>;
  webhookUrl: string;
  channel?: string | null;
  template?: string | null;
}

export interface SlackDelivery {
  id: string;
  ruleId: string | null;
  eventType: SlackEventType;
  status: "ok" | "error";
  httpStatus: number | null;
  response: string | null;
  context: Record<string, unknown>;
  sentAt: string;
}

// ── Slack manual "Share to Slack" ─────────────────────────────────────────

export type ShareSurface = "leads" | "learners" | "cases";

export interface SlackShareTarget {
  id: string | null;
  surface: ShareSurface;
  enabled: boolean;
  channel: string | null;
  webhookUrl: string | null;
  fieldKeys: string[];
  headerTemplate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SlackShareTargetsResponse {
  targets: SlackShareTarget[];
  fields: Record<ShareSurface, { key: string; label: string }[]>;
}

export interface SlackShareTargetInput {
  surface: ShareSurface;
  enabled: boolean;
  webhookUrl: string | null;
  channel: string | null;
  fieldKeys: string[];
  headerTemplate?: string | null;
}

export interface SlackSharePreview {
  target: { surface: ShareSurface; channel: string | null; fieldKeys: string[] };
  preview: { text: string; blocks: Record<string, unknown>[] };
  record: Record<string, unknown>;
}

// ── Cases ─────────────────────────────────────────────────────────────────

export type CaseStatus = "open" | "in_progress" | "pending" | "resolved" | "closed" | "cancelled";
export type CasePriority = 1 | 2 | 3 | 4;
export type CaseCategory =
  | "billing" | "technical" | "content_lms" | "onboarding"
  | "cohort_batch" | "refund" | "certificate" | "other";
export type CaseRequesterKind = "lead" | "learner" | "external";
export type CaseResolutionCode = "fixed" | "duplicate" | "wont_fix" | "no_action";

export interface Case {
  id: string;
  number: string;
  createdAt: string;
  updatedAt: string;
  subject: string;
  description: string | null;
  category: CaseCategory;
  priority: CasePriority;
  status: CaseStatus;
  requesterName: string;
  requesterEmail: string;
  requesterPhone: string;
  requesterKind: CaseRequesterKind;
  partyId: string | null;
  dueAt: string | null;
  remindAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  resolution: string | null;
  resolutionCode: CaseResolutionCode | null;
  assigneeId: string | null;
  assigneeName: string | null;
  isOverdue: boolean;
}

export interface CaseDetail {
  case: Case & {
    assigneeEmail: string | null;
    createdByName: string | null;
    partyName: string | null;
    partyEmail: string | null;
    partyPhone: string | null;
  };
  timeline: TimelineRow[];
  linked: { kind: "lead" | "learner"; href: string; label: string } | null;
}

export interface CaseDashboard {
  counts: {
    total: number; open: number; inProgress: number; pending: number;
    resolved: number; closed: number; cancelled: number;
    overdue: number; dueToday: number; dueThisWeek: number; closedThisWeek: number;
  };
  byPriority: { priority: number; count: number }[];
  byCategory: { category: CaseCategory; count: number }[];
  byAssignee: {
    assigneeId: string; name: string; role: string;
    open: number; overdue: number; closedThisWeek: number;
  }[];
  oldestOpen: {
    id: string; number: string; subject: string; status: CaseStatus; priority: CasePriority;
    dueAt: string | null; requesterName: string; assigneeName: string | null;
    createdAt: string; isOverdue: boolean;
  }[];
  recentClosed: {
    id: string; number: string; subject: string; status: CaseStatus; priority: CasePriority;
    closedAt: string | null; requesterName: string; assigneeName: string | null;
    resolution: string | null;
  }[];
}

export interface CreateCaseInput {
  requesterName: string;
  requesterEmail: string;
  requesterPhone: string;
  requesterKind: CaseRequesterKind;
  partyId?: string | null;
  subject: string;
  description?: string;
  category?: CaseCategory;
  priority?: CasePriority;
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
  leadStatus?: string;
  description?: string;
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
  cases: { open: number; overdue: number };
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
      visitedDate?: string | null;
      visitingDate?: string | null;
      paymentProofUrl?: string | null;
      // Phase H+: contact details split out + lead-level display tz
      phoneCountryCode?: string | null;
      timeZone?: string | null;
      // online | classroom | hybrid — how the lead wants the program delivered.
      deliveryMode?: "online" | "classroom" | "hybrid" | null;
      // Workflow tag — see LEAD_STATUS_KEYS on the server.
      leadStatus?: string | null;
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
    edits?: { at: string; previous: string; by?: string; byUserId?: string | null }[];
  };
  ts: string;
}

