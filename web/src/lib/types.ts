// Types shared between API responses and components. Kept narrow.

// ── WhatsApp ──────────────────────────────────────────────────────────────

export type WaConversationStatus = "open" | "pending" | "closed";
export type WaMessageStatus = "queued" | "sent" | "delivered" | "read" | "failed";
export type WaMessageDirection = "inbound" | "outbound";
export type WaSenderType = "customer" | "agent" | "bot" | "system";
export type WaContentType =
  | "text" | "image" | "audio" | "video" | "document"
  | "template" | "interactive" | "reaction" | "location" | "unsupported";
export type WaTemplateCategory = "UTILITY" | "MARKETING" | "AUTHENTICATION";
export type WaTemplateStatus = "approved" | "pending" | "rejected" | "paused";

export interface WaConfig {
  configured: boolean;
  status: "connected" | "disconnected";
  connectedAt: string | null;
  registeredAt: string | null;
  subscribedAt: string | null;
  credentials: {
    phone_number_id: string;
    waba_id: string;
    app_id: string;
    app_secret: string;          // masked tail-only
    system_user_token: string;   // masked tail-only
    webhook_verify_token: string; // masked tail-only
  } | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
}

export interface WaTemplate {
  id: string;
  templateName: string;
  language: string;
  category: WaTemplateCategory;
  headerType: "text" | "image" | "video" | "document" | null;
  headerContent: string | null;
  bodyText: string;
  footerText: string | null;
  buttons: unknown[] | null;
  variableCount: number;
  status: WaTemplateStatus;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WaTag {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface WaConversationListItem {
  id: string;
  partyId: string;
  status: WaConversationStatus;
  assignedUserId: string | null;
  assignedUserName: string | null;
  lastMessageText: string | null;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  unreadCount: number;
  labels: string[];
  updatedAt: string;
  partyName: string;
  partyPhone: string | null;
  partyPhoneCc: string | null;
  leadNumber: string | null;
  isLearner: boolean;
}

export interface WaMessage {
  id: string;
  direction: WaMessageDirection;
  senderType: WaSenderType;
  senderUserId: string | null;
  contentType: WaContentType;
  body: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
  templateName: string | null;
  templateVariables: Record<string, string> | null;
  providerMessageId: string | null;
  status: WaMessageStatus;
  errorCode: string | null;
  errorMessage: string | null;
  inReplyToProviderId: string | null;
  sentAt: string;
  deliveredAt: string | null;
  readAt: string | null;
}

export interface WaConversationDetail {
  conversation: WaConversationListItem & {
    partyEmail: string | null;
    partyCity: string | null;
    createdAt: string;
  };
  messages: WaMessage[];
  tags: WaTag[];
}

// ─── Broadcasts (Phase 3) ────────────────────────────────────────────────

export type WaBroadcastStatus = "draft" | "scheduled" | "sending" | "completed" | "cancelled" | "failed";
export type WaBroadcastRecipientStatus = "pending" | "sent" | "delivered" | "read" | "failed" | "cancelled";

export interface WaBroadcastListItem {
  id: string;
  name: string;
  status: WaBroadcastStatus;
  templateId: string;
  templateName: string | null;
  templateLanguage: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  failedCount: number;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
}

export interface WaBroadcastDetail {
  broadcast: WaBroadcastListItem & {
    templateBodyText: string | null;
    templateVariableCount: number | null;
    defaultVariables: Record<string, string>;
    updatedAt: string;
  };
  recipients: WaBroadcastRecipient[];
}

export interface WaBroadcastRecipient {
  id: string;
  partyId: string | null;
  partyName: string | null;
  toPhone: string;
  variables: Record<string, string>;
  status: WaBroadcastRecipientStatus;
  providerMessageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  queuedAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}

// ─── Automations (Phase 4) ──────────────────────────────────────────────

export type WaTriggerType = "inbound_message_keyword" | "new_contact" | "lead_created";
export type WaActionType = "send_template" | "send_text" | "add_tag" | "assign_user" | "set_status";
export type WaAutomationRunStatus = "running" | "completed" | "failed" | "skipped";

export interface WaAutomationTrigger {
  type: WaTriggerType;
  config?: Record<string, unknown>;
}

export interface WaAutomationAction {
  type: WaActionType;
  config: Record<string, unknown>;
}

export interface WaAutomationListItem {
  id: string;
  name: string;
  description: string | null;
  trigger: WaAutomationTrigger;
  actions: WaAutomationAction[];
  enabled: boolean;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  runCount: number;
}

export interface WaAutomationRunItem {
  id: string;
  partyId: string | null;
  partyName: string | null;
  conversationId: string | null;
  status: WaAutomationRunStatus;
  context: Record<string, unknown>;
  actionsLog: Array<{ type: WaActionType; ok: boolean; error?: string }>;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

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
  // Pipeline-list editable fields. These are nullable because the slim
  // /leads endpoint doesn't surface them; the pipeline endpoint does.
  email?: string | null;
  phone?: string | null;
  phoneCountryCode?: string | null;
  description?: string | null;
  programId?: string | null;
  deliveryMode?: string | null;     // online | offline | hybrid
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

