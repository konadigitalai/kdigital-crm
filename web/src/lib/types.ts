// Types shared between API responses and components. Kept narrow.

// ── Twilio messaging (SMS + WhatsApp) ────────────────────────────────────

// 'voice' (Exotel) and 'email' (Gmail) reuse the same conversation/message
// tables as Twilio SMS/WhatsApp — see api/drizzle/post-0071 and post-0072.
export type TwChannel = "sms" | "whatsapp" | "voice" | "email";
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
  partyEmail: string | null;
  leadNumber: string | null;
  /** Joined from the party's newest lead (post-inbox-redesign). Null when the
   *  conversation isn't linked to a lead, or the lead has been converted away. */
  leadRating: LeadRating | null;
  advisorId: string | null;
  advisorName: string | null;
}

/** Feeds the inbox channel tabs. The client can't derive these — it only ever
 *  holds one channel's threads at a time. */
export interface TwConversationCounts {
  all: number;
  allUnread: number;
  byChannel: Partial<Record<TwChannel, { total: number; unread: number }>>;
}

/** Everything the inbox list can be narrowed by. Mirrors GET /twilio/conversations. */
export interface TwInboxFilter {
  channel?: TwChannel;
  /** "me" | "unassigned" | app_user.id */
  assignee?: string;
  rating?: LeadRating;
  unread?: boolean;
  sort?: "newest" | "oldest" | "unread";
  q?: string;
  limit?: number;
}

// ── Inbox: internal notes + logged calls (post-0074) ─────────────────────
//
// Both are tw_message rows with kind <> 'message', so they sit in the thread in
// time order but were never transmitted to the lead.

export type TwMessageKind = "message" | "note" | "call_log";

export const CALL_OUTCOMES = [
  "connected", "no_answer", "busy", "voicemail", "wrong_number", "not_interested",
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export interface CallLogMeta {
  outcome: CallOutcome;
  durationSec: number | null;
  direction: TwMessageDirection;
}

export interface TwMessage {
  id: string;
  direction: TwMessageDirection;
  channel: TwChannel;
  /** post-0074. Absent on rows written before the migration → treat as "message". */
  kind?: TwMessageKind;
  /** Structured detail for kind='call_log'; `{}` otherwise. */
  meta?: CallLogMeta | Record<string, never>;
  /** Null for kind='note' / 'call_log' — those have no addresses. For email rows
   *  these hold email ADDRESSES, not phone numbers (a Twilio-era legacy). */
  fromNumber: string | null;
  toNumber: string | null;
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
  /** Present on outbound template sends. Body is null in that case —
   *  the template text lives on Twilio/Meta, not in our DB. */
  contentSid?: string | null;
  contentVariables?: Record<string, string> | null;
  campaignId?: string | null;
  /** Joined from wa_template — friendly name + type block for local render. */
  templateName?: string | null;
  templateTypes?: Record<string, unknown> | null;
  /** Email only (channel='email'). For email messages, fromNumber/toNumber
   *  above carry email ADDRESSES, not phone numbers. */
  subject?: string | null;
  bodyHtml?: string | null;
  toAddrs?: string[] | null;
  ccAddrs?: string[] | null;
  providerThreadId?: string | null;
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

// ── Gmail ────────────────────────────────────────────────────────────────

export interface GmailStatus {
  /** Whether the API has Google OAuth credentials at all. */
  configured: boolean;
  /** Whether THIS user has connected their own mailbox. */
  connected: boolean;
  account: {
    email: string;
    connectedAt: string;
    lastSyncedAt: string | null;
    syncError: string | null;
    /** Whether this mailbox's email is shared with the whole workspace. */
    isShared: boolean;
  } | null;
  /** The shared fallback mailbox, if an admin has connected one. */
  shared: string | null;
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
  source: "user_upload" | "twilio_inbound" | "exotel_recording" | "gmail_attachment";
  providerHosted: boolean;
  uploadedBy: string | null;
  folderId: string | null;
  folderName: string | null;
  createdAt: string;
}

/** One inbound event for the app-wide toast (GET /twilio/inbound-events). */
export interface InboundEvent {
  /** tw_message id — the toast's dedupe key. */
  id: string;
  conversationId: string;
  channel: TwChannel;
  body: string | null;
  sentAt: string;
  partyName: string;
  partyPhone: string | null;
  leadNumber: string | null;
  leadRating: LeadRating | null;
}

/** A saved message (canned reply) for the inbox composer. Text lives in
 *  Postgres — see post-0075. */
export interface MessageTemplate {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
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
  /** Derived server-side from the program (program.stack_id is NOT NULL), never
   *  stored on the lead. Null when no program is assigned — rendered "TBD".
   *  Read-only everywhere: reassign the program and the stack follows. */
  stack?: string | null;
  stackId?: string | null;
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

// ─── Lead tasks (post-0073) ───────────────────────────────────────────────
//
// The scheduled work an advisor owes a lead. `activity` (TimelineRow) records
// what already happened; a LeadTask is what's still owed — it has a due date,
// an owner and an open/done lifecycle. The Leads > Calendar view is a render
// of these, and the record page's Activity panel creates them.

export const LEAD_TASK_KINDS = [
  "follow_up", "call", "demo", "campus_visit",
  "trainer_talk", "enrollment", "re_engage", "task",
] as const;
export type LeadTaskKind = (typeof LEAD_TASK_KINDS)[number];

export type LeadTaskStatus = "open" | "done" | "cancelled";

export interface LeadTask {
  id: string;
  kind: LeadTaskKind;
  title: string;
  notes: string | null;
  /** ISO instant. For allDay rows this is IST midnight — read `allDay`, not the clock. */
  dueAt: string;
  allDay: boolean;
  durationMin: number | null;
  status: LeadTaskStatus;
  completedAt: string | null;
  createdAt: string;
  /** Denormalised from the joined lead, so the calendar renders without a second fetch. */
  leadId: string;
  leadNumber: string;
  leadName: string;
  /** app_user.id — the wire never carries party ids. */
  assigneeId: string | null;
  assigneeName: string | null;
}

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

// Interakt (WhatsApp) sync.
export interface InteraktConfig {
  configured: boolean;
  enabled: boolean;
  keyMasked: string | null;
  lastSyncAt: string | null;
}
export type InteraktSyncOutcome =
  | { status: "synced"; number: string | null }
  | { status: "skipped"; number: string | null; reason: string }
  | { status: "failed"; number: string | null; error: string };
export interface InteraktBulkResult {
  synced: number;
  skipped: number;
  failed: number;
  results: InteraktSyncOutcome[];
}

export type SavedViewScope = "pipeline_list" | "enrollments_list" | "learners_list" | "batches_list" | "cases_list";
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

// One enriched batch row for the Batches operational board (list/kanban/chart/
// calendar). Carries course/stack/trainer context + learner counts + rollups so
// the board can display, filter, group and search without a second round-trip.
// coveragePct/attendancePct/slaBreachCount/behindSchedule are computed from the
// batch_session + attendance subsystem (null/0/false until sessions exist).
export interface BatchBoardRow {
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
  courseId: string | null;
  courseName: string | null;
  trainerId: string | null;
  trainerName: string | null;
  coTrainerId: string | null;
  coTrainerName: string | null;
  daysOfWeek: WeekDay[] | null;
  startTime: string | null;
  endTime: string | null;
  stackId: string | null;
  stackName: string | null;
  programName: string | null;
  activeCount: number;
  enrolmentCount: number;
  coveragePct: number | null;
  attendancePct: number | null;
  slaBreachCount: number;
  behindSchedule: boolean;
  staffed: boolean;
  underEnrolled: boolean;
}

export type BatchSessionStatus = "planned" | "delivered" | "cancelled";
export type AttendanceStatus = "present" | "absent" | "late" | "excused";

// A persisted batch_session for the batch detail timeline.
export interface BatchSessionDetail {
  id: string;
  cohortId: string;
  sessionDate: string;
  startTime: string | null;
  endTime: string | null;
  status: BatchSessionStatus;
  recordingUrl: string | null;
  recordingPublishedAt: string | null;
  notes: string | null;
  markedCount: number;
  presentCount: number;
}

// One roster entry for a session's attendance capture panel. `status` is null
// when the learner hasn't been marked yet.
export interface AttendanceRosterEntry {
  partyId: string;
  name: string;
  email: string | null;
  status: AttendanceStatus | null;
  markedAt: string | null;
}

// A persisted batch_session enriched for the board calendar feed.
export interface BatchBoardSession {
  id: string;
  cohortId: string;
  title: string;
  courseName: string | null;
  sessionDate: string;
  startTime: string | null;
  endTime: string | null;
  status: BatchSessionStatus;
  recordingUrl: string | null;
  recordingPublishedAt: string | null;
  trainerName: string | null;
  coTrainerName: string | null;
}

// Rich rollup bundle for the batch record page.
export interface BatchDetailData {
  id: string;
  code: string | null;
  name: string;
  courseName: string | null;
  stackName: string | null;
  programName: string | null;
  status: BatchStatus;
  staffed: boolean;
  trainerId: string | null;
  trainerName: string | null;
  coTrainerId: string | null;
  coTrainerName: string | null;
  slot: BatchSlot | null;
  timeLabel: string | null;
  schedule: string | null;
  startDate: string | null;
  endDate: string | null;
  seats: number | null;
  activeCount: number;
  movedOut: number;
  atRisk: number;
  sessionsTotal: number;
  sessionsDelivered: number;
  sessionsNoRecording: number;
  coveragePct: number | null;
  attendancePct: number | null;
  recordingSlaPct: number | null;
  behindSessions: number;
  timezone: string;
  nba: { text: string; action: string };
}

export interface BatchBoardSummary {
  totalBatches: number;
  running: number;
  upcoming: number;
  unstaffed: number;
  underEnrolled: number;
  totalActive: number;
  totalSeats: number;
  fillPct: number | null;
  avgCoveragePct: number | null;
  avgAttendancePct: number | null;
}

export type EnrolmentStatus = "active" | "completed" | "dropped" | "deferred";

// One enriched learner row for the Learners board (list/kanban/chart/calendar).
// Carries everything needed to display, filter, group and search without a
// second round-trip. `status` is the derived board label ("In batch" /
// "Assigned" / "Enrolled"); the learner_profile fields are sparse (nulls fine).
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
    programId: string | null;
    programName: string | null;
    status: EnrolmentStatus | null;
  } | null;
  /** Program of the primary enrolment (prefer active, else newest). */
  programName: string | null;
  /** Stack the primary program belongs to. */
  stackName: string | null;
  /** Raw lifecycle status of the primary enrolment. */
  enrolmentStatus: EnrolmentStatus | null;
  /** Derived board status: "In batch" | "Assigned" | "Enrolled". */
  status: string;
  /** Assigned course-module names — the chips. */
  courseModules: string[];
  /** Primary batch code, or null → the UI shows "Not batched". */
  batchCode: string | null;
  /** Best-effort from the party's originating lead. Null → "Unassigned". */
  advisorId: string | null;
  advisorName: string | null;
  /** learner_profile satellite — sparse, nulls fine. */
  skillLevel: string | null;
  placementStatus: string | null;
  mentorPartyId: string | null;
}

// KPI aggregates for the Learners board stat cards.
export interface LearnerBoardSummary {
  totalLearners: number;
  activeInBatch: number;
  notBatched: number;
  completed: number;
  placed: number;
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

// ── Enrollments ─────────────────────────────────────────────────────────────
// The enrolment record — persists across the lead → enrolled → learner
// workflow. paymentHealth is a computed label derived from paid/quoted vs the
// due date. `status` is the full enrolment lifecycle
// ('pending' | 'active' | 'on_hold' | 'completed' | 'dropped' | 'deferred').
export type PaymentHealth = "paid_in_full" | "on_track" | "due_soon" | "overdue" | "critical";

// One enriched enrollment row for the Enrollments board (list/kanban/chart/
// calendar). Carries everything needed to display, filter, group and search
// without a second round-trip. `statusLabel` is the derived human label
// ("In Training" / "Batched" / "Active" / …); `paymentHealth` is computed
// server-side from paid/quoted vs the due date.
export interface Enrollment {
  id: string;
  number: string | null;
  status: string;
  statusLabel: string;
  feeQuoted: string | null;
  feePaid: string | null;
  feeDue: string | null;
  paidPct: number | null;
  dueDate: string | null;
  paymentStatus: PaymentStatus | null;
  paymentVerifiedAt: string | null;
  paymentHealth: PaymentHealth;
  createdAt: string;
  registeredDate: string | null;
  partyId: string;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  programName: string | null;
  stackName: string | null;
  /** Assigned course-module names — the "+ML +GenAI" chips. */
  courseModules: string[];
  /** Primary batch code, or null → the UI shows "+ Assign". */
  batchCode: string | null;
  advisorId: string | null;
  advisorName: string | null;
  /** Current role — 'enrolled' pre-conversion, 'learner' once converted. */
  role: string | null;
  activeBatches: number;
  totalBatches: number;
}

// KPI aggregates for the Enrollments stat cards. Money fields are rupee
// amounts (numbers, not formatted strings); the client formats them.
export interface EnrollmentSummary {
  contractedTotal: number;
  collectedTotal: number;
  collectedPct: number;
  outstandingTotal: number;
  overdueTotal: number;
  overdueCount: number;
  dueSoonTotal: number;
  dueSoonCount: number;
}

export interface EnrollmentRecord {
  enrolment: {
    id: string;
    number: string | null;
    status: string;
    feeQuoted: string | null;
    feePaid: string | null;
    feeDue: string | null;
    dueDate: string | null;
    paymentStatus: PaymentStatus | null;
    paymentProofUrl: string | null;
    paymentProofs: string[];
    feeNotes: string | null;
    paymentVerifiedAt: string | null;
    verifiedByName: string | null;
    paymentHealth: PaymentHealth;
  };
  party: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    city: string | null;
    attributes: { initials?: string };
    /** Current role — 'enrolled' pre-conversion, 'learner' once converted. */
    role: string | null;
  };
  programName: string | null;
  programId: string | null;
  timeline: TimelineRow[];
  originLead: { number: string; workItemId: string } | null;
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
  | "cohort_batch" | "refund" | "certificate" | "data_privacy" | "other";
export type CaseRequesterKind = "lead" | "learner" | "external";
export type CaseResolutionCode = "fixed" | "duplicate" | "wont_fix" | "no_action";

// Cases board redesign — derived/label types.
export type CaseSeverity = "Critical" | "High" | "Medium" | "Low";
export type CaseSlaState = "met" | "paused" | "none" | "breached" | "active";
export type CaseTypeGroup = "Money" | "Content" | "Delivery" | "Access" | "Data" | "Other";
export type CaseSource = "manual" | "auto";

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

  // ── board redesign — persisted (post-0080) ──
  source: CaseSource;
  isAuto: boolean;
  typeLabel: string | null;
  channel: string | null;
  raisedBy: string | null;
  pendingWith: string | null;
  firstResponseAt: string | null;
  reopenCount: number;
  preventable: boolean | null;
  rootCause: string | null;
  systemicRef: string | null;

  // ── derived (server-computed) ──
  severity: CaseSeverity;
  typeGroup: CaseTypeGroup;
  slaState: CaseSlaState;
  slaMinutes: number | null;   // signed minutes to due; negative = past due
  displayStatus: string;       // "In Progress" | "Pending Learner" | "Reopened" | …
  aboutKind: "lead" | "enrolment" | "learner" | null;
  aboutLabel: string | null;
  aboutHref: string | null;
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
  // Derived next-best-action for the violet banner (non-money this pass).
  nba: { text: string; action: string } | null;
}

export interface CaseDashboard {
  counts: {
    total: number; open: number; inProgress: number; pending: number;
    resolved: number; closed: number; cancelled: number;
    overdue: number; dueToday: number; dueThisWeek: number; closedThisWeek: number;
    unassigned: number; slaBreaching: number; refundsPending: number;
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
  phoneCountryCode?: string;
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
  nextFollowupAt?: string;   // YYYY-MM-DD
  visitingDate?: string;     // YYYY-MM-DD
  deliveryMode?: "online" | "classroom" | "hybrid";
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
  /** Set when the party is currently 'enrolled' (post-Enroll, pre-learner).
   *  The lead record links here instead of offering to enroll again. */
  enrollment: { id: string; number: string | null } | null;
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


// ─── LMS ──────────────────────────────────────────────────────────────────
// Mirrors api/src/routes/lms.ts (learner) and lmsAdmin.ts (staff). Progress
// percentages are never sent over the wire — the API returns counts and the
// UI divides, so a stale denominator can't survive a content change.

export type ResourceKind = "video" | "recording" | "document" | "note" | "link";
export type CourseworkType = "lab" | "assignment" | "assessment";
export type SubmissionStatus = "draft" | "submitted" | "late" | "graded" | "returned";

export interface LmsMe {
  partyId: string;
  name: string | null;
  email: string | null;
  learnerNumber: string | null;
  learnerStatus: string | null;
  activeBatches: number;
  completedBatches: number;
}

export interface LmsBatchSummary {
  id: string;
  name: string;
  code: string | null;
  status: string;
  startDate: string | null;
  endDate: string | null;
  timeLabel: string | null;
  joinUrl: string | null;
  courseName: string | null;
  trainerName: string | null;
  moduleCount: number;
  resourceCount: number;
  resourcesDone: number;
}

export interface LmsModule {
  id: string;
  rank: number;
  title: string;
  summary: string | null;
}

export interface LmsResource {
  id: string;
  moduleId: string;
  rank: number;
  title: string;
  kind: ResourceKind;
  videoProvider: string | null;
  videoRef: string | null;
  durationSeconds: number | null;
  body: string | null;
  externalUrl: string | null;
  required: boolean;
  recordingUrl: string | null;
  positionSeconds: number;
  completedAt: string | null;
}

export interface LmsCourseworkLite {
  id: string;
  moduleId: string;
  type: CourseworkType;
  title: string;
  brief: string | null;
  maxScore: string | null;
  dueAt: string | null;
  closesAt: string | null;
  submissionStatus: SubmissionStatus | null;
  score: string | null;
  submittedAt: string | null;
}

export interface LmsBatchDetail {
  batch: {
    id: string; name: string; code: string | null; status: string;
    startDate: string | null; endDate: string | null; joinUrl: string | null;
    courseName: string | null; trainerName: string | null;
  };
  modules: LmsModule[];
  resources: LmsResource[];
  coursework: LmsCourseworkLite[];
}

export interface LmsClass {
  id: string;
  sessionDate: string;
  startTime: string | null;
  endTime: string | null;
  status?: string;
  joinUrl: string | null;
  recordingUrl?: string | null;
  cohortId: string;
  batchName: string;
  batchCode: string | null;
  trainerName: string | null;
}

export interface LmsDeadline {
  id: string;
  type: CourseworkType;
  title: string;
  dueAt: string | null;
  closesAt?: string | null;
  cohortId?: string;
  batchName: string;
  batchCode: string | null;
  moduleTitle: string | null;
  submissionStatus: SubmissionStatus | null;
}

export interface LmsToday {
  nextClasses: LmsClass[];
  dueSoon: Array<{
    id: string; type: CourseworkType; title: string; dueAt: string | null;
    moduleTitle: string | null; batchName: string; batchCode: string | null;
  }>;
  resume: Array<{
    id: string; title: string; kind: ResourceKind; durationSeconds: number | null;
    positionSeconds: number; moduleId: string; moduleTitle: string;
    cohortId: string; batchName: string;
  }>;
}

export interface LmsWorkItem {
  id: string;
  type: CourseworkType;
  title: string;
  brief: string | null;
  maxScore: string | null;
  passScore: string | null;
  grading: string;
  opensAt: string | null;
  dueAt: string | null;
  closesAt: string | null;
  moduleId: string;
  moduleTitle: string;
  cohortId: string;
  batchName: string;
  batchCode: string | null;
  submissionId: string | null;
  submissionStatus: SubmissionStatus | null;
  attempt: number | null;
  score: string | null;
  feedback: string | null;
  submittedAt: string | null;
  gradedAt: string | null;
}

export interface LmsWork {
  items: LmsWorkItem[];
  stats: { dueThisWeek: number; graded: number; averagePct: number | null };
}

// ─── LMS admin ────────────────────────────────────────────────────────────

export interface LmsAdminBatch {
  id: string;
  name: string;
  code: string | null;
  status: string;
  startDate: string | null;
  endDate: string | null;
  joinUrl: string | null;
  courseName: string | null;
  trainerName: string | null;
  moduleCount: number;
  publishedCount: number;
  learnerCount: number;
}

export interface LmsAdminModule {
  id: string;
  rank: number;
  title: string;
  summary: string | null;
  status: "draft" | "published";
  enabled: boolean;
  resourceCount: number;
  courseworkCount: number;
}

export interface LmsAdminResource {
  id: string;
  moduleId: string;
  rank: number;
  title: string;
  kind: ResourceKind;
  videoProvider: string | null;
  videoRef: string | null;
  durationSeconds: number | null;
  body: string | null;
  mediaAssetId: string | null;
  externalUrl: string | null;
  batchSessionId: string | null;
  required: boolean;
  enabled: boolean;
}

export interface LmsAdminCoursework {
  id: string;
  moduleId: string;
  rank: number;
  type: CourseworkType;
  title: string;
  brief: string | null;
  maxScore: string | null;
  passScore: string | null;
  grading: string;
  opensAt: string | null;
  dueAt: string | null;
  closesAt: string | null;
  enabled: boolean;
  awaitingGrading: number;
}

export interface LmsAdminContent {
  modules: LmsAdminModule[];
  resources: LmsAdminResource[];
  coursework: LmsAdminCoursework[];
}

export interface LmsSubmissionRow {
  id: string;
  attempt: number;
  status: SubmissionStatus;
  submittedAt: string | null;
  content: Record<string, unknown>;
  score: string | null;
  feedback: string | null;
  gradedAt: string | null;
  partyId: string;
  learnerName: string | null;
  learnerEmail: string | null;
  learnerNumber: string | null;
}

export interface LmsNote {
  id: string;
  positionSeconds: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}
