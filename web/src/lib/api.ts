// Typed fetch helpers. Server Components call these; they hit the Express API.
//
// API_URL: set in .env.local. Defaults to localhost:4000.
// All routes are tenant-scoped on the server side via `tenantMiddleware`.

import type {
  AdminUser, Advisor, AdvisorInput, AdvisorRole, AgentCard, AgentCatalogEntry, AgentMode, AgentRunRecord, AttendanceRosterEntry, AttendanceStatus, Batch, BatchBoardRow, BatchBoardSession, BatchBoardSummary, BatchDetailData, BatchInput, BatchSession, BatchSessionDetail, BatchSessionStatus,
  CalendarEventDetail, CalendarEventSummary, CatalogResponse,
  Course, CourseInput, CreateLeadInput, CurrentUser,
  Case, CaseDashboard, CaseDetail, CaseResolutionCode,
  InteraktConfig, InteraktSyncOutcome, InteraktBulkResult,
  CreateCaseInput, DeletedLead, EdifyAnswer, EdifySessionSummary, EnrolmentStatus,
  Enrollment, EnrollmentRecord, EnrollmentSummary, EventRsvp, FeedItem,
  ForecastSnapshot, GroupsResponse, InboundEvent, Lead, LeadTask, LeadTaskKind, LeadTaskStatus,
  LeaveDay, LeaveHalfDay, LeaveKind, LearnerBoardSummary, LearnerFeeInput, LearnerRecord, LearnerSummary,
  MessageTemplate,
  PaymentStatus,
  PipelineColumn, Program, ProgramInput, RecentRun, RecordResponse,
  SavedView, SavedViewInput, SavedViewScope,
  ShareSurface,
  SlackDelivery, SlackRule, SlackRuleInput,
  SlackSharePreview, SlackShareTarget, SlackShareTargetInput, SlackShareTargetsResponse,
  TwConversationCounts, TwInboxFilter, TwMessageDirection, CallOutcome,
  SummaryResponse,
} from "./types";

// URL resolution differs between server- and client-side fetches.
//
// Server Components run on Vercel and call the API directly via API_URL.
// The cookie-forwarding helper below copies the browser's session cookie
// onto the outbound request, so RLS + auth work as expected.
//
// Client-side, the browser fetches a *relative* /api/... URL on the same
// vercel.app origin. Next.js's `rewrites` (see next.config.mjs) forwards
// those to Render. This sidesteps third-party-cookie blocks: from the
// browser's POV every API call is first-party to the Vercel domain.
//
// In local dev (NODE_ENV !== production), the browser falls back to a
// direct localhost:4000 URL since there's no Vercel proxy in front.
const isServer = typeof window === "undefined";
const API_URL = (() => {
  if (isServer) {
    return process.env.API_URL
      ?? process.env.NEXT_PUBLIC_API_URL
      ?? (process.env.NODE_ENV === "production" ? undefined : "http://localhost:4000");
  }
  // Browser: prefer the same-origin proxy in production, dev hits localhost.
  return process.env.NODE_ENV === "production"
    ? "/api"
    : (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000");
})();

if (!API_URL) {
  // Surface a clear error instead of failing with ECONNREFUSED.
  throw new Error(
    "API URL is not configured. Set API_URL (and NEXT_PUBLIC_API_URL) in your environment.",
  );
}

// Pull an Auth0 access token and attach it as Bearer on every API call.
// Server vs. client get the token via different SDK paths but the end
// result is the same: a fresh access token issued for the Edify CRM API
// audience.
//
// If the token can't be fetched (signed-out user, expired session that
// can't refresh), we return no header — the API will reject with 401 and
// the SDK middleware bounces the browser to /auth/login on next nav.
async function authHeaders(): Promise<Record<string, string>> {
  try {
    let token: string | undefined;
    if (isServer) {
      // Server side: pulls the token from the encrypted session cookie.
      // Imported lazily so this module stays browser-safe.
      const { auth0 } = await import("./auth0");
      const result = await auth0.getAccessToken();
      // Server SDK returns { token, expires_at, ... }; some SDK paths
      // surface just the string. Handle both.
      token = typeof result === "string" ? result : result?.token;
    } else {
      // Browser side: SDK exposes a hook that hits its own /auth/access-token
      // route. That route reads the encrypted cookie and returns a fresh
      // token, transparently refreshing if needed. Returns the string by
      // default.
      const { getAccessToken } = await import("@auth0/nextjs-auth0");
      token = await getAccessToken();
    }
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    // No session / expired refresh / etc. — leave the header off and let
    // the API return 401 so callers can redirect to /auth/login.
    return {};
  }
}

// Structured error surface: callers that need the body / status can do
// `if (err instanceof ApiError) …`. Existing toString() form is preserved
// for code that just renders `err.message`.
export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function failResponse(method: string, path: string, r: Response): Promise<never> {
  const text = await r.text();
  let body: unknown = text;
  let serverMsg = text;
  try {
    body = JSON.parse(text);
    if (body && typeof body === "object" && "error" in (body as Record<string, unknown>)) {
      serverMsg = String((body as { error: unknown }).error);
    }
  } catch { /* leave as text */ }
  throw new ApiError(r.status, body, `${method} ${path} → ${r.status}: ${serverMsg}`);
}

// How long a server-side fetch may take before we log it.
//
// This measures the round trip from the Next.js server to the Express API,
// so it captures the network distance between the two deployments as well as
// the API's own time. The API returns its internal split in a Server-Timing
// header (see api/src/lib/timing.ts); logging both together is what lets you
// separate "the API is slow" from "the API is far away".
const SLOW_FETCH_MS = Number(process.env.SLOW_FETCH_MS ?? 800);

async function timedFetch(method: string, path: string, init: RequestInit): Promise<Response> {
  if (!isServer) return fetch(`${API_URL}${path}`, init);

  const t0 = Date.now();
  const r = await fetch(`${API_URL}${path}`, init);
  const elapsed = Date.now() - t0;
  if (elapsed >= SLOW_FETCH_MS) {
    // The API's own accounting, when present, tells us how much of `elapsed`
    // was actually spent working vs. in transit.
    const serverTiming = r.headers.get("Server-Timing");
    console.warn(
      `[slow-fetch] ${method} ${path} ${r.status} ${elapsed}ms` +
      (serverTiming ? ` | api: ${serverTiming}` : ""),
    );
  }
  return r;
}

/**
 * Cache policy for a GET.
 *
 * Default is no-store: this is a CRM, and a stale lead or conversation is
 * worse than a slow one. `cacheFor` opts a specific call into Next's data
 * cache, and is reserved for reference data that changes on a human timescale.
 *
 * Note this only affects SERVER-side fetches. Client-side calls go straight to
 * the API through the /api rewrite and are never cached here.
 */
async function get<T>(
  path: string,
  cacheFor?: { seconds: number; tags: string[] },
): Promise<T> {
  const headers = await authHeaders();
  const r = await timedFetch("GET", path, {
    ...(cacheFor === undefined
      ? { cache: "no-store" as const }
      : { next: { revalidate: cacheFor.seconds, tags: cacheFor.tags } }),
    credentials: "include",
    headers,
  });
  if (!r.ok) await failResponse("GET", path, r);
  return r.json() as Promise<T>;
}

/**
 * Catalog, programs and courses: edited by an admin every few weeks, read on
 * nearly every page render. They were being refetched from the API every time.
 *
 * The TTL is a backstop, not the primary mechanism — the mutation helpers below
 * bust REFERENCE_TAG on write, so an admin's own edit shows up immediately
 * rather than up to a minute later. Without that, `router.refresh()` after a
 * save would re-render Server Components straight into the cached response and
 * look like the save had failed.
 *
 * Deliberately NOT cached: /cohorts (batch schedules and statuses are
 * operational, not reference) and /groups (permission data — staleness there
 * is a security-adjacent surprise, and it's cheap to fetch).
 */
const REFERENCE_TAG = "reference-data";
const REFERENCE_CACHE = { seconds: 60, tags: [REFERENCE_TAG] };

/** Drop the reference-data cache after a write. Best-effort: a failure here
 *  means a viewer sees stale catalog data for up to 60s, which must never turn
 *  an otherwise-successful save into a thrown error. */
async function bustReferenceCache(): Promise<void> {
  try {
    const { revalidateReferenceData } = await import("./revalidate");
    await revalidateReferenceData();
  } catch (err) {
    console.warn("[api] reference-data cache revalidation failed:", err);
  }
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const headers = { "Content-Type": "application/json", ...(await authHeaders()) };
  const r = await timedFetch("POST", path, {
    method: "POST",
    headers,
    cache: "no-store",
    credentials: "include",
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) await failResponse("POST", path, r);
  return r.json() as Promise<T>;
}

// Generic "send method M with optional body" used for PATCH/PUT/DELETE.
async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = { "Content-Type": "application/json", ...(await authHeaders()) };
  const r = await timedFetch(method, path, {
    method,
    headers,
    cache: "no-store",
    credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) await failResponse(method, path, r);
  // Some endpoints return 204; guard JSON parse.
  const text = await r.text();
  return (text ? JSON.parse(text) : ({} as T)) as T;
}

export async function getLeads(): Promise<Lead[]> {
  const { leads } = await get<{ leads: Lead[] }>("/leads");
  return leads;
}

export async function getPipeline(): Promise<PipelineColumn[]> {
  const { columns } = await get<{ columns: PipelineColumn[] }>("/pipeline");
  return columns;
}

export async function getAgentRuns(): Promise<AgentCard[]> {
  try {
    const { runs } = await get<{ runs: AgentCard[] }>("/agents/runs");
    return runs;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
    // 403 = permission not granted. The home page calls this on every load,
    // so throwing takes the page down for anyone without agents.read —
    // including an LMS admin who legitimately has no CRM permissions.
    if ((err as Error).message.includes("→ 403")) return [];
    throw err;
  }
}

export async function getRecentRuns(): Promise<RecentRun[]> {
  try {
    const { recent } = await get<{ recent: RecentRun[] }>("/agents/recent");
    return recent;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
    // 403 = authenticated but this permission isn't granted. AppShell calls
    // this on every render, so throwing takes the whole app down for a user
    // whose Auth0 role simply hasn't been assigned yet. Degrade instead.
    if ((err as Error).message.includes("→ 403")) return [];
    throw err;
  }
}

export async function getActivityFeed(limit = 10): Promise<FeedItem[]> {
  try {
    const { feed } = await get<{ feed: FeedItem[] }>(`/activity?limit=${limit}`);
    return feed;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
    // 403 = permission not granted. The home page calls this on every load,
    // so throwing takes the page down for anyone without agents.read —
    // including an LMS admin who legitimately has no CRM permissions.
    if ((err as Error).message.includes("→ 403")) return [];
    throw err;
  }
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  try {
    const { me } = await get<{ me: CurrentUser | null }>("/me");
    return me;
  } catch (err) {
    // 401 here means the cookie was missing/expired between the Next middleware
    // pass and this server fetch. Render with a null user; the next request will
    // be redirected by middleware.
    if ((err as Error).message.includes("→ 401")) return null;
    // 403 means Auth0 authenticated them but the CRM has no record — no
    // app_user, and no party carrying a learner_profile. That's a legitimate
    // state (someone added to the tenant before their CRM record exists), not
    // an exception. Rethrowing it crashed the layout with a 500 stack trace
    // instead of telling them what to do.
    if ((err as Error).message.includes("→ 403")) return null;
    throw err;
  }
}

export async function getSummary(): Promise<SummaryResponse> {
  try {
    return await get<SummaryResponse>("/summary");
  } catch (err) {
    if ((err as Error).message.includes("→ 401") || (err as Error).message.includes("→ 403")) {
      // 403 = authenticated but no leads/cases permission. AppShell renders
      // this on every page, so throwing would 500 the app for a user whose
      // Auth0 role hasn't been assigned yet. Empty counters are honest here.
      return {
        overall: { total: 0, hot: 0, warm: 0, cold: 0, hotOvernight: 0, pendingApprovals: 0, liveAgents: 0 },
        byStage: [],
        cases: { open: 0, overdue: 0 },
      };
    }
    throw err;
  }
}

export async function getCatalog(): Promise<CatalogResponse> {
  return await get<CatalogResponse>("/catalog", REFERENCE_CACHE);
}

// ── Programs CRUD ──────────────────────────────────────────────────────────

export async function getPrograms(): Promise<Program[]> {
  const { programs } = await get<{ programs: Program[] }>("/programs", REFERENCE_CACHE);
  return programs;
}

export async function createProgram(input: ProgramInput): Promise<Program> {
  const { program } = await post<{ program: Program }>("/programs", input);
  await bustReferenceCache();
  return program;
}

export async function updateProgram(id: string, patch: Partial<ProgramInput>): Promise<Program> {
  const { program } = await send<{ program: Program }>("PATCH", `/programs/${id}`, patch);
  await bustReferenceCache();
  return program;
}

export async function getAdvisors(): Promise<Advisor[]> {
  const { advisors } = await get<{ advisors: Advisor[] }>("/advisors");
  return advisors;
}

export async function createAdvisor(input: AdvisorInput): Promise<Advisor> {
  const { advisor } = await post<{ advisor: Advisor }>("/advisors", input);
  return advisor;
}

export async function updateAdvisor(
  id: string,
  patch: { name?: string; phone?: string | null; role?: AdvisorRole; active?: boolean },
): Promise<Advisor> {
  const { advisor } = await send<{ advisor: Advisor }>("PATCH", `/advisors/${id}`, patch);
  return advisor;
}

// ── Lead edit / actions ───────────────────────────────────────────────────

export async function updateLead(idOrNumber: string, patch: Partial<{
  name: string; email: string | null; phone: string | null; city: string | null;
  phoneCountryCode: string | null;
  timeZone: string | null;
  deliveryMode: "online" | "classroom" | "hybrid" | null;
  leadStatus: string | null;
  workingStatus: "student" | "working" | "not_working" | null;
  yearOfPassout: number | null;
  currentCompany: string | null;
  value: string | null; source: string; sourceLabel: string;
  stage: string; score: number; heat: string; rating: string;
  nbaLabel: string; nbaIcon: string;
  programId: string | null; advisorId: string | null;
  description: string | null;
  feePaid: string | null;
  feeDue: string | null;
  dueDate: string | null;
  registeredDate: string | null;
  nextFollowupAt: string | null;
  demoAttendedAt: string | null;
  visitedDate:    string | null;
  visitingDate:   string | null;
  paymentProofUrl: string | null;
}>): Promise<void> {
  await send<void>("PATCH", `/leads/${encodeURIComponent(idOrNumber)}`, patch);
}

// Apply the same patch to many leads in one round-trip. Limited to the
// fields where bulk-edit makes sense (rating, program, advisor, source,
// delivery mode, time zone, follow-up dates).
export interface BulkLeadPatch {
  rating?:         string;
  programId?:      string | null;
  advisorId?:      string | null;
  source?:         string | null;
  deliveryMode?:   "online" | "classroom" | "hybrid" | null;
  leadStatus?:     string | null;
  timeZone?:       string | null;
  nextFollowupAt?: string | null;   // YYYY-MM-DD
  demoAttendedAt?: string | null;   // YYYY-MM-DD
  visitedDate?:    string | null;   // YYYY-MM-DD
  visitingDate?:   string | null;   // YYYY-MM-DD
}

export async function bulkUpdateLeads(
  ids: string[],
  patch: BulkLeadPatch,
): Promise<{ updated: number; failed: { id: string; error: string }[] }> {
  return await post<{ updated: number; failed: { id: string; error: string }[] }>(
    "/leads/bulk",
    { ids, patch },
  );
}

// Soft-delete a single lead. The work_item + activity history are preserved;
// the party's `lead` role is end-dated so the lead disappears from list/board/search.
export async function deleteLead(idOrNumber: string): Promise<void> {
  await send<void>("DELETE", `/leads/${encodeURIComponent(idOrNumber)}`);
}

// Admin "Trash" — list every soft-deleted lead in the tenant.
export async function getDeletedLeads(): Promise<DeletedLead[]> {
  try {
    const { leads } = await get<{ leads: DeletedLead[] }>("/leads/deleted");
    return leads;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
    if ((err as Error).message.includes("→ 403")) return [];
    throw err;
  }
}

// Reverse a soft-delete: re-opens the lead's role.
export async function restoreLead(idOrNumber: string): Promise<void> {
  await post<void>(`/leads/${encodeURIComponent(idOrNumber)}/restore`, {});
}

// Permanent erase. Requires the leads.purge permission. Cannot be undone.
export async function purgeLead(idOrNumber: string): Promise<void> {
  await send<void>("DELETE", `/leads/${encodeURIComponent(idOrNumber)}/purge`);
}

// Soft-delete many leads in one round-trip. Mirrors bulkUpdateLeads.
export async function bulkDeleteLeads(
  ids: string[],
): Promise<{ deleted: number; failed: { id: string; error: string }[] }> {
  return await post<{ deleted: number; failed: { id: string; error: string }[] }>(
    "/leads/bulk-delete",
    { ids },
  );
}

export async function addLeadNote(idOrNumber: string, text: string): Promise<{ id: string }> {
  return await post<{ id: string }>(`/leads/${encodeURIComponent(idOrNumber)}/notes`, { text });
}

export async function updateLeadNote(
  idOrNumber: string,
  activityId: string,
  text: string,
): Promise<void> {
  await send<void>(
    "PATCH",
    `/leads/${encodeURIComponent(idOrNumber)}/notes/${encodeURIComponent(activityId)}`,
    { text },
  );
}

export async function logLeadComm(
  idOrNumber: string,
  body: { kind: "email" | "schedule"; subject?: string; body?: string; when?: string },
): Promise<void> {
  await post<void>(`/leads/${encodeURIComponent(idOrNumber)}/comms`, body);
}

export async function decideApproval(
  approvalId: string,
  decision: "approve" | "reject",
  proposed?: Record<string, unknown>,
): Promise<void> {
  await post<void>(
    `/approvals/${encodeURIComponent(approvalId)}/decide`,
    { decision, ...(proposed ? { proposed } : {}) },
  );
}

export async function convertLead(
  idOrNumber: string,
  body: { programId?: string; pricePaid?: string } = {},
): Promise<{ partyId: string; enrolmentId: string }> {
  return await post<{ partyId: string; enrolmentId: string }>(
    `/leads/${encodeURIComponent(idOrNumber)}/convert`,
    body,
  );
}

// ── Enrollments ─────────────────────────────────────────────────────────────

// Step 1: lead → enrolled. Creates the enrolment (status 'pending') and the
// 'enrolled' role. Returns the new enrolment id so the UI can route to it.
export async function enrollLead(
  idOrNumber: string,
  body: { programId?: string } = {},
): Promise<{ partyId: string; enrolmentId: string }> {
  return await post<{ partyId: string; enrolmentId: string }>(
    `/leads/${encodeURIComponent(idOrNumber)}/enroll`,
    body,
  );
}

export async function getEnrollments(): Promise<Enrollment[]> {
  const { enrollments } = await get<{ enrollments: Enrollment[] }>("/enrollments");
  return enrollments;
}

export async function getEnrollmentSummary(): Promise<EnrollmentSummary> {
  const { summary } = await get<{ summary: EnrollmentSummary }>("/enrollments/summary");
  return summary;
}

export async function getEnrollment(idOrNumber: string): Promise<EnrollmentRecord | null> {
  try {
    return await get<EnrollmentRecord>(`/enrollments/${encodeURIComponent(idOrNumber)}`);
  } catch (err) {
    if ((err as Error).message.includes("404")) return null;
    throw err;
  }
}

export async function verifyEnrollmentPayment(
  idOrNumber: string,
): Promise<{ ok: true; enrolment: { id: string; number: string | null; paymentVerifiedAt: string } }> {
  return await post(`/enrollments/${encodeURIComponent(idOrNumber)}/verify-payment`, {});
}

// enrolled → learner. Blocked server-side (409) unless payment is verified.
export async function convertEnrollmentToLearner(
  idOrNumber: string,
): Promise<{ ok: true; partyId: string }> {
  return await post(`/enrollments/${encodeURIComponent(idOrNumber)}/convert`, {});
}

export async function patchEnrollmentFee(
  idOrNumber: string,
  patch: LearnerFeeInput,
): Promise<{ ok: true; fee: {
  feeQuoted: string | null; feePaid: string | null; dueDate: string | null;
  paymentStatus: PaymentStatus | null; paymentProofUrl: string | null;
  paymentProofs: string[]; feeNotes: string | null;
} }> {
  return await send("PATCH", `/enrollments/${encodeURIComponent(idOrNumber)}/fee`, patch);
}

// ── Courses ───────────────────────────────────────────────────────────────

export async function getCourses(): Promise<Course[]> {
  const { courses } = await get<{ courses: Course[] }>("/courses", REFERENCE_CACHE);
  return courses;
}

export async function createCourse(input: CourseInput): Promise<Course> {
  const { course } = await post<{ course: Course }>("/courses", input);
  await bustReferenceCache();
  return course;
}

export async function updateCourse(id: string, patch: Partial<CourseInput>): Promise<Course> {
  const { course } = await send<{ course: Course }>("PATCH", `/courses/${id}`, patch);
  await bustReferenceCache();
  return course;
}

// ── Batches (cohorts) ──────────────────────────────────────────────────────

export async function getBatches(): Promise<Batch[]> {
  const { cohorts } = await get<{ cohorts: Batch[] }>("/cohorts");
  return cohorts;
}

export async function createBatch(input: BatchInput): Promise<Batch> {
  const { cohort } = await post<{ cohort: Batch }>("/cohorts", input);
  return cohort;
}

export async function updateBatch(id: string, patch: Partial<BatchInput>): Promise<Batch> {
  const { cohort } = await send<{ cohort: Batch }>("PATCH", `/cohorts/${id}`, patch);
  return cohort;
}

// ── Learners ───────────────────────────────────────────────────────────────

export async function getLearners(): Promise<LearnerSummary[]> {
  const { learners } = await get<{ learners: LearnerSummary[] }>("/learners");
  return learners;
}

export async function getLearnerSummary(): Promise<LearnerBoardSummary> {
  const { summary } = await get<{ summary: LearnerBoardSummary }>("/learners/summary");
  return summary;
}

export async function getLearner(partyId: string): Promise<LearnerRecord | null> {
  try {
    return await get<LearnerRecord>(`/learners/${encodeURIComponent(partyId)}`);
  } catch (err) {
    if ((err as Error).message.includes("404")) return null;
    throw err;
  }
}

export async function patchLearnerFee(
  partyId: string,
  patch: LearnerFeeInput,
): Promise<{ ok: true; fee: {
  feeQuoted: string | null; feePaid: string | null; dueDate: string | null;
  paymentStatus: PaymentStatus | null; paymentProofUrl: string | null;
  paymentProofs: string[]; feeNotes: string | null;
} }> {
  return await send(
    "PATCH",
    `/learners/${encodeURIComponent(partyId)}/fee`,
    patch,
  );
}

export async function assignLearnerToBatch(partyId: string, cohortId: string): Promise<{ enrolmentId: string }> {
  return await post<{ enrolmentId: string }>(
    `/learners/${encodeURIComponent(partyId)}/batches`,
    { cohortId },
  );
}

export interface AssignCoursesResult {
  ok: boolean;
  added: number;
  skipped: number;
  outcomes: Array<
    | { courseId: string; ok: true;  courseAssignmentId: string; courseName: string }
    | { courseId: string; ok: false; error: string }
  >;
}

export async function assignLearnerCourses(
  partyId: string,
  courseIds: string[],
): Promise<AssignCoursesResult> {
  // The API returns 201 (some added) or 409 (none added) — both contain a
  // useful body. Only treat genuine network/non-JSON errors as exceptions.
  const headers = { "Content-Type": "application/json", ...(await authHeaders()) };
  const r = await fetch(`${API_URL}/learners/${encodeURIComponent(partyId)}/courses`, {
    method: "POST",
    headers,
    cache: "no-store",
    credentials: "include",
    body: JSON.stringify({ courseIds }),
  });
  if (!r.ok && r.status !== 409) {
    throw new Error(`POST /learners/${partyId}/courses → ${r.status}: ${await r.text()}`);
  }
  return (await r.json()) as AssignCoursesResult;
}

export async function updateCourseAssignmentStatus(
  partyId: string,
  courseAssignmentId: string,
  status: EnrolmentStatus,
): Promise<void> {
  await send<void>(
    "PATCH",
    `/learners/${encodeURIComponent(partyId)}/courses/${encodeURIComponent(courseAssignmentId)}`,
    { status },
  );
}

// Hard-delete a course_assignment. Any batch_assignments under it cascade
// away server-side.
export async function unassignLearnerCourse(
  partyId: string,
  courseAssignmentId: string,
): Promise<{ ok: true; courseName: string; removedBatches: number }> {
  const headers = await authHeaders();
  const r = await fetch(
    `${API_URL}/learners/${encodeURIComponent(partyId)}/courses/${encodeURIComponent(courseAssignmentId)}`,
    { method: "DELETE", headers, cache: "no-store", credentials: "include" },
  );
  if (!r.ok) {
    throw new Error(`DELETE /learners/${partyId}/courses/${courseAssignmentId} → ${r.status}: ${await r.text()}`);
  }
  return (await r.json()) as { ok: true; courseName: string; removedBatches: number };
}

// Hard-delete a single batch_assignment. Leaves the parent course_assignment
// intact, so the learner is just removed from this one cohort.
export async function unassignLearnerBatch(
  partyId: string,
  assignmentId: string,
): Promise<{ ok: true; cohortName: string }> {
  const headers = await authHeaders();
  const r = await fetch(
    `${API_URL}/learners/${encodeURIComponent(partyId)}/batches/${encodeURIComponent(assignmentId)}`,
    { method: "DELETE", headers, cache: "no-store", credentials: "include" },
  );
  if (!r.ok) {
    throw new Error(`DELETE /learners/${partyId}/batches/${assignmentId} → ${r.status}: ${await r.text()}`);
  }
  return (await r.json()) as { ok: true; cohortName: string };
}

export async function updateEnrolmentStatus(
  partyId: string,
  enrolmentId: string,
  status: EnrolmentStatus,
): Promise<void> {
  await send<void>(
    "PATCH",
    `/learners/${encodeURIComponent(partyId)}/batches/${encodeURIComponent(enrolmentId)}`,
    { status },
  );
}

export async function createLead(input: CreateLeadInput): Promise<{ id: string; number: string }> {
  const { lead } = await post<{ lead: { id: string; number: string } }>("/leads", input);
  return lead;
}

export async function getRecord(idOrNumber: string): Promise<RecordResponse | null> {
  try {
    return await get<RecordResponse>(`/records/${encodeURIComponent(idOrNumber)}`);
  } catch (err) {
    if ((err as Error).message.includes("404")) return null;
    throw err;
  }
}

// ── Interakt (WhatsApp) sync ────────────────────────────────────────────────

export async function getInteraktConfig(): Promise<InteraktConfig> {
  return await get<InteraktConfig>("/integrations/interakt");
}

export async function setInteraktConfig(body: { apiKey?: string | null; enabled?: boolean }): Promise<void> {
  await send<void>("PUT", "/integrations/interakt", body);
}

export async function syncLeadToInterakt(idOrNumber: string): Promise<InteraktSyncOutcome> {
  const { outcome } = await post<{ outcome: InteraktSyncOutcome }>(
    `/leads/${encodeURIComponent(idOrNumber)}/sync-interakt`, {},
  );
  return outcome;
}

export async function bulkSyncLeadsToInterakt(ids: string[]): Promise<InteraktBulkResult> {
  return await post<InteraktBulkResult>("/leads/sync-interakt", { ids });
}

// ── Cases ─────────────────────────────────────────────────────────────────

export interface CaseFilter {
  status?: string;
  assigneeId?: string;
  category?: string;
  priority?: number;
  requesterKind?: string;
  source?: string;
  q?: string;
}

export async function getCases(filter: CaseFilter = {}): Promise<Case[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const path = qs.toString() ? `/cases?${qs}` : "/cases";
  const { cases } = await get<{ cases: Case[] }>(path);
  return cases;
}

export async function getCaseDashboard(): Promise<CaseDashboard> {
  return await get<CaseDashboard>("/cases/dashboard");
}

export async function getCase(idOrNumber: string): Promise<CaseDetail | null> {
  try {
    return await get<CaseDetail>(`/cases/${encodeURIComponent(idOrNumber)}`);
  } catch (err) {
    if ((err as Error).message.includes("404")) return null;
    throw err;
  }
}

export async function createCase(input: CreateCaseInput): Promise<{ id: string; number: string }> {
  const { case: c } = await post<{ case: { id: string; number: string } }>("/cases", input);
  return c;
}

export async function updateCase(
  idOrNumber: string,
  patch: Partial<{
    subject: string;
    description: string | null;
    category: string;
    priority: number;
    status: string;
    assigneeId: string | null;
    dueAt: string | null;
    remindAt: string | null;
    // board redesign — new patchable fields
    typeLabel: string | null;
    channel: string | null;
    raisedBy: string | null;
    pendingWith: string | null;
    source: string;
    preventable: boolean | null;
    rootCause: string | null;
    systemicRef: string | null;
  }>,
): Promise<void> {
  await send<void>("PATCH", `/cases/${encodeURIComponent(idOrNumber)}`, patch);
}

// Escalate = bump to Critical (priority 1) + an activity note. Thin wrapper over PATCH.
export async function escalateCase(idOrNumber: string): Promise<void> {
  await send<void>("PATCH", `/cases/${encodeURIComponent(idOrNumber)}`, { priority: 1, escalate: true });
}

export async function addCaseComment(idOrNumber: string, text: string): Promise<{ id: string }> {
  return await post<{ id: string }>(`/cases/${encodeURIComponent(idOrNumber)}/comments`, { text });
}

export async function closeCase(
  idOrNumber: string,
  body: { resolution: string; resolutionCode?: CaseResolutionCode },
): Promise<void> {
  await post<void>(`/cases/${encodeURIComponent(idOrNumber)}/close`, body);
}

export async function reopenCase(idOrNumber: string): Promise<void> {
  await post<void>(`/cases/${encodeURIComponent(idOrNumber)}/reopen`, {});
}

// ── Auth / users / groups ──────────────────────────────────────────────────

// Sign-out is now a full-page navigation to /auth/logout (auto-mounted by
// the Auth0 SDK middleware). This helper exists for any straggler caller
// that imports it; new code should do `window.location.href = "/auth/logout"`.
export async function logout(): Promise<void> {
  if (typeof window !== "undefined") {
    window.location.href = "/auth/logout";
  }
}

// User + group reads — used by in-app pickers (assignee dropdowns, etc.).
// Mutations (create/update/deactivate/reset-password, create-group/edit-perm)
// moved to Auth0; see https://manage.auth0.com.

export async function getUsers(): Promise<AdminUser[]> {
  const { users } = await get<{ users: AdminUser[] }>("/users");
  return users;
}

export async function getGroups(): Promise<GroupsResponse> {
  return await get<GroupsResponse>("/groups");
}

// ── Saved views ────────────────────────────────────────────────────────────

export async function getSavedViews(scope: SavedViewScope): Promise<SavedView[]> {
  try {
    const { views } = await get<{ views: SavedView[] }>(`/views?scope=${encodeURIComponent(scope)}`);
    return views;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
    // 403 = permission not granted. The home page calls this on every load,
    // so throwing takes the page down for anyone without agents.read —
    // including an LMS admin who legitimately has no CRM permissions.
    if ((err as Error).message.includes("→ 403")) return [];
    throw err;
  }
}

export async function createSavedView(scope: SavedViewScope, input: SavedViewInput): Promise<SavedView> {
  const { view } = await post<{ view: SavedView }>("/views", { scope, ...input });
  return view;
}

export async function updateSavedView(id: string, patch: Partial<SavedViewInput>): Promise<SavedView> {
  const { view } = await send<{ view: SavedView }>("PATCH", `/views/${encodeURIComponent(id)}`, patch);
  return view;
}

// Per-user view preferences (which shared views the current user has hidden,
// and their tab order). Absence of a preference row means "use defaults".
export interface UserViewPreference {
  viewId: string | null;   // NULL = "All leads" pseudo-tab
  hidden: boolean;
  sortOrder: number;
  updatedAt: string;
}

export async function getViewPreferences(scope: SavedViewScope): Promise<UserViewPreference[]> {
  try {
    const { preferences } = await get<{ preferences: UserViewPreference[] }>(
      `/me/view-preferences?scope=${encodeURIComponent(scope)}`,
    );
    return preferences;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
    return [];
  }
}

export async function updateViewPreferences(
  scope: SavedViewScope,
  preferences: Array<{ viewId: string | null; hidden?: boolean; sortOrder?: number }>,
): Promise<void> {
  await send<{ ok: true; updated: number }>("PATCH", `/me/view-preferences`, { scope, preferences });
}

export async function deleteSavedView(id: string): Promise<void> {
  await send<void>("DELETE", `/views/${encodeURIComponent(id)}`);
}

// ── Slack integration ──────────────────────────────────────────────────────

export async function getSlackRules(): Promise<SlackRule[]> {
  try {
    const { rules } = await get<{ rules: SlackRule[] }>("/integrations/slack/rules");
    return rules;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
    if ((err as Error).message.includes("→ 403")) return [];
    throw err;
  }
}

export async function createSlackRule(input: SlackRuleInput): Promise<SlackRule> {
  const { rule } = await post<{ rule: SlackRule }>("/integrations/slack/rules", input);
  return rule;
}

export async function updateSlackRule(id: string, patch: Partial<SlackRuleInput>): Promise<SlackRule> {
  const { rule } = await send<{ rule: SlackRule }>("PATCH", `/integrations/slack/rules/${encodeURIComponent(id)}`, patch);
  return rule;
}

export async function deleteSlackRule(id: string): Promise<void> {
  await send<void>("DELETE", `/integrations/slack/rules/${encodeURIComponent(id)}`);
}

export async function testSlackRule(
  id: string,
): Promise<{ ok: boolean; lastDelivery: SlackDelivery | null }> {
  return await post<{ ok: boolean; lastDelivery: SlackDelivery | null }>(
    `/integrations/slack/rules/${encodeURIComponent(id)}/test`,
    {},
  );
}

// ── Share to Slack — admin config ──────────────────────────────────────────

export async function getSlackShareTargets(): Promise<SlackShareTargetsResponse> {
  return await get<SlackShareTargetsResponse>("/integrations/slack/share-targets");
}

export async function upsertSlackShareTarget(input: SlackShareTargetInput): Promise<SlackShareTarget> {
  const { target } = await post<{ target: SlackShareTarget }>("/integrations/slack/share-targets", input);
  return target;
}

export async function deleteSlackShareTarget(surface: ShareSurface): Promise<void> {
  await send<void>("DELETE", `/integrations/slack/share-targets/${encodeURIComponent(surface)}`);
}

// ── Share to Slack — user-facing send (lead/learner/case record pages) ────

export async function getSharePreview(
  surface: ShareSurface,
  recordId: string,
): Promise<SlackSharePreview> {
  return await get<SlackSharePreview>(
    `/share/slack/preview/${encodeURIComponent(surface)}/${encodeURIComponent(recordId)}`,
  );
}

export async function shareToSlack(
  surface: ShareSurface,
  recordId: string,
  notes: string | null,
  // When present, post via the bot to this specific channel/user. When
  // absent, backend falls back to the surface's legacy webhook target.
  destination?: { kind: "channel" | "user"; id: string; name?: string },
): Promise<void> {
  await post<void>(
    `/share/slack/${encodeURIComponent(surface)}/${encodeURIComponent(recordId)}`,
    { notes, destination },
  );
}

// ─── Slack workspace + directory (dynamic pick) ──────────────────────────

export interface SlackDirectoryChannel { id: string; name: string; isPrivate: boolean; isMember: boolean; topic: string | null }
export interface SlackDirectoryUser { id: string; name: string; label: string; realName: string | null; email: string | null; imageUrl: string | null }
export interface SlackWorkspaceInfo { id: string; teamId: string | null; teamName: string | null; hasToken: boolean; installedAt: string | null }

// Admin-only. Returns rich workspace metadata (team name, installed date).
// Requires integrations.read — used by the admin's Slack Workspace card.
export async function getSlackWorkspace(): Promise<{ workspace: SlackWorkspaceInfo | null }> {
  return await get<{ workspace: SlackWorkspaceInfo | null }>(`/integrations/slack/workspace`);
}

// User-facing. Returns only { hasBotToken } — enough for the share
// dialog to decide whether to show the new picker. No admin
// permission required.
export async function getSlackWorkspaceStatus(): Promise<{ hasBotToken: boolean }> {
  return await get<{ hasBotToken: boolean }>(`/share-slack/workspace-status`);
}
export async function saveSlackBotToken(botToken: string): Promise<{ ok: true; teamName: string; teamId: string; botUser: string }> {
  return await post<{ ok: true; teamName: string; teamId: string; botUser: string }>(
    `/integrations/slack/workspace`, { botToken },
  );
}
export async function testSlackBotToken(): Promise<{ ok: boolean; teamName?: string; teamId?: string; botUser?: string; url?: string; error?: string }> {
  return await post<{ ok: boolean; teamName?: string; teamId?: string; botUser?: string; url?: string; error?: string }>(
    `/integrations/slack/workspace/test`, {},
  );
}
export async function refreshSlackDirectory(): Promise<{ ok: true; channelCount: number; userCount: number }> {
  return await post<{ ok: true; channelCount: number; userCount: number }>(
    `/integrations/slack/directory/refresh`, {},
  );
}
// Directory picker for the "Share to Slack" dialog. Backed by the
// user-facing /share-slack/directory endpoint which smart-routes:
//   - channel + user has Connect Slack → live from user's Slack (their channels)
//   - channel + user NOT connected      → bot-cached channels
//   - user                              → bot-cached user directory
// Any authenticated user can call this — no admin gate.
export async function getSlackDirectory(
  kind: "channel" | "user",
): Promise<{ kind: string; items: SlackDirectoryChannel[] | SlackDirectoryUser[] }> {
  return await get<{ kind: string; items: SlackDirectoryChannel[] | SlackDirectoryUser[] }>(
    `/share-slack/directory?kind=${encodeURIComponent(kind)}`,
  );
}

// ─── Per-CRM-user Slack link (OAuth v2 user flow) ────────────────────────

export interface SlackMyStatus {
  connected: boolean;
  link?: { slackUserId: string; slackTeamId: string | null; connectedAt: string; scopes: string | null };
}
export async function getSlackMyStatus(): Promise<SlackMyStatus> {
  return await get<SlackMyStatus>(`/share-slack/my-status`);
}
// Kept for callers that still import it — same endpoint as
// getSlackDirectory since the /share-slack/directory route already
// smart-routes for user-connection. Both entry points work.
export async function getSlackMyDirectory(
  kind: "channel" | "user",
): Promise<{ kind: string; items: SlackDirectoryChannel[] | SlackDirectoryUser[] }> {
  return await get<{ kind: string; items: SlackDirectoryChannel[] | SlackDirectoryUser[] }>(
    `/share-slack/directory?kind=${encodeURIComponent(kind)}`,
  );
}
export async function getSlackAuthorizeUrl(returnTo: string): Promise<{ url: string }> {
  return await get<{ url: string }>(
    `/auth/slack/authorize-url?returnTo=${encodeURIComponent(returnTo)}`,
  );
}
export async function disconnectSlack(): Promise<{ ok: true }> {
  return await post<{ ok: true }>(`/auth/slack/disconnect`, {});
}

export async function getSlackDeliveries(limit = 50): Promise<SlackDelivery[]> {
  try {
    const { deliveries } = await get<{ deliveries: SlackDelivery[] }>(
      `/integrations/slack/deliveries?limit=${limit}`,
    );
    return deliveries;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
    if ((err as Error).message.includes("→ 403")) return [];
    throw err;
  }
}

// ── Agents ─────────────────────────────────────────────────────────────────

export async function getAgentCatalog(): Promise<AgentCatalogEntry[]> {
  try {
    const { agents } = await get<{ agents: AgentCatalogEntry[] }>("/agents/catalog");
    return agents;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
    // 403 = permission not granted. The home page calls this on every load,
    // so throwing takes the page down for anyone without agents.read —
    // including an LMS admin who legitimately has no CRM permissions.
    if ((err as Error).message.includes("→ 403")) return [];
    throw err;
  }
}

export async function getAgentRunHistory(key: string, limit = 10): Promise<AgentRunRecord[]> {
  try {
    const { runs } = await get<{ runs: AgentRunRecord[] }>(`/agents/${encodeURIComponent(key)}/runs?limit=${limit}`);
    return runs;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
    // 403 = permission not granted. The home page calls this on every load,
    // so throwing takes the page down for anyone without agents.read —
    // including an LMS admin who legitimately has no CRM permissions.
    if ((err as Error).message.includes("→ 403")) return [];
    throw err;
  }
}

export async function runOutreachDraft(
  idOrNumber: string,
): Promise<{ approvalId: string; draft: { subject: string; body: string }; runWorkItemId: string }> {
  return await post(`/agents/outreach/draft/${encodeURIComponent(idOrNumber)}`, {});
}

export async function rescoreLead(idOrNumber: string): Promise<void> {
  await post(`/agents/scoring/score/${encodeURIComponent(idOrNumber)}`, {});
}

export async function rescoreAllLeads(): Promise<{ scored: number; failed: number }> {
  return await post("/agents/scoring/score-all", {});
}

export async function refreshNba(idOrNumber: string): Promise<{
  nba: { nbaLabel: string; nbaIcon: string; nbaHeadline: string; nbaWhy: string; nbaConfidence: number };
  runWorkItemId: string;
}> {
  return await post(`/agents/nba/suggest/${encodeURIComponent(idOrNumber)}`, {});
}

export async function runForecast(): Promise<ForecastSnapshot> {
  return await post<ForecastSnapshot>("/agents/forecast/run", {});
}

export async function getForecastLatest(): Promise<ForecastSnapshot | null> {
  try {
    const res = await get<ForecastSnapshot | null>("/agents/forecast/latest");
    return res;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return null;
    throw err;
  }
}

export async function askEdify(
  question: string,
  sessionId: string | null,
  signal?: AbortSignal,
): Promise<EdifyAnswer> {
  return await post<EdifyAnswer>("/agents/edify/ask", { question, sessionId }, signal);
}

export async function getEdifySessions(limit = 50): Promise<EdifySessionSummary[]> {
  try {
    const { sessions } = await get<{ sessions: EdifySessionSummary[] }>(`/agents/edify/sessions?limit=${limit}`);
    return sessions;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
    // 403 = permission not granted. The home page calls this on every load,
    // so throwing takes the page down for anyone without agents.read —
    // including an LMS admin who legitimately has no CRM permissions.
    if ((err as Error).message.includes("→ 403")) return [];
    throw err;
  }
}

export async function getEdifySession(
  sessionId: string,
): Promise<{ session: EdifySessionSummary; messages: EdifyAnswer[] } | null> {
  try {
    return await get<{ session: EdifySessionSummary; messages: EdifyAnswer[] }>(
      `/agents/edify/sessions/${encodeURIComponent(sessionId)}`,
    );
  } catch (err) {
    if ((err as Error).message.includes("→ 404")) return null;
    if ((err as Error).message.includes("→ 401")) return null;
    throw err;
  }
}

export async function renameEdifySession(sessionId: string, title: string): Promise<void> {
  await send<void>("PATCH", `/agents/edify/sessions/${encodeURIComponent(sessionId)}`, { title });
}

export async function deleteEdifySession(sessionId: string): Promise<void> {
  await send<void>("DELETE", `/agents/edify/sessions/${encodeURIComponent(sessionId)}`);
}

// ── Leaves ─────────────────────────────────────────────────────────────────

export async function getLeaves(opts: { userId?: string; from?: string; to?: string } = {}): Promise<LeaveDay[]> {
  const qs = new URLSearchParams();
  if (opts.userId) qs.set("userId", opts.userId);
  if (opts.from)   qs.set("from", opts.from);
  if (opts.to)     qs.set("to", opts.to);
  try {
    const path = qs.toString() ? `/leaves?${qs}` : "/leaves";
    const { leaves } = await get<{ leaves: LeaveDay[] }>(path);
    return leaves;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
    // 403 = permission not granted. The home page calls this on every load,
    // so throwing takes the page down for anyone without agents.read —
    // including an LMS admin who legitimately has no CRM permissions.
    if ((err as Error).message.includes("→ 403")) return [];
    throw err;
  }
}

export async function addLeave(input: { date: string; kind: LeaveKind; halfDay?: LeaveHalfDay; note?: string | null }): Promise<{ leave: LeaveDay }> {
  return await post<{ leave: LeaveDay }>("/leaves", input);
}

export async function updateLeave(id: string, patch: { kind?: LeaveKind; halfDay?: LeaveHalfDay; note?: string | null }): Promise<{ leave: LeaveDay }> {
  return await send<{ leave: LeaveDay }>("PATCH", `/leaves/${id}`, patch);
}

export async function deleteLeave(id: string): Promise<void> {
  await send<void>("DELETE", `/leaves/${id}`);
}

// ── Calendar events ────────────────────────────────────────────────────────

// ─── Lead tasks ───────────────────────────────────────────────────────────
//
// Backs the Leads > Calendar view (range query) and the record page's Activity
// panel (per-lead query). See api/src/routes/tasks.ts.

export async function getLeadTasks(params: {
  /** Inclusive date window, YYYY-MM-DD. The calendar's month range. */
  from?: string;
  to?: string;
  /** Lead uuid or LEAD-number — the record page's Activity panel. */
  lead?: string;
  status?: LeadTaskStatus;
  kind?: LeadTaskKind;
  /** app_user.id */
  assignee?: string;
} = {}): Promise<LeadTask[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, String(v));
  try {
    const path = qs.toString() ? `/tasks?${qs}` : "/tasks";
    const { tasks } = await get<{ tasks: LeadTask[] }>(path);
    return tasks;
  } catch (err) {
    // Same posture as getEvents: an unauthenticated read is an empty calendar,
    // not a crashed page.
    if ((err as Error).message.includes("→ 401")) return [];
    // 403 = permission not granted. The home page calls this on every load,
    // so throwing takes the page down for anyone without agents.read —
    // including an LMS admin who legitimately has no CRM permissions.
    if ((err as Error).message.includes("→ 403")) return [];
    throw err;
  }
}

export async function createLeadTask(input: {
  /** Lead uuid or LEAD-number. */
  lead: string;
  kind: LeadTaskKind;
  title: string;
  notes?: string | null;
  /** ISO instant. */
  dueAt: string;
  allDay?: boolean;
  durationMin?: number | null;
  /** app_user.id. Omit to inherit the lead's advisor. */
  assigneeId?: string | null;
}): Promise<LeadTask> {
  const { task } = await post<{ task: LeadTask }>("/tasks", input);
  return task;
}

export async function updateLeadTask(
  id: string,
  patch: {
    kind?: LeadTaskKind;
    title?: string;
    notes?: string | null;
    dueAt?: string;
    allDay?: boolean;
    durationMin?: number | null;
    status?: LeadTaskStatus;
    assigneeId?: string | null;
  },
): Promise<LeadTask> {
  const { task } = await send<{ task: LeadTask }>("PATCH", `/tasks/${id}`, patch);
  return task;
}

export async function deleteLeadTask(id: string): Promise<void> {
  await send<void>("DELETE", `/tasks/${id}`);
}

export async function getEvents(from?: string, to?: string): Promise<CalendarEventSummary[]> {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to)   qs.set("to", to);
  try {
    const path = qs.toString() ? `/events?${qs}` : "/events";
    const { events } = await get<{ events: CalendarEventSummary[] }>(path);
    return events;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
    // 403 = permission not granted. The home page calls this on every load,
    // so throwing takes the page down for anyone without agents.read —
    // including an LMS admin who legitimately has no CRM permissions.
    if ((err as Error).message.includes("→ 403")) return [];
    throw err;
  }
}

export async function getEvent(id: string): Promise<CalendarEventDetail | null> {
  try {
    return await get<CalendarEventDetail>(`/events/${id}`);
  } catch (err) {
    if ((err as Error).message.includes("→ 404")) return null;
    if ((err as Error).message.includes("→ 401")) return null;
    throw err;
  }
}

export async function createEvent(input: { title: string; description?: string | null; location?: string | null; startAt: string; endAt: string; allDay?: boolean; inviteeIds: string[] }): Promise<{ id: string }> {
  return await post<{ id: string }>("/events", input);
}

export async function updateEvent(id: string, patch: { title?: string; description?: string | null; location?: string | null; startAt?: string; endAt?: string; allDay?: boolean }): Promise<void> {
  await send<void>("PATCH", `/events/${id}`, patch);
}

export async function deleteEvent(id: string): Promise<void> {
  await send<void>("DELETE", `/events/${id}`);
}

export async function setEventInvitees(id: string, userIds: string[]): Promise<void> {
  await post<void>(`/events/${id}/invitees`, { userIds });
}

export async function respondToEvent(id: string, rsvp: EventRsvp): Promise<void> {
  await post<void>(`/events/${id}/respond`, { rsvp });
}

// ── Batch sessions (calendar) ─────────────────────────────────────────────

// Batches operational board (/batches). Enriched cohort rows + KPI summary.
export async function getBatchesBoard(): Promise<BatchBoardRow[]> {
  const { batches } = await get<{ batches: BatchBoardRow[] }>("/batches/board");
  return batches;
}

export async function getBatchesSummary(): Promise<BatchBoardSummary> {
  const { summary } = await get<{ summary: BatchBoardSummary }>("/batches/summary");
  return summary;
}

// Rich rollups for the batch record page.
export async function getBatchDetail(id: string): Promise<BatchDetailData> {
  const { detail } = await get<{ detail: BatchDetailData }>(`/batches/${id}/detail`);
  return detail;
}

// Persisted sessions for one batch (detail timeline).
export async function getBatchDetailSessions(id: string): Promise<BatchSessionDetail[]> {
  const { sessions } = await get<{ sessions: BatchSessionDetail[] }>(`/batches/${id}/sessions`);
  return sessions;
}

// Generate planned sessions from the batch schedule. Idempotent; returns count.
export async function materializeSessions(id: string, range?: { from?: string; to?: string }): Promise<number> {
  const { created } = await post<{ created: number }>(`/batches/${id}/sessions/materialize`, range ?? {});
  return created;
}

export async function patchBatchSession(
  sessionId: string,
  body: { status?: BatchSessionStatus; recordingUrl?: string | null; recordingPublishedAt?: string | boolean | null; notes?: string | null },
): Promise<BatchSessionDetail> {
  const { session } = await send<{ session: BatchSessionDetail }>("PATCH", `/batches/sessions/${sessionId}`, body);
  return session;
}

export async function getSessionRoster(sessionId: string): Promise<AttendanceRosterEntry[]> {
  const { roster } = await get<{ roster: AttendanceRosterEntry[] }>(`/batches/sessions/${sessionId}/attendance`);
  return roster;
}

export async function saveSessionAttendance(
  sessionId: string,
  marks: Array<{ partyId: string; status: AttendanceStatus }>,
): Promise<number> {
  const { saved } = await send<{ saved: number }>("PUT", `/batches/sessions/${sessionId}/attendance`, { marks });
  return saved;
}

// Persisted board calendar feed across all batches for a date range.
export async function getBoardSessions(from: string, to: string): Promise<BatchBoardSession[]> {
  try {
    const { sessions } = await get<{ sessions: BatchBoardSession[] }>(`/batches/board-sessions?from=${from}&to=${to}`);
    return sessions;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
    if ((err as Error).message.includes("→ 403")) return [];
    throw err;
  }
}

export async function getBatchSessions(from: string, to: string): Promise<BatchSession[]> {
  try {
    const { sessions } = await get<{ sessions: BatchSession[] }>(
      `/batches/sessions?from=${from}&to=${to}`,
    );
    return sessions;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
    if ((err as Error).message.includes("→ 403")) return [];
    throw err;
  }
}

export async function setAgentEnabled(key: string, enabled: boolean): Promise<void> {
  await send<void>("PATCH", `/agents/${encodeURIComponent(key)}`, { enabled });
}

export async function setAgentMode(key: string, mode: AgentMode): Promise<void> {
  await send<void>("PATCH", `/agents/${encodeURIComponent(key)}`, { mode });
}

// ── Twilio messaging (SMS + WhatsApp) ──────────────────────────────────

import type {
  TwChannel, TwConversationDetail, TwConversationListItem, GmailStatus,
} from "./types";

export interface TwConversationFilter {
  channel?:  TwChannel;
  assignee?: "me" | "unassigned" | string;
  q?:        string;
  limit?:    number;
}

/** Build the shared query string for the inbox list + its tab counts, so the two
 *  can never disagree about what they're describing. */
function inboxQuery(filter: TwInboxFilter): URLSearchParams {
  const qs = new URLSearchParams();
  if (filter.assignee) qs.set("assignee", filter.assignee);
  if (filter.rating)   qs.set("rating",   filter.rating);
  if (filter.unread)   qs.set("unread",   "1");
  if (filter.q)        qs.set("q",        filter.q);
  return qs;
}

export async function getTwConversations(
  filter: TwInboxFilter = {},
): Promise<TwConversationListItem[]> {
  const qs = inboxQuery(filter);
  if (filter.channel) qs.set("channel", filter.channel);
  if (filter.sort)    qs.set("sort",    filter.sort);
  if (filter.limit)   qs.set("limit",   String(filter.limit));
  const path = qs.toString() ? `/twilio/conversations?${qs}` : "/twilio/conversations";
  const { conversations } = await get<{ conversations: TwConversationListItem[] }>(path);
  return conversations;
}

/** Per-channel totals for the tab strip. Takes the same filter as the list
 *  (minus `channel`, obviously) so each tab's count matches what clicking it
 *  would actually show. */
export async function getTwConversationCounts(
  filter: TwInboxFilter = {},
): Promise<TwConversationCounts> {
  const qs = inboxQuery(filter);
  const path = qs.toString() ? `/twilio/conversations/counts?${qs}` : "/twilio/conversations/counts";
  try {
    return await get<TwConversationCounts>(path);
  } catch {
    // Counts are decoration on the tabs — a failure here must not blank the inbox.
    return { all: 0, allUnread: 0, byChannel: {} };
  }
}

/** Staff-only note on a conversation. Never transmitted to the lead. Mirrored
 *  into the lead's timeline when the conversation is linked to one. */
export async function addTwConversationNote(id: string, body: string): Promise<void> {
  await post<{ ok: boolean; id: string }>(
    `/twilio/conversations/${encodeURIComponent(id)}/notes`,
    { body },
  );
}

/** Log a call that happened outside the system. */
export async function logTwConversationCall(
  id: string,
  input: {
    outcome: CallOutcome;
    durationSec?: number | null;
    notes?: string | null;
    direction?: TwMessageDirection;
  },
): Promise<void> {
  await post<{ ok: boolean; id: string }>(
    `/twilio/conversations/${encodeURIComponent(id)}/calls`,
    input,
  );
}

export async function getTwConversation(id: string): Promise<TwConversationDetail> {
  return await get<TwConversationDetail>(`/twilio/conversations/${encodeURIComponent(id)}`);
}

/** Inbound events (calls + WhatsApp) newer than `since`, for the app-wide toast.
 *  Returns [] on any failure — a notification poll must never surface an error. */
export async function getInboundEvents(since: string): Promise<InboundEvent[]> {
  try {
    const { events } = await get<{ events: InboundEvent[] }>(
      `/twilio/inbound-events?since=${encodeURIComponent(since)}`,
    );
    return events;
  } catch {
    return [];
  }
}

// ─── Saved messages (canned replies) ─────────────────────────────────────

export async function getMessageTemplates(): Promise<MessageTemplate[]> {
  try {
    const { templates } = await get<{ templates: MessageTemplate[] }>("/message-templates");
    return templates;
  } catch {
    // The composer degrades to "no saved messages" rather than erroring.
    return [];
  }
}

export async function createMessageTemplate(input: { title: string; body: string }): Promise<MessageTemplate> {
  const { template } = await post<{ template: MessageTemplate }>("/message-templates", input);
  return template;
}

export async function updateMessageTemplate(
  id: string,
  input: { title: string; body: string },
): Promise<MessageTemplate> {
  const { template } = await send<{ template: MessageTemplate }>("PATCH", `/message-templates/${id}`, input);
  return template;
}

export async function deleteMessageTemplate(id: string): Promise<void> {
  await send<void>("DELETE", `/message-templates/${id}`);
}

/** Fetch a provider-hosted media asset's BYTES through the authenticated proxy
 *  and return a blob: object URL a raw <img>/<iframe>/<a> can use.
 *
 *  A browser file-loading tag can't send an Authorization header, so it can't
 *  hit /media/proxy directly (that 401s "Missing bearer token"). Public
 *  user-uploads don't need this — their blobUrl loads directly; this is only for
 *  Twilio/Exotel/Gmail assets whose bytes sit behind server-held credentials.
 *
 *  Caller MUST URL.revokeObjectURL() the result when done, or the blob leaks. */
export async function fetchMediaBlobUrl(assetId: string): Promise<string> {
  const headers = await authHeaders();
  const r = await fetch(`${API_URL}/media/proxy/${encodeURIComponent(assetId)}`, {
    cache: "no-store",
    credentials: "include",
    headers,
  });
  if (!r.ok) await failResponse("GET", `/media/proxy/${assetId}`, r);
  return URL.createObjectURL(await r.blob());
}

export interface SendTwilioResult {
  ok: boolean;
  messageId: string;
  providerMessageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Send a message directly from the lead record. `to` may be either an E.164
 * phone (+91...) or a lead number ("LEAD-9865"). Backend resolves.
 */
export async function sendTwMessageToLead(input: {
  channel: TwChannel;
  to: string;
  body: string;
  /** Optional file attachments (up to 10). Order is preserved. */
  mediaAssetIds?: string[];
  /** WhatsApp template mode — takes precedence over body/mediaAssetIds. */
  contentSid?: string;
  contentVariables?: Record<string, string>;
}): Promise<SendTwilioResult & { conversationId?: string }> {
  return await post("/twilio/send", input);
}

// ─── WhatsApp templates ───────────────────────────────────────────────────

export interface WaTemplate {
  id:             string;
  contentSid:     string;
  friendlyName:   string;
  language:       string | null;
  category:       string | null;
  variables:      { names: string[]; samples: Record<string, string> };
  types:          Record<string, unknown>;
  approvalStatus: "draft" | "pending" | "approved" | "rejected" | "unknown" | "paused";
  approvalNote:   string | null;
  syncedAt:       string;
}

export async function listWaTemplates(opts?: { onlyApproved?: boolean; refresh?: boolean }): Promise<WaTemplate[]> {
  const q = new URLSearchParams();
  if (opts?.onlyApproved) q.set("status", "approved");
  if (opts?.refresh)      q.set("refresh", "1");
  const suffix = q.toString() ? `?${q}` : "";
  const r = await get<{ templates: WaTemplate[] }>(`/templates${suffix}`);
  return r.templates;
}

export async function getWaTemplate(contentSid: string): Promise<WaTemplate> {
  const r = await get<{ template: WaTemplate }>(`/templates/${encodeURIComponent(contentSid)}`);
  return r.template;
}

export async function syncWaTemplates(): Promise<{ count: number; errors: number }> {
  return await post<{ count: number; errors: number }>("/templates/sync", {});
}

export async function createWaTemplate(input: {
  friendlyName: string;
  language: string;
  types: Record<string, unknown>;
  variables?: Record<string, string>;
}): Promise<WaTemplate> {
  const r = await post<{ template: WaTemplate }>("/templates", input);
  return r.template;
}

export async function submitWaTemplateForApproval(
  contentSid: string,
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION",
  name: string,
): Promise<{ template: WaTemplate; approval: unknown }> {
  return await post(`/templates/${encodeURIComponent(contentSid)}/submit`, { category, name });
}

// ─── Campaigns ────────────────────────────────────────────────────────────

export interface FilterRule {
  id?:       string;
  fieldKey:  string;
  operator:  string;
  value:     unknown;
}
export interface FilterState {
  combinator: "and" | "or";
  rules: FilterRule[];
}

export interface CampaignSummary {
  id:                string;
  name:              string;
  channel:           string;
  contentSid:        string;
  templateName:      string | null;
  status:            string;
  scheduledAt:       string | null;
  sendRatePerSec:    number;
  dailyCap:          number | null;
  createdAt:         string;
  startedAt:         string | null;
  completedAt:       string | null;
  totalRecipients:   number;
  sentCount:         number;
  deliveredCount:    number;
  failedCount:       number;
  pendingCount:      number;
  skippedCount:      number;
}

export interface CampaignDetail extends Omit<CampaignSummary,
  "totalRecipients"|"sentCount"|"deliveredCount"|"failedCount"|"pendingCount"|"skippedCount"> {
  contentVariableBindings: Record<string, string>;
  audience:                FilterState;
  templateVariables:       { names: string[]; samples: Record<string, string> } | null;
}

export interface CampaignRecipient {
  id:                string;
  status:            string;
  errorCode:         string | null;
  errorMessage:      string | null;
  sentAt:            string | null;
  deliveredAt:       string | null;
  queuedAt:          string;
  resolvedVariables: Record<string, string> | null;
  partyName:         string | null;
  partyPhone:        string | null;
  leadNumber:        string | null;
}

export interface AudiencePreview {
  count: number;
  sample: Array<{
    partyId: string; workItemId: string; leadNumber: string;
    name: string | null; phone: string | null; program: string | null; stage: string | null;
  }>;
}

export async function getAudienceFields(): Promise<string[]> {
  const r = await get<{ fields: string[] }>("/campaigns/audience-fields");
  return r.fields;
}
export async function previewCampaignAudience(audience: FilterState): Promise<AudiencePreview> {
  return await post<AudiencePreview>("/campaigns/preview", { audience });
}
export async function createCampaign(input: {
  name: string;
  contentSid: string;
  contentVariableBindings: Record<string, string>;
  audience: FilterState;
  sendRatePerSec?: number;
  dailyCap?: number | null;
  scheduledAt?: string | null;
}): Promise<{ id: string; name: string; status: string; scheduledAt: string | null }> {
  return await post("/campaigns", input);
}
export async function scheduleCampaign(id: string): Promise<{ inserted: number; matched: number }> {
  return await post(`/campaigns/${encodeURIComponent(id)}/schedule`, {});
}
export async function pauseCampaign(id: string): Promise<{ id: string; status: string }> {
  return await post(`/campaigns/${encodeURIComponent(id)}/pause`, {});
}
export async function resumeCampaign(id: string): Promise<{ id: string; status: string }> {
  return await post(`/campaigns/${encodeURIComponent(id)}/resume`, {});
}
export async function cancelCampaign(id: string): Promise<{ id: string; status: string }> {
  return await post(`/campaigns/${encodeURIComponent(id)}/cancel`, {});
}
export async function listCampaigns(): Promise<CampaignSummary[]> {
  const r = await get<{ campaigns: CampaignSummary[] }>("/campaigns");
  return r.campaigns;
}
export async function getCampaign(id: string): Promise<CampaignDetail> {
  const r = await get<{ campaign: CampaignDetail }>(`/campaigns/${encodeURIComponent(id)}`);
  return r.campaign;
}
// ─── Triggers ─────────────────────────────────────────────────────────────

export interface CampaignTrigger {
  id:               string;
  name:             string;
  eventType:        string;
  condition:        Record<string, unknown>;
  contentSid:       string;
  templateName:     string | null;
  variableBindings: Record<string, string>;
  cooldownHours:    number;
  enabled:          boolean;
  autoCampaignId:   string | null;
  createdAt:        string;
  totalFires:       number;
}

export async function listCampaignTriggers(): Promise<CampaignTrigger[]> {
  const r = await get<{ triggers: CampaignTrigger[] }>("/campaigns/triggers/list");
  return r.triggers;
}
export async function createCampaignTrigger(input: {
  name: string;
  eventType: string;
  condition: Record<string, unknown>;
  contentSid: string;
  variableBindings: Record<string, string>;
  cooldownHours?: number;
  enabled?: boolean;
}): Promise<{ id: string; name: string; eventType: string; enabled: boolean }> {
  return await post("/campaigns/triggers", input);
}
export async function updateCampaignTrigger(id: string, patch: Partial<{
  name: string;
  condition: Record<string, unknown>;
  variableBindings: Record<string, string>;
  cooldownHours: number;
  enabled: boolean;
}>): Promise<{ id: string; name: string; eventType: string; enabled: boolean }> {
  return await send("PATCH", `/campaigns/triggers/${encodeURIComponent(id)}`, patch);
}
export async function deleteCampaignTrigger(id: string): Promise<{ ok: true }> {
  return await send("DELETE", `/campaigns/triggers/${encodeURIComponent(id)}`);
}

export async function getCampaignRecipients(
  id: string, opts?: { status?: string; limit?: number },
): Promise<CampaignRecipient[]> {
  const q = new URLSearchParams();
  if (opts?.status) q.set("status", opts.status);
  if (opts?.limit)  q.set("limit", String(opts.limit));
  const suffix = q.toString() ? `?${q}` : "";
  const r = await get<{ recipients: CampaignRecipient[] }>(
    `/campaigns/${encodeURIComponent(id)}/recipients${suffix}`,
  );
  return r.recipients;
}

/** Send within an existing thread. Channel is inferred from the thread. */
export async function sendTwMessageInThread(
  conversationId: string,
  body: string,
  mediaAssetIds: string[] = [],
): Promise<SendTwilioResult> {
  return await post(
    `/twilio/conversations/${encodeURIComponent(conversationId)}/messages`,
    { body, mediaAssetIds },
  );
}

// ── Gmail ────────────────────────────────────────────────────────────────

export async function getGmailStatus(): Promise<GmailStatus> {
  return await get<GmailStatus>("/auth/google/status");
}

/** Returns the Google consent URL to redirect the browser to. */
export async function getGmailAuthorizeUrl(returnTo: string, shared = true): Promise<string> {
  const { url } = await get<{ url: string }>(
    `/auth/google/authorize-url?returnTo=${encodeURIComponent(returnTo)}&shared=${shared ? "1" : "0"}`,
  );
  return url;
}

export async function disconnectGmail(): Promise<void> {
  await post("/auth/google/disconnect", {});
}

export interface SendEmailResult {
  ok: boolean;
  messageId: string;
  conversationId: string;
  from: string;
  to: string;
  error: string | null;
}

/**
 * Send an email. `to` is an address or a lead number ("LEAD-9865").
 * Pass `inReplyToMessageId` (a TwMessage.id) to reply inside an existing
 * thread — the API inherits the subject and the Gmail thread from the parent.
 */
export async function sendEmail(input: {
  to: string;
  subject?: string;
  body: string;
  bodyHtml?: string;
  cc?: string[];
  mediaAssetIds?: string[];
  inReplyToMessageId?: string;
}): Promise<SendEmailResult> {
  return await post("/gmail/send", input);
}

export async function markTwConversationRead(id: string): Promise<void> {
  await post<void>(`/twilio/conversations/${encodeURIComponent(id)}/read`, {});
}

export async function assignTwConversation(id: string, userId: string | null): Promise<void> {
  await post<void>(`/twilio/conversations/${encodeURIComponent(id)}/assign`, { userId });
}

export async function promoteTwConversationToLead(
  id: string,
  form?: CreateLeadInput,
): Promise<{ ok: boolean; number: string; alreadyLead: boolean }> {
  return await post(`/twilio/conversations/${encodeURIComponent(id)}/promote-to-lead`, form ?? {});
}

// ── Exotel click-to-call ─────────────────────────────────────────────────

export interface InitiateCallResponse {
  kind:            "ok";
  conversationId:  string;
  messageId:       string;
  callSid:         string | null;
  exotelOk:        boolean;
  errorCode:       string | null;
  errorMessage:    string | null;
  /** When true, the call was routed through EXOTEL_FALLBACK_AGENT_NUMBER
   *  because the advisor had no phone on file. Surface this in the UI so
   *  the advisor knows why their own phone didn't ring. */
  usingFallback:   boolean;
}

/** Fire a click-to-call. `to` may be `+91…` E.164 or a `LEAD-XXXX` number.
 *  Advisor's phone (from app_user.phone) rings first; on pickup, Exotel
 *  bridges the customer. Returns a `code`-tagged error on 4xx so the FE
 *  can render targeted messages (no phone, no consent, etc.). */
export async function initiateExotelCall(to: string): Promise<InitiateCallResponse> {
  return await post<InitiateCallResponse>("/exotel/call", { to });
}

// ── Media library ────────────────────────────────────────────────────────

import type { MediaFolder, MediaAsset } from "./types";
import { upload as vercelBlobUpload } from "@vercel/blob/client";

export async function listMediaFolders(): Promise<MediaFolder[]> {
  const { folders } = await get<{ folders: MediaFolder[] }>("/media/folders");
  return folders;
}

export async function createMediaFolder(name: string): Promise<MediaFolder> {
  return await post<MediaFolder>("/media/folders", { name });
}

export async function renameMediaFolder(id: string, name: string): Promise<void> {
  await send<void>("PATCH", `/media/folders/${encodeURIComponent(id)}`, { name });
}

export async function deleteMediaFolder(id: string): Promise<void> {
  await send<void>("DELETE", `/media/folders/${encodeURIComponent(id)}`);
}

export interface ListMediaAssetsFilter {
  folderId?:  string;
  /** 'library' shows shared library assets; 'mine' shows uploads by current user; 'all' shows both */
  scope?:     "library" | "mine" | "all";
}

export async function listMediaAssets(filter: ListMediaAssetsFilter = {}): Promise<MediaAsset[]> {
  const qs = new URLSearchParams();
  if (filter.folderId) qs.set("folder_id", filter.folderId);
  if (filter.scope)    qs.set("scope",     filter.scope);
  const path = qs.toString() ? `/media/assets?${qs}` : "/media/assets";
  const { assets } = await get<{ assets: MediaAsset[] }>(path);
  return assets;
}

export async function renameMediaAsset(id: string, patch: {
  filename?: string; folderId?: string | null; isLibrary?: boolean;
}): Promise<void> {
  await send<void>("PATCH", `/media/assets/${encodeURIComponent(id)}`, patch);
}

export async function deleteMediaAsset(id: string): Promise<void> {
  await send<void>("DELETE", `/media/assets/${encodeURIComponent(id)}`);
}

/**
 * Upload a file directly to Vercel Blob AND record it in our DB.
 *
 * Two-step under the hood:
 *   1. Browser → Vercel Blob directly (using a short-lived client token
 *      minted by our API's /media/upload-token endpoint). Bytes never
 *      touch our Express server, so the 6MB body cap doesn't apply.
 *   2. FE calls POST /media/assets with the resulting Blob URL and
 *      metadata. The API inserts the media_asset row.
 *
 * Vercel's built-in onUploadCompleted webhook is deliberately unused —
 * it requires Vercel's servers to reach our API, which fails on localhost
 * and any private network. Doing the DB insert from the FE is simpler
 * and works in every deploy target.
 *
 * Blob filenames get a random suffix (Vercel's `addRandomSuffix: true`)
 * so uploading two files with the same name doesn't collide on storage.
 * The original filename is preserved separately in `media_asset.filename`.
 */
export async function uploadMediaAsset(
  file: File,
  opts: { isLibrary?: boolean; folderId?: string | null } = {},
): Promise<MediaAsset> {
  const clientPayload = JSON.stringify({
    isLibrary: !!opts.isLibrary,
    folderId:  opts.folderId ?? null,
  });
  const authz = await authHeaders();

  // Step 1: upload bytes directly to Vercel Blob.
  const blob = await vercelBlobUpload(file.name, file, {
    access: "public",
    handleUploadUrl: `${API_URL}/media/upload-token`,
    clientPayload,
    contentType: file.type,
    headers: authz,
  });

  // Step 2: tell the API to record it. Vercel's `addRandomSuffix` (enabled
  // by default in the SDK) ensures the Blob URL is unique — but we always
  // store the user-facing name (`file.name`) so the UI shows the original.
  const asset = await post<MediaAsset>("/media/assets", {
    filename: file.name,
    contentType: file.type || blob.contentType || "application/octet-stream",
    sizeBytes: file.size,
    blobUrl: blob.url,
    blobPathname: blob.pathname,
    folderId: opts.folderId ?? null,
    isLibrary: !!opts.isLibrary,
  });
  return asset;
}

// Namespace import — the LMS surface adds ~20 types and listing them all in
// a named import would be noise.
import type * as T from "./types";

// ─── LMS — learner portal ─────────────────────────────────────────────────
// Everything here is scoped server-side to the signed-in learner. The client
// never passes a party id; the API derives it from the token and joins
// through batch_assignment. Don't add a "?partyId=" parameter to any of
// these — that would move an authorisation decision onto the client.

export async function getLmsMe(): Promise<T.LmsMe> {
  return get<T.LmsMe>("/lms/me");
}

export async function getLmsToday(): Promise<T.LmsToday> {
  return get<T.LmsToday>("/lms/today");
}

export async function getLmsBatches(): Promise<T.LmsBatchSummary[]> {
  const { batches } = await get<{ batches: T.LmsBatchSummary[] }>("/lms/batches");
  return batches;
}

export async function getLmsBatch(cohortId: string): Promise<T.LmsBatchDetail> {
  return get<T.LmsBatchDetail>(`/lms/batches/${encodeURIComponent(cohortId)}`);
}

export async function getLmsSchedule(days = 14): Promise<{ classes: T.LmsClass[]; deadlines: T.LmsDeadline[] }> {
  return get<{ classes: T.LmsClass[]; deadlines: T.LmsDeadline[] }>(`/lms/schedule?days=${days}`);
}

export async function getLmsWork(): Promise<T.LmsWork> {
  return get<T.LmsWork>("/lms/work");
}

/** Save playback position. Fired on a timer by the player, so keep it cheap.
 *  `completed` is sticky server-side — passing false never un-completes. */
export async function saveLmsProgress(
  resourceId: string,
  positionSeconds: number,
  completed = false,
): Promise<{ positionSeconds: number; completedAt: string | null }> {
  return send("PUT", `/lms/resources/${encodeURIComponent(resourceId)}/progress`, {
    positionSeconds: Math.max(0, Math.floor(positionSeconds)),
    completed,
  });
}

export async function submitLmsCoursework(
  courseworkId: string,
  content: Record<string, unknown>,
): Promise<{ id: string; status: string; submittedAt: string }> {
  return post(`/lms/coursework/${encodeURIComponent(courseworkId)}/submit`, { content });
}

// ─── LMS — admin ──────────────────────────────────────────────────────────

export async function getLmsAdminProgrammes(): Promise<T.LmsAdminProgramme[]> {
  const { programmes } = await get<{ programmes: T.LmsAdminProgramme[] }>("/lms-admin/programmes");
  return programmes;
}

export async function getLmsAdminBatches(
  q?: string,
  programme?: string,
): Promise<T.LmsAdminBatch[]> {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (programme) params.set("programme", programme);
  const qs = params.size ? `?${params}` : "";
  const { batches } = await get<{ batches: T.LmsAdminBatch[] }>(`/lms-admin/batches${qs}`);
  return batches;
}

export async function updateLmsBatch(
  id: string, patch: { status?: string; joinUrl?: string | null },
): Promise<T.LmsAdminBatch> {
  return send("PATCH", `/lms-admin/batches/${encodeURIComponent(id)}`, patch);
}

export async function getLmsAdminContent(cohortId: string): Promise<T.LmsAdminContent> {
  return get<T.LmsAdminContent>(`/lms-admin/batches/${encodeURIComponent(cohortId)}/modules`);
}

export async function createLmsModule(
  cohortId: string, body: { title: string; summary?: string | null; status?: string },
): Promise<T.LmsAdminModule> {
  return post(`/lms-admin/batches/${encodeURIComponent(cohortId)}/modules`, body);
}

export async function updateLmsModule(
  id: string, patch: Partial<{ title: string; summary: string | null; status: string; rank: number; enabled: boolean }>,
): Promise<T.LmsAdminModule> {
  return send("PATCH", `/lms-admin/modules/${encodeURIComponent(id)}`, patch);
}

export async function deleteLmsModule(id: string): Promise<void> {
  await send<void>("DELETE", `/lms-admin/modules/${encodeURIComponent(id)}`);
}

export async function createLmsResource(
  moduleId: string,
  body: {
    title: string; kind: T.ResourceKind; videoRef?: string | null;
    durationSeconds?: number | null; body?: string | null;
    externalUrl?: string | null; mediaAssetId?: string | null;
    batchSessionId?: string | null; required?: boolean;
  },
): Promise<T.LmsAdminResource> {
  return post(`/lms-admin/modules/${encodeURIComponent(moduleId)}/resources`, body);
}

export async function updateLmsResource(
  id: string, patch: Record<string, unknown>,
): Promise<T.LmsAdminResource> {
  return send("PATCH", `/lms-admin/resources/${encodeURIComponent(id)}`, patch);
}

export async function deleteLmsResource(id: string): Promise<void> {
  await send<void>("DELETE", `/lms-admin/resources/${encodeURIComponent(id)}`);
}

export async function createLmsCoursework(
  moduleId: string,
  body: {
    title: string; type: T.CourseworkType; brief?: string | null;
    maxScore?: number | null; passScore?: number | null;
    dueAt?: string | null; closesAt?: string | null; opensAt?: string | null;
  },
): Promise<T.LmsAdminCoursework> {
  return post(`/lms-admin/modules/${encodeURIComponent(moduleId)}/coursework`, body);
}

export async function updateLmsCoursework(
  id: string, patch: Record<string, unknown>,
): Promise<T.LmsAdminCoursework> {
  return send("PATCH", `/lms-admin/coursework/${encodeURIComponent(id)}`, patch);
}

export async function deleteLmsCoursework(id: string): Promise<void> {
  await send<void>("DELETE", `/lms-admin/coursework/${encodeURIComponent(id)}`);
}

export async function getLmsSubmissions(courseworkId: string): Promise<T.LmsSubmissionRow[]> {
  const { submissions } = await get<{ submissions: T.LmsSubmissionRow[] }>(
    `/lms-admin/coursework/${encodeURIComponent(courseworkId)}/submissions`,
  );
  return submissions;
}

export async function gradeLmsSubmission(
  id: string, body: { score: number; feedback?: string | null; status?: "graded" | "returned" },
): Promise<T.LmsSubmissionRow> {
  return send("PATCH", `/lms-admin/submissions/${encodeURIComponent(id)}`, body);
}

export async function copyLmsContent(
  targetCohortId: string, sourceCohortId: string,
): Promise<{ ok: true; modulesCopied: number; note: string }> {
  return post(
    `/lms-admin/batches/${encodeURIComponent(targetCohortId)}/copy-from/${encodeURIComponent(sourceCohortId)}`,
    {},
  );
}

// ─── LMS — private learner notes ──────────────────────────────────────────
// Scoped server-side to the caller. Never pass a party id from here.

export async function getLmsNotes(resourceId: string): Promise<T.LmsNote[]> {
  const { notes } = await get<{ notes: T.LmsNote[] }>(
    `/lms/resources/${encodeURIComponent(resourceId)}/notes`);
  return notes;
}

export async function addLmsNote(
  resourceId: string, body: string, positionSeconds = 0,
): Promise<T.LmsNote> {
  return post(`/lms/resources/${encodeURIComponent(resourceId)}/notes`,
    { body, positionSeconds });
}

export async function deleteLmsNote(id: string): Promise<void> {
  await send<void>("DELETE", `/lms/notes/${encodeURIComponent(id)}`);
}

// ═══ Workforce ═══════════════════════════════════════════════════════════

/** The staff directory. `trainersOnly` is what every trainer picker calls —
 *  a filter rather than a separate endpoint so the shape stays identical. */
export async function getWorkers(opts: {
  q?: string; trainersOnly?: boolean; includeExited?: boolean;
} = {}): Promise<T.Worker[]> {
  const qs = new URLSearchParams();
  if (opts.q) qs.set("q", opts.q);
  if (opts.trainersOnly) qs.set("trainers", "1");
  if (opts.includeExited) qs.set("includeExited", "1");
  const suffix = qs.toString() ? `?${qs}` : "";
  const { workers } = await get<{ workers: T.Worker[] }>(`/workers${suffix}`);
  return workers;
}

export async function getWorker(partyId: string): Promise<T.Worker> {
  const { worker } = await get<{ worker: T.Worker }>(`/workers/${encodeURIComponent(partyId)}`);
  return worker;
}

export async function createWorker(input: T.WorkerInput): Promise<T.Worker> {
  const { worker } = await post<{ worker: T.Worker }>("/workers", input);
  return worker;
}

export async function updateWorker(partyId: string, patch: T.WorkerInput): Promise<T.Worker> {
  const { worker } = await send<{ worker: T.Worker }>(
    "PATCH", `/workers/${encodeURIComponent(partyId)}`, patch);
  return worker;
}

// ═══ B2B — accounts and contacts ═════════════════════════════════════════

export async function getAccounts(opts: { q?: string; type?: string } = {}): Promise<T.Account[]> {
  const qs = new URLSearchParams();
  if (opts.q) qs.set("q", opts.q);
  if (opts.type) qs.set("type", opts.type);
  const suffix = qs.toString() ? `?${qs}` : "";
  const { accounts } = await get<{ accounts: T.Account[] }>(`/accounts${suffix}`);
  return accounts;
}

/** Detail carries the account's contacts, opportunities and requisitions. */
export async function getAccount(partyId: string): Promise<T.Account> {
  const { account } = await get<{ account: T.Account }>(`/accounts/${encodeURIComponent(partyId)}`);
  return account;
}

export async function createAccount(input: T.AccountInput): Promise<T.Account> {
  const { account } = await post<{ account: T.Account }>("/accounts", input);
  return account;
}

export async function updateAccount(partyId: string, patch: T.AccountInput): Promise<T.Account> {
  const { account } = await send<{ account: T.Account }>(
    "PATCH", `/accounts/${encodeURIComponent(partyId)}`, patch);
  return account;
}

export async function getContacts(opts: { q?: string; accountId?: string } = {}): Promise<T.Contact[]> {
  const qs = new URLSearchParams();
  if (opts.q) qs.set("q", opts.q);
  if (opts.accountId) qs.set("accountId", opts.accountId);
  const suffix = qs.toString() ? `?${qs}` : "";
  const { contacts } = await get<{ contacts: T.Contact[] }>(`/contacts${suffix}`);
  return contacts;
}

export async function createContact(input: T.ContactInput): Promise<T.Contact> {
  const { contact } = await post<{ contact: T.Contact }>("/contacts", input);
  return contact;
}

/** Passing a new accountPartyId end-dates the previous affiliation rather
 *  than editing it, so employment history survives. */
export async function updateContact(partyId: string, patch: T.ContactInput): Promise<T.Contact> {
  const { contact } = await send<{ contact: T.Contact }>(
    "PATCH", `/contacts/${encodeURIComponent(partyId)}`, patch);
  return contact;
}

// ═══ B2B — opportunity pipeline ══════════════════════════════════════════

/** Defaults to open deals only. stageTotals covers every stage regardless of
 *  the filter, so the board header stays honest while the list is narrowed. */
export async function getOpportunities(opts: {
  q?: string; stage?: string; accountId?: string; includeClosed?: boolean;
} = {}): Promise<{ opportunities: T.Opportunity[]; stageTotals: T.OpportunityStageTotal[] }> {
  const qs = new URLSearchParams();
  if (opts.q) qs.set("q", opts.q);
  if (opts.stage) qs.set("stage", opts.stage);
  if (opts.accountId) qs.set("accountId", opts.accountId);
  if (opts.includeClosed) qs.set("includeClosed", "1");
  const suffix = qs.toString() ? `?${qs}` : "";
  return get<{ opportunities: T.Opportunity[]; stageTotals: T.OpportunityStageTotal[] }>(
    `/opportunities${suffix}`);
}

export async function getOpportunity(workItemId: string): Promise<T.Opportunity> {
  const { opportunity } = await get<{ opportunity: T.Opportunity }>(
    `/opportunities/${encodeURIComponent(workItemId)}`);
  return opportunity;
}

export async function createOpportunity(input: T.OpportunityInput): Promise<T.Opportunity> {
  const { opportunity } = await post<{ opportunity: T.Opportunity }>("/opportunities", input);
  return opportunity;
}

/** Moving to closed_won / closed_lost sets the close date server-side when
 *  the caller does not supply one — dragging a card should just work. */
export async function updateOpportunity(
  workItemId: string, patch: T.OpportunityInput,
): Promise<T.Opportunity> {
  const { opportunity } = await send<{ opportunity: T.Opportunity }>(
    "PATCH", `/opportunities/${encodeURIComponent(workItemId)}`, patch);
  return opportunity;
}

// ═══ Staffing ════════════════════════════════════════════════════════════

export async function getRequisitions(opts: {
  q?: string; status?: string; accountId?: string;
} = {}): Promise<T.Requisition[]> {
  const qs = new URLSearchParams();
  if (opts.q) qs.set("q", opts.q);
  if (opts.status) qs.set("status", opts.status);
  if (opts.accountId) qs.set("accountId", opts.accountId);
  const suffix = qs.toString() ? `?${qs}` : "";
  const { requisitions } = await get<{ requisitions: T.Requisition[] }>(`/requisitions${suffix}`);
  return requisitions;
}

export async function getRequisition(id: string): Promise<T.Requisition> {
  const { requisition } = await get<{ requisition: T.Requisition }>(
    `/requisitions/${encodeURIComponent(id)}`);
  return requisition;
}

export async function createRequisition(input: T.RequisitionInput): Promise<T.Requisition> {
  const { requisition } = await post<{ requisition: T.Requisition }>("/requisitions", input);
  return requisition;
}

export async function updateRequisition(
  id: string, patch: T.RequisitionInput,
): Promise<T.Requisition> {
  const { requisition } = await send<{ requisition: T.Requisition }>(
    "PATCH", `/requisitions/${encodeURIComponent(id)}`, patch);
  return requisition;
}

/** `eligibleOnly` reads the candidate_eligible view — qualified AND consented
 *  AND profile ready/active. Use it for any "add to requisition" picker. */
export async function getCandidates(opts: {
  q?: string; eligibleOnly?: boolean;
} = {}): Promise<T.Candidate[]> {
  const qs = new URLSearchParams();
  if (opts.q) qs.set("q", opts.q);
  if (opts.eligibleOnly) qs.set("eligible", "1");
  const suffix = qs.toString() ? `?${qs}` : "";
  const { candidates } = await get<{ candidates: T.Candidate[] }>(`/candidates${suffix}`);
  return candidates;
}

export async function getCandidate(partyId: string): Promise<T.Candidate> {
  const { candidate } = await get<{ candidate: T.Candidate }>(
    `/candidates/${encodeURIComponent(partyId)}`);
  return candidate;
}

/** Requires the partyId of an existing learner — there is no path that
 *  creates a person here. */
export async function createCandidate(input: T.CandidateInput): Promise<T.Candidate> {
  const { candidate } = await post<{ candidate: T.Candidate }>("/candidates", input);
  return candidate;
}

export async function updateCandidate(
  partyId: string, patch: T.CandidateInput,
): Promise<T.Candidate> {
  const { candidate } = await send<{ candidate: T.Candidate }>(
    "PATCH", `/candidates/${encodeURIComponent(partyId)}`, patch);
  return candidate;
}

export async function getApplications(opts: {
  requisitionId?: string; candidateId?: string; stage?: string;
} = {}): Promise<T.JobApplication[]> {
  const qs = new URLSearchParams();
  if (opts.requisitionId) qs.set("requisitionId", opts.requisitionId);
  if (opts.candidateId) qs.set("candidateId", opts.candidateId);
  if (opts.stage) qs.set("stage", opts.stage);
  const suffix = qs.toString() ? `?${qs}` : "";
  const { applications } = await get<{ applications: T.JobApplication[] }>(`/applications${suffix}`);
  return applications;
}

/** Rejected by the API unless the candidate passes the eligibility gate and
 *  the requisition is open. */
export async function createApplication(input: T.ApplicationInput): Promise<T.JobApplication> {
  const { application } = await post<{ application: T.JobApplication }>("/applications", input);
  return application;
}

/** Moving to hired / rejected / withdrawn needs staffing.decide, not
 *  staffing.write — and 'rejected' needs a rejectionReason. */
export async function updateApplication(
  id: string, patch: T.ApplicationInput,
): Promise<T.JobApplication> {
  const { application } = await send<{ application: T.JobApplication }>(
    "PATCH", `/applications/${encodeURIComponent(id)}`, patch);
  return application;
}

// ═══ post-0088 field sets ════════════════════════════════════════════════

/** The enrolment's own attributes — owner, mode, timezone, dates and the two
 *  admission gates. Deliberately separate from `updateEnrollmentFee`, which
 *  keeps its own ledger trail; money is not settable here. */
export async function updateEnrollment(
  idOrNumber: string,
  patch: {
    advisorId?: string | null;
    deliveryMode?: T.DeliveryMode | null;
    timezone?: string | null;
    startDate?: string | null;
    expectedCompletionDate?: string | null;
    admissionChecklistStatus?: "pending" | "partial" | "complete";
    identityProofStatus?: "not_submitted" | "submitted" | "verified" | "rejected";
    staffingInterest?: boolean;
  },
): Promise<{ ok: true; enrolment: Record<string, unknown> }> {
  return send("PATCH", `/enrollments/${encodeURIComponent(idOrNumber)}`, patch);
}

/** Progress, risk, and the staffing gate.
 *
 *  The two staffing fields live on the learner rather than on their candidate
 *  record so that withdrawing consent removes them from staffing however many
 *  applications are open — the `candidate_eligible` view reads exactly these.
 *  Setting consent to 'granted' stamps the timestamp server-side. */
export async function updateLearnerProfile(
  partyId: string,
  patch: T.LearnerProfileInput,
): Promise<{ ok: true; profile: Record<string, unknown> }> {
  return send("PATCH", `/learners/${encodeURIComponent(partyId)}/profile`, patch);
}
