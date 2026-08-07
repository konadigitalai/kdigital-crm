// The mount table — ported verbatim from the old api/src/index.ts.
//
// This file is the security boundary of the whole API. Every `app.use` line
// below is what stands between an HTTP request and 253 handlers across 48
// routers, and the ORDER of these lines is load-bearing:
//
//   • Everything above `app.use(requireAuth)` is deliberately public.
//   • Everything below it is authenticated, and most lines add a permission
//     guard on top.
//
// Do not reorder. Moving a mount above `requireAuth` silently makes an entire
// router public — no error, no failing test.
//
// The body parsers and `app.listen` from the original are gone: parsing now
// happens in server/http/request.ts, and Next.js's catch-all route handler
// (src/app/api/[...path]/route.ts) is what invokes `handle()`.

import { createApp, type ApiRequest, type ApiResponse, type Handler, type NextFunction } from "@/server/http";
import { authMiddleware } from "./middleware/auth";
import { requirePermission, requireAnyPermission } from "./middleware/require";
import { appPool } from "./db/app";

import { leadsRouter } from "./routes/leads";
import { intakeRouter } from "./routes/intake";
import { pipelineRouter } from "./routes/pipeline";
import { activityRouter } from "./routes/activity";
import { agentsRouter } from "./routes/agents";
import { recordsRouter } from "./routes/records";
import { meRouter } from "./routes/me";
import { summaryRouter } from "./routes/summary";
import { catalogRouter } from "./routes/catalog";
import { workersRouter } from "./routes/workers";
import { accountsRouter, contactsRouter } from "./routes/accounts";
import { opportunitiesRouter } from "./routes/opportunities";
import { requisitionsRouter, candidatesRouter, applicationsRouter } from "./routes/staffing";
import { programsRouter } from "./routes/programs";
import { cohortsRouter } from "./routes/cohorts";
import { coursesRouter } from "./routes/courses";
import { convertRouter } from "./routes/convert";
import { learnersRouter } from "./routes/learners";
import { lmsRouter } from "./routes/lms";
import { lmsAdminRouter } from "./routes/lmsAdmin";
import { enrollmentsRouter } from "./routes/enrollments";
import { approvalsRouter } from "./routes/approvals";
import { casesRouter } from "./routes/cases";
import { usersRouter } from "./routes/users";
import { advisorsRouter } from "./routes/advisors";
import { groupsRouter } from "./routes/groups";
import { leavesRouter } from "./routes/leaves";
import { eventsRouter } from "./routes/events";
import { tasksRouter } from "./routes/tasks";
import { messageTemplatesRouter } from "./routes/message-templates";
import { batchesRouter } from "./routes/batches";
import { batchBoardRouter } from "./routes/batchBoard";
import { viewsRouter } from "./routes/views";
import { integrationsRouter } from "./routes/integrations";
import { shareRouter } from "./routes/share";
import { shareSlackUserRouter } from "./routes/share-slack-user";
import { slackOAuthRouter, slackOAuthCallbackRouter } from "./routes/slack-oauth";
import { googleOAuthRouter, googleOAuthCallbackRouter } from "./routes/google-oauth";
import { gmailRouter } from "./routes/gmail";
import { partiesRouter } from "./routes/parties";
import { partyConsentRouter } from "./routes/party-consent";
import { twilioRouter } from "./routes/twilio";
import { twilioWebhookRouter } from "./routes/twilio-webhook";
import { exotelRouter } from "./routes/exotel";
import { exotelWebhookRouter } from "./routes/exotel-webhook";
import { templatesRouter } from "./routes/templates";
import { campaignsRouter } from "./routes/campaigns";
import { mediaRouter, mediaFetchRouter } from "./routes/media";

const app = createApp();

// ── Webhooks ───────────────────────────────────────────────────────────────
// Mounted first, exactly as before. The body-parser mounts that used to
// precede them are unnecessary now: request.ts parses by Content-Type and
// always retains rawBody, which is what Twilio's HMAC-SHA1 check reads.
app.use("/webhooks/twilio", twilioWebhookRouter);
app.use("/webhooks/exotel", exotelWebhookRouter);

// ── CORS ───────────────────────────────────────────────────────────────────
// Far less load-bearing than it was: the browser now reaches these handlers
// same-origin, so the third-party-cookie problem the /api rewrite existed to
// dodge is gone along with the separate API host. It stays for the one genuine
// cross-origin caller — the public lead-intake endpoint, which is posted to by
// the marketing site and ad landing pages on other domains.
const corsAllowed = (process.env.CORS_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req: ApiRequest, res: ApiResponse, next: NextFunction) => {
  const reqOrigin = req.headers["origin"];
  if (reqOrigin && corsAllowed.includes(reqOrigin)) {
    res.header("Access-Control-Allow-Origin", reqOrigin);
    res.header("Access-Control-Allow-Credentials", "true");
  }
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Intake-Key");
  res.header("Access-Control-Expose-Headers", "Server-Timing");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

// ── Public ─────────────────────────────────────────────────────────────────
app.get("/health", async (_req: ApiRequest, res: ApiResponse) => {
  try {
    const r = await appPool.query<{ now: Date }>("SELECT now() AS now");
    res.json({ ok: true, db: { now: r.rows[0]?.now } });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// Public lead-intake endpoint (marketing website form, ad landing pages, …).
// Gated by INTAKE_API_KEY env var + a per-IP rate limit inside the router —
// it deliberately sits BEFORE requireAuth so no Auth0 token is needed.
app.use("/leads/intake", intakeRouter);

// Slack OAuth callback — Slack redirects the user's browser here after
// they approve the "Connect Slack" screen. The browser has NO auth
// cookies for the API on this hop; security comes from the signed
// state param the API included when it sent them to Slack.
app.use("/auth/slack", slackOAuthCallbackRouter);

// Google OAuth callback — same deal as Slack above.
app.use("/auth/google", googleOAuthCallbackRouter);

// Public signed-URL fetch for outbound Twilio media. Twilio has no JWT;
// authentication is a short-lived HMAC in the querystring.
app.use("/media/fetch", mediaFetchRouter);

// ── Authenticated ──────────────────────────────────────────────────────────
// Auth is owned by Auth0 (see middleware/auth.ts — verifies the Bearer JWT
// against Auth0's JWKS). Everything registered below this line is private.
app.use(authMiddleware);
app.use("/me", meRouter);

// Slack / Gmail connect+disconnect — need req.userId, so behind auth.
app.use("/auth/slack", slackOAuthRouter);
app.use("/auth/google", googleOAuthRouter);

// Method-aware guard: reads need readPerm, mutating verbs need writePerm.
// We treat GET as the read fence so routes with PATCH/POST/DELETE always
// fall through the write check (POST /:id/notes, POST /:id/comms, etc.).
type Perm = Parameters<typeof requirePermission>[0];
const readWrite = (readPerm: Perm, writePerm: Perm): Handler =>
  (req, res, next) => {
    const perm = req.method === "GET" ? readPerm : writePerm;
    return requirePermission(perm)(req, res, next);
  };
const writeOnly = (perm: Perm): Handler =>
  (req, res, next) => {
    if (req.method === "GET") return next();
    return requirePermission(perm)(req, res, next);
  };
// Like readWrite, but with a separate gate for DELETE — used by /leads where
// deletion is a strictly higher privilege than write.
const readWriteDelete = (readPerm: Perm, writePerm: Perm, deletePerm: Perm): Handler =>
  (req, res, next) => {
    const perm =
      req.method === "GET"    ? readPerm
    : req.method === "DELETE" ? deletePerm
    :                           writePerm;
    return requirePermission(perm)(req, res, next);
  };

app.use("/leads",    readWriteDelete("leads.read", "leads.write", "leads.delete"), leadsRouter);
app.use("/leads",    requirePermission("leads.write"),             convertRouter); // POST /leads/:idOrNumber/convert|/enroll
app.use("/learners", readWrite("learners.read", "learners.write"), learnersRouter);
// Enrollments — the enrolment record + fee ledger + payment verification +
// enrolled→learner conversion. Reuses the learners permission surface.
app.use("/enrollments", readWrite("learners.read", "learners.write"), enrollmentsRouter);
// ─── LMS ─────────────────────────────────────────────────────────────────
// /lms is the student portal. Every handler re-derives access from the
// caller's party_id via batch_assignment — RLS is tenant-scoped and will
// NOT keep one learner out of another's rows. See routes/lms.ts.
app.use("/lms", requirePermission("lms.read.self"), lmsRouter);
// /lms-admin builds batch content. Deliberately not gated on
// admin.batches.manage: that would surface the whole CRM Batches module in
// an LMS admin's sidebar. Grading is gated separately on lms.grade.
app.use("/lms-admin", requirePermission("lms.content.manage"), lmsAdminRouter);

app.use("/approvals", approvalsRouter);
app.use("/cases",    readWrite("cases.read",    "cases.write"),    casesRouter);
app.use("/pipeline", readWrite("pipeline.read", "pipeline.write"), pipelineRouter);
// /activity is the home-page agent feed (tag IN auto/sent/need), not the
// per-record timeline (which lives behind /records/:id).
app.use("/activity", requirePermission("agents.read"),             activityRouter);
app.use("/agents",   agentsRouter);
app.use("/records",  requirePermission("leads.read"),              recordsRouter);
app.use("/summary",  summaryRouter);
app.use("/catalog",  catalogRouter);
// programs/courses/cohorts: GET is readable by any authenticated user
// (admin dialogs need them); writes require the manage permission.
app.use("/programs", writeOnly("admin.programs.manage"), programsRouter);
app.use("/cohorts",  writeOnly("admin.batches.manage"),  cohortsRouter);
app.use("/courses",  writeOnly("admin.courses.manage"),  coursesRouter);
// ─── Workforce ───────────────────────────────────────────────────────────
// Read and manage are split: every trainer/owner picker in the app needs to
// READ the directory, while editing someone's reporting line or exit date is
// an HR action.
app.use("/workers", readWrite("workers.read", "workers.manage"), workersRouter);

// ─── B2B ─────────────────────────────────────────────────────────────────
app.use("/accounts",      readWrite("accounts.read",      "accounts.write"),      accountsRouter);
app.use("/contacts",      readWrite("accounts.read",      "accounts.write"),      contactsRouter);
app.use("/opportunities", readWrite("opportunities.read", "opportunities.write"), opportunitiesRouter);

// ─── Staffing ────────────────────────────────────────────────────────────
// Applications carry a third gate. Moving one to hired / rejected / withdrawn
// is a decision about someone's livelihood, so it needs staffing.decide —
// a coordinator can shortlist and schedule without being able to end it.
const DECIDING_STAGES = new Set(["hired", "rejected", "withdrawn"]);
const staffingApplicationGuard: Handler = (req, res, next) => {
  if (req.method === "GET") return requirePermission("staffing.read")(req, res, next);
  const stage = (req.body as { stage?: unknown } | undefined)?.stage;
  if (typeof stage === "string" && DECIDING_STAGES.has(stage)) {
    return requirePermission("staffing.decide")(req, res, next);
  }
  return requirePermission("staffing.write")(req, res, next);
};

app.use("/requisitions", readWrite("staffing.read", "staffing.write"), requisitionsRouter);
app.use("/candidates",   readWrite("staffing.read", "staffing.write"), candidatesRouter);
app.use("/applications", staffingApplicationGuard,                     applicationsRouter);

app.use("/users",    requirePermission("users.manage"),  usersRouter);
// Manage Advisors — CRUD around app_user rows with role admin|advisor.
// Reuses users.manage since it's the same governance surface.
app.use("/advisors", requirePermission("users.manage"),  advisorsRouter);
app.use("/groups",   requirePermission("groups.manage"), groupsRouter);
// Phase G — every route gates per-handler so we can mix self/admin permissions.
app.use("/leaves",      leavesRouter);
app.use("/events",      eventsRouter);
// Lead tasks — the Leads calendar + the record page's Activity panel. Gated on
// the *lead* perms, not events.*: a task is a property of a lead, so anyone who
// can see a lead can see its tasks, and anyone who can edit one can schedule
// against it. DELETE lands on leads.write (not leads.delete) — dropping a
// scheduled call is an edit, not a destruction of the lead.
app.use("/tasks",       readWrite("leads.read", "leads.write"), tasksRouter);
// Saved messages (canned replies) for the inbox composer — text in Postgres.
app.use("/message-templates", readWrite("messaging.read", "messaging.send"), messageTemplatesRouter);
app.use("/batches",     batchesRouter);
app.use("/batches",     batchBoardRouter);
// Saved views — generic across surfaces (pipeline_list, enrollments_list, …).
// The mount only checks the caller can read SOME view surface; the router then
// enforces the correct read perm per scope.
app.use("/views",       requireAnyPermission("pipeline.read", "learners.read", "admin.batches.manage", "cases.read"), viewsRouter);
// Integrations admin — Slack rules + delivery log.
app.use("/integrations", readWrite("integrations.read", "integrations.manage"), integrationsRouter);
// User-facing Slack reads needed by the "Share to Slack" dialog. Kept OUT of
// /integrations so it doesn't require integrations.read.
app.use("/share-slack", shareSlackUserRouter);
// Manual "Share to Slack" — gated per-handler by the surface's read perm.
app.use("/share", shareRouter);

// Phase 4 Party Model — dedup + consent endpoints. Gated per-handler.
app.use("/parties", partiesRouter);
app.use("/party",   partyConsentRouter);

// Twilio SMS/WhatsApp — inbox reads + outbound send. Per-handler perms.
app.use("/twilio", twilioRouter);

// Exotel — click-to-call.
app.use("/exotel", exotelRouter);

// Gmail — outbound send. Inbound is pulled by the sync cron rather than
// pushed to a webhook, so there's no public /webhooks/gmail counterpart.
app.use("/gmail", gmailRouter);

// WhatsApp templates (Twilio Content Builder cache + approval status).
app.use("/templates", templatesRouter);

// Campaign engine — bulk template sends with per-recipient state.
app.use("/campaigns", campaignsRouter);

// Media library + file uploads for Twilio attachments. Per-handler perms.
app.use("/media", mediaRouter);

export { app };
