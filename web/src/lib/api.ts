// Typed fetch helpers. Server Components call these; they hit the Express API.
//
// API_URL: set in .env.local. Defaults to localhost:4000.
// All routes are tenant-scoped on the server side via `tenantMiddleware`.

import type {
  AdminUser, Advisor, AdvisorInput, AdvisorRole, AgentCard, AgentCatalogEntry, AgentMode, AgentRunRecord, Batch, BatchInput, BatchSession,
  CalendarEventDetail, CalendarEventSummary, CatalogResponse,
  Course, CourseInput, CreateLeadInput, CurrentUser,
  Case, CaseDashboard, CaseDetail, CaseResolutionCode,
  CreateCaseInput, DeletedLead, EdifyAnswer, EdifySessionSummary, EnrolmentStatus, EventRsvp, FeedItem,
  ForecastSnapshot, GroupsResponse, Lead, LeaveDay, LeaveHalfDay, LeaveKind, LearnerFeeInput, LearnerRecord, LearnerSummary,
  PaymentStatus,
  PipelineColumn, Program, ProgramInput, RecentRun, RecordResponse,
  SavedView, SavedViewInput, SavedViewScope,
  ShareSurface,
  SlackDelivery, SlackRule, SlackRuleInput,
  SlackSharePreview, SlackShareTarget, SlackShareTargetInput, SlackShareTargetsResponse,
  Stack,
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

async function get<T>(path: string): Promise<T> {
  const headers = await authHeaders();
  const r = await fetch(`${API_URL}${path}`, {
    cache: "no-store",
    credentials: "include",
    headers,
  });
  if (!r.ok) await failResponse("GET", path, r);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const headers = { "Content-Type": "application/json", ...(await authHeaders()) };
  const r = await fetch(`${API_URL}${path}`, {
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
  const r = await fetch(`${API_URL}${path}`, {
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
    throw err;
  }
}

export async function getRecentRuns(): Promise<RecentRun[]> {
  try {
    const { recent } = await get<{ recent: RecentRun[] }>("/agents/recent");
    return recent;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
    throw err;
  }
}

export async function getActivityFeed(limit = 10): Promise<FeedItem[]> {
  try {
    const { feed } = await get<{ feed: FeedItem[] }>(`/activity?limit=${limit}`);
    return feed;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
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
    throw err;
  }
}

export async function getSummary(): Promise<SummaryResponse> {
  try {
    return await get<SummaryResponse>("/summary");
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) {
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
  return await get<CatalogResponse>("/catalog");
}

// ── Programs CRUD ──────────────────────────────────────────────────────────

export async function getPrograms(): Promise<Program[]> {
  const { programs } = await get<{ programs: Program[] }>("/programs");
  return programs;
}

export async function createProgram(input: ProgramInput): Promise<Program> {
  const { program } = await post<{ program: Program }>("/programs", input);
  return program;
}

export async function updateProgram(id: string, patch: Partial<ProgramInput>): Promise<Program> {
  const { program } = await send<{ program: Program }>("PATCH", `/programs/${id}`, patch);
  return program;
}

// ── Stacks ────────────────────────────────────────────────────────────────

export async function getStacks(): Promise<Stack[]> {
  const { stacks } = await get<{ stacks: Stack[] }>("/stacks");
  return stacks;
}

export async function createStack(input: { name: string; description?: string | null }): Promise<Stack> {
  const { stack } = await post<{ stack: Stack }>("/stacks", input);
  return stack;
}

export async function updateStack(
  id: string,
  patch: { name?: string; description?: string | null; enabled?: boolean },
): Promise<Stack> {
  const { stack } = await send<{ stack: Stack }>("PATCH", `/stacks/${id}`, patch);
  return stack;
}

// ── Advisors (Manage Advisors admin page) ────────────────────────────────

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
  deliveryMode: "online" | "offline" | "hybrid" | null;
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
  deliveryMode?:   "online" | "offline" | "hybrid" | null;
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

// ── Courses ───────────────────────────────────────────────────────────────

export async function getCourses(): Promise<Course[]> {
  const { courses } = await get<{ courses: Course[] }>("/courses");
  return courses;
}

export async function createCourse(input: CourseInput): Promise<Course> {
  const { course } = await post<{ course: Course }>("/courses", input);
  return course;
}

export async function updateCourse(id: string, patch: Partial<CourseInput>): Promise<Course> {
  const { course } = await send<{ course: Course }>("PATCH", `/courses/${id}`, patch);
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

// ── Cases ─────────────────────────────────────────────────────────────────

export interface CaseFilter {
  status?: string;
  assigneeId?: string;
  category?: string;
  priority?: number;
  requesterKind?: string;
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
  }>,
): Promise<void> {
  await send<void>("PATCH", `/cases/${encodeURIComponent(idOrNumber)}`, patch);
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
): Promise<void> {
  await post<void>(
    `/share/slack/${encodeURIComponent(surface)}/${encodeURIComponent(recordId)}`,
    { notes },
  );
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
    throw err;
  }
}

export async function getAgentRunHistory(key: string, limit = 10): Promise<AgentRunRecord[]> {
  try {
    const { runs } = await get<{ runs: AgentRunRecord[] }>(`/agents/${encodeURIComponent(key)}/runs?limit=${limit}`);
    return runs;
  } catch (err) {
    if ((err as Error).message.includes("→ 401")) return [];
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

// ── WhatsApp ────────────────────────────────────────────────────────────

import type {
  WaAutomationAction, WaAutomationListItem, WaAutomationRunItem, WaAutomationTrigger,
  WaBroadcastDetail, WaBroadcastListItem,
  WaConfig, WaConversationDetail, WaConversationListItem,
  WaConversationStatus, WaTag, WaTemplate,
} from "./types";

export async function getWaConfig(): Promise<WaConfig> {
  return await get<WaConfig>("/whatsapp/config");
}

export async function saveWaConfig(input: {
  credentials: {
    phone_number_id: string;
    waba_id: string;
    app_id: string;
    app_secret: string;
    system_user_token: string;
    webhook_verify_token: string;
  };
}): Promise<{ ok: boolean; status: "connected" | "disconnected"; verify: { ok: boolean; httpStatus: number; data?: unknown; error?: string } }> {
  return await post("/whatsapp/config", input);
}

export async function deleteWaConfig(): Promise<void> {
  await send<void>("DELETE", "/whatsapp/config");
}

export async function verifyWaConnection(): Promise<{ ok: boolean; httpStatus: number; data?: unknown; error?: string }> {
  return await post("/whatsapp/config/verify", {});
}

export async function registerWaPhone(pin: string): Promise<{ ok: boolean; httpStatus: number; error?: string }> {
  return await post("/whatsapp/config/register", { pin });
}

export async function subscribeWaWaba(): Promise<{ ok: boolean; httpStatus: number; error?: string }> {
  return await post("/whatsapp/config/subscribe", {});
}

export async function getWaTemplates(): Promise<WaTemplate[]> {
  const { templates } = await get<{ templates: WaTemplate[] }>("/whatsapp/templates");
  return templates;
}

export async function syncWaTemplates(): Promise<{ ok: boolean; inserted: number; updated: number; total: number }> {
  return await post("/whatsapp/templates/sync", {});
}

export async function getWaTags(): Promise<WaTag[]> {
  const { tags } = await get<{ tags: WaTag[] }>("/whatsapp/tags");
  return tags;
}

export async function createWaTag(input: { name: string; color: string }): Promise<WaTag> {
  const { tag } = await post<{ tag: WaTag }>("/whatsapp/tags", input);
  return tag;
}

export async function deleteWaTag(id: string): Promise<void> {
  await send<void>("DELETE", `/whatsapp/tags/${encodeURIComponent(id)}`);
}

export interface WaConversationFilter {
  status?: "all" | WaConversationStatus;
  assignee?: "me" | "unassigned" | string;       // userId
  q?: string;
  limit?: number;
}

export async function getWaConversations(filter: WaConversationFilter = {}): Promise<WaConversationListItem[]> {
  const qs = new URLSearchParams();
  if (filter.status)   qs.set("status", filter.status);
  if (filter.assignee) qs.set("assignee", filter.assignee);
  if (filter.q)        qs.set("q", filter.q);
  if (filter.limit)    qs.set("limit", String(filter.limit));
  const path = qs.toString() ? `/whatsapp/conversations?${qs}` : "/whatsapp/conversations";
  const { conversations } = await get<{ conversations: WaConversationListItem[] }>(path);
  return conversations;
}

export async function getWaConversation(id: string): Promise<WaConversationDetail> {
  return await get<WaConversationDetail>(`/whatsapp/conversations/${encodeURIComponent(id)}`);
}

export async function sendWaMessage(
  conversationId: string,
  body: { body?: string; templateId?: string; variables?: Record<string, string> },
): Promise<{ ok: boolean; messageId: string; providerMessageId?: string | null; error?: string; httpStatus?: number }> {
  try {
    return await post(
      `/whatsapp/conversations/${encodeURIComponent(conversationId)}/messages`,
      body,
    );
  } catch (err) {
    if (err instanceof ApiError) {
      const b = err.body as { error?: string; messageId?: string; httpStatus?: number } | undefined;
      return {
        ok: false,
        messageId: b?.messageId ?? "",
        error: b?.error ?? err.message,
        httpStatus: b?.httpStatus ?? err.status,
      };
    }
    throw err;
  }
}

export async function assignWaConversation(id: string, userId: string | null): Promise<void> {
  await post<void>(`/whatsapp/conversations/${encodeURIComponent(id)}/assign`, { userId });
}

export async function setWaConversationStatus(id: string, status: WaConversationStatus): Promise<void> {
  await post<void>(`/whatsapp/conversations/${encodeURIComponent(id)}/status`, { status });
}

export async function markWaConversationRead(id: string): Promise<void> {
  await post<void>(`/whatsapp/conversations/${encodeURIComponent(id)}/read`, {});
}

export async function tagWaConversation(id: string, tagId: string): Promise<void> {
  await post<void>(`/whatsapp/conversations/${encodeURIComponent(id)}/tag`, { tagId });
}

export async function untagWaConversation(id: string, tagId: string): Promise<void> {
  await send<void>("DELETE", `/whatsapp/conversations/${encodeURIComponent(id)}/tag/${encodeURIComponent(tagId)}`);
}

export async function promoteWaConversationToLead(id: string): Promise<{ ok: boolean; number: string; alreadyLead: boolean }> {
  return await post(`/whatsapp/conversations/${encodeURIComponent(id)}/promote-to-lead`, {});
}

// ─── Broadcasts ─────────────────────────────────────────────────────────

export async function getWaBroadcasts(): Promise<WaBroadcastListItem[]> {
  const { broadcasts } = await get<{ broadcasts: WaBroadcastListItem[] }>("/whatsapp/broadcasts");
  return broadcasts;
}

export async function getWaBroadcast(id: string): Promise<WaBroadcastDetail> {
  return await get<WaBroadcastDetail>(`/whatsapp/broadcasts/${encodeURIComponent(id)}`);
}

export async function createWaBroadcast(input: {
  name: string;
  templateId: string;
  defaultVariables?: Record<string, string>;
  scheduledAt?: string | null;
}): Promise<{ id: string }> {
  return await post("/whatsapp/broadcasts", input);
}

export async function addWaBroadcastRecipients(
  id: string,
  input: { partyIds?: string[]; entries?: { phone: string; variables?: Record<string, string> }[] },
): Promise<{ ok: boolean; added: number }> {
  return await post(`/whatsapp/broadcasts/${encodeURIComponent(id)}/recipients`, input);
}

export async function removeWaBroadcastRecipient(id: string, recipientId: string): Promise<void> {
  await send<void>(
    "DELETE",
    `/whatsapp/broadcasts/${encodeURIComponent(id)}/recipients/${encodeURIComponent(recipientId)}`,
  );
}

export async function sendWaBroadcast(id: string): Promise<{ ok: boolean }> {
  return await post(`/whatsapp/broadcasts/${encodeURIComponent(id)}/send`, {});
}

export async function cancelWaBroadcast(id: string): Promise<{ ok: boolean }> {
  return await post(`/whatsapp/broadcasts/${encodeURIComponent(id)}/cancel`, {});
}

export async function deleteWaBroadcast(id: string): Promise<void> {
  await send<void>("DELETE", `/whatsapp/broadcasts/${encodeURIComponent(id)}`);
}

// ─── Automations ────────────────────────────────────────────────────────

export async function getWaAutomations(): Promise<WaAutomationListItem[]> {
  const { automations } = await get<{ automations: WaAutomationListItem[] }>("/whatsapp/automations");
  return automations;
}

export async function getWaAutomation(id: string): Promise<WaAutomationListItem> {
  const { automation } = await get<{ automation: WaAutomationListItem }>(`/whatsapp/automations/${encodeURIComponent(id)}`);
  return automation;
}

export interface WaAutomationInput {
  name: string;
  description?: string | null;
  trigger: WaAutomationTrigger;
  actions: WaAutomationAction[];
  enabled?: boolean;
}

export async function createWaAutomation(input: WaAutomationInput): Promise<{ id: string }> {
  return await post("/whatsapp/automations", input);
}

export async function updateWaAutomation(id: string, input: WaAutomationInput): Promise<{ ok: boolean }> {
  return await send("PATCH", `/whatsapp/automations/${encodeURIComponent(id)}`, input);
}

export async function setWaAutomationEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; enabled: boolean }> {
  return await send("PATCH", `/whatsapp/automations/${encodeURIComponent(id)}/enabled`, { enabled });
}

export async function deleteWaAutomation(id: string): Promise<void> {
  await send<void>("DELETE", `/whatsapp/automations/${encodeURIComponent(id)}`);
}

export async function getWaAutomationRuns(id: string, limit = 50): Promise<WaAutomationRunItem[]> {
  const { runs } = await get<{ runs: WaAutomationRunItem[] }>(
    `/whatsapp/automations/${encodeURIComponent(id)}/runs?limit=${limit}`,
  );
  return runs;
}
