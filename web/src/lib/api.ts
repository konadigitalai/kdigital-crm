// Typed fetch helpers. Server Components call these; they hit the Express API.
//
// API_URL: set in .env.local. Defaults to localhost:4000.
// All routes are tenant-scoped on the server side via `tenantMiddleware`.

import type {
  AgentCard, Batch, BatchInput, CatalogResponse, Course, CourseInput, CreateLeadInput, CurrentUser,
  EnrolmentStatus, FeedItem, Lead, LearnerRecord, LearnerSummary, PipelineColumn, Program,
  RecentRun, RecordResponse, SummaryResponse,
} from "./types";

// On the server: prefer API_URL, fall back to NEXT_PUBLIC_API_URL.
// In the browser: NEXT_PUBLIC_API_URL only (must be exposed at build time).
// In dev (NODE_ENV !== production), default to localhost so things "just work".
const isServer = typeof window === "undefined";
const API_URL =
  (isServer ? (process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL) : process.env.NEXT_PUBLIC_API_URL)
  ?? (process.env.NODE_ENV === "production" ? undefined : "http://localhost:4000");

if (!API_URL) {
  // In production, surface a clear error instead of failing with ECONNREFUSED.
  throw new Error(
    "API URL is not configured. Set NEXT_PUBLIC_API_URL (and optionally API_URL on the server) in your environment.",
  );
}

async function get<T>(path: string): Promise<T> {
  // Disable Next's fetch cache so editing rows in Drizzle Studio shows up on refresh.
  const r = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${await r.text()}`);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${await r.text()}`);
  return r.json() as Promise<T>;
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
  const { runs } = await get<{ runs: AgentCard[] }>("/agents/runs");
  return runs;
}

export async function getRecentRuns(): Promise<RecentRun[]> {
  const { recent } = await get<{ recent: RecentRun[] }>("/agents/recent");
  return recent;
}

export async function getActivityFeed(limit = 10): Promise<FeedItem[]> {
  const { feed } = await get<{ feed: FeedItem[] }>(`/activity?limit=${limit}`);
  return feed;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const { me } = await get<{ me: CurrentUser | null }>("/me");
  return me;
}

export async function getSummary(): Promise<SummaryResponse> {
  return await get<SummaryResponse>("/summary");
}

export async function getCatalog(): Promise<CatalogResponse> {
  return await get<CatalogResponse>("/catalog");
}

// ── Programs CRUD ──────────────────────────────────────────────────────────

export async function getPrograms(): Promise<Program[]> {
  const { programs } = await get<{ programs: Program[] }>("/programs");
  return programs;
}

export async function createProgram(input: { name: string; track?: string; price?: string }): Promise<Program> {
  const { program } = await post<{ program: Program }>("/programs", input);
  return program;
}

export async function updateProgram(
  id: string,
  patch: { name?: string; track?: string | null; enabled?: boolean },
): Promise<Program> {
  const r = await fetch(`${API_URL}/programs/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`PATCH /programs/${id} → ${r.status}: ${await r.text()}`);
  const { program } = (await r.json()) as { program: Program };
  return program;
}

// ── Lead edit / actions ───────────────────────────────────────────────────

export async function updateLead(idOrNumber: string, patch: Partial<{
  name: string; email: string | null; phone: string | null; city: string | null;
  value: string | null; source: string; sourceLabel: string;
  stage: string; score: number; heat: string;
  nbaLabel: string; nbaIcon: string;
  programId: string | null; advisorId: string | null;
}>): Promise<void> {
  const r = await fetch(`${API_URL}/leads/${encodeURIComponent(idOrNumber)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`PATCH /leads/${idOrNumber} → ${r.status}: ${await r.text()}`);
}

export async function addLeadNote(idOrNumber: string, text: string): Promise<{ id: string }> {
  const r = await fetch(`${API_URL}/leads/${encodeURIComponent(idOrNumber)}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`POST /notes → ${r.status}: ${await r.text()}`);
  return (await r.json()) as { id: string };
}

export async function updateLeadNote(
  idOrNumber: string,
  activityId: string,
  text: string,
): Promise<void> {
  const r = await fetch(
    `${API_URL}/leads/${encodeURIComponent(idOrNumber)}/notes/${encodeURIComponent(activityId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ text }),
    },
  );
  if (!r.ok) throw new Error(`PATCH /notes → ${r.status}: ${await r.text()}`);
}

export async function logLeadComm(
  idOrNumber: string,
  body: { kind: "email" | "schedule"; subject?: string; body?: string; when?: string },
): Promise<void> {
  const r = await fetch(`${API_URL}/leads/${encodeURIComponent(idOrNumber)}/comms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST /comms → ${r.status}: ${await r.text()}`);
}

export async function decideApproval(
  approvalId: string,
  decision: "approve" | "reject",
  proposed?: Record<string, unknown>,
): Promise<void> {
  const r = await fetch(`${API_URL}/approvals/${encodeURIComponent(approvalId)}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ decision, ...(proposed ? { proposed } : {}) }),
  });
  if (!r.ok) throw new Error(`POST /approvals/decide → ${r.status}: ${await r.text()}`);
}

export async function convertLead(
  idOrNumber: string,
  body: { programId?: string; pricePaid?: string } = {},
): Promise<{ partyId: string; enrolmentId: string }> {
  const r = await fetch(`${API_URL}/leads/${encodeURIComponent(idOrNumber)}/convert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`POST /leads/${idOrNumber}/convert → ${r.status}: ${text}`);
  }
  return (await r.json()) as { partyId: string; enrolmentId: string };
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
  const r = await fetch(`${API_URL}/courses/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`PATCH /courses/${id} → ${r.status}: ${await r.text()}`);
  const { course } = (await r.json()) as { course: Course };
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
  const r = await fetch(`${API_URL}/cohorts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`PATCH /cohorts/${id} → ${r.status}: ${await r.text()}`);
  const { cohort } = (await r.json()) as { cohort: Batch };
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

export async function assignLearnerToBatch(partyId: string, cohortId: string): Promise<{ enrolmentId: string }> {
  const r = await fetch(`${API_URL}/learners/${encodeURIComponent(partyId)}/batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ cohortId }),
  });
  if (!r.ok) throw new Error(`POST /learners/${partyId}/batches → ${r.status}: ${await r.text()}`);
  return (await r.json()) as { enrolmentId: string };
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
  const r = await fetch(`${API_URL}/learners/${encodeURIComponent(partyId)}/courses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ courseIds }),
  });
  // The API returns 201 (some added) or 409 (none added) — both contain a
  // useful body. Only treat genuine network/non-JSON errors as exceptions.
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
  const r = await fetch(
    `${API_URL}/learners/${encodeURIComponent(partyId)}/courses/${encodeURIComponent(courseAssignmentId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ status }),
    },
  );
  if (!r.ok) throw new Error(`PATCH course-assignment → ${r.status}: ${await r.text()}`);
}

export async function updateEnrolmentStatus(
  partyId: string,
  enrolmentId: string,
  status: EnrolmentStatus,
): Promise<void> {
  const r = await fetch(`${API_URL}/learners/${encodeURIComponent(partyId)}/batches/${encodeURIComponent(enrolmentId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ status }),
  });
  if (!r.ok) throw new Error(`PATCH enrolment → ${r.status}: ${await r.text()}`);
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
