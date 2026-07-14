import dotenv from "dotenv";
// override:true — the API's .env wins over inherited shell vars (e.g. when the
// dev shell has its own ANTHROPIC_MODEL set for unrelated tooling).
dotenv.config({ override: true });
import express from "express";
import { appPool } from "./db/app.js";
import { authMiddleware } from "./middleware/auth.js";
import { requirePermission } from "./middleware/require.js";
import { leadsRouter } from "./routes/leads.js";
import { intakeRouter } from "./routes/intake.js";
import { pipelineRouter } from "./routes/pipeline.js";
import { activityRouter } from "./routes/activity.js";
import { agentsRouter } from "./routes/agents.js";
import { recordsRouter } from "./routes/records.js";
import { meRouter } from "./routes/me.js";
import { summaryRouter } from "./routes/summary.js";
import { catalogRouter } from "./routes/catalog.js";
import { programsRouter } from "./routes/programs.js";
import { stacksRouter } from "./routes/stacks.js";
import { cohortsRouter } from "./routes/cohorts.js";
import { coursesRouter } from "./routes/courses.js";
import { convertRouter } from "./routes/convert.js";
import { learnersRouter } from "./routes/learners.js";
import { approvalsRouter } from "./routes/approvals.js";
import { casesRouter } from "./routes/cases.js";
import { usersRouter } from "./routes/users.js";
import { advisorsRouter } from "./routes/advisors.js";
import { groupsRouter } from "./routes/groups.js";
import { leavesRouter } from "./routes/leaves.js";
import { eventsRouter } from "./routes/events.js";
import { tasksRouter } from "./routes/tasks.js";
import { batchesRouter } from "./routes/batches.js";
import { viewsRouter } from "./routes/views.js";
import { integrationsRouter } from "./routes/integrations.js";
import { shareRouter } from "./routes/share.js";
import { shareSlackUserRouter } from "./routes/share-slack-user.js";
import { slackOAuthRouter, slackOAuthCallbackRouter } from "./routes/slack-oauth.js";
import { googleOAuthRouter, googleOAuthCallbackRouter } from "./routes/google-oauth.js";
import { gmailRouter } from "./routes/gmail.js";
import { startGmailWorker } from "./lib/gmail/worker.js";
import { partiesRouter } from "./routes/parties.js";
import { partyConsentRouter } from "./routes/party-consent.js";
import { twilioRouter } from "./routes/twilio.js";
import { twilioWebhookRouter } from "./routes/twilio-webhook.js";
import { exotelRouter } from "./routes/exotel.js";
import { exotelWebhookRouter } from "./routes/exotel-webhook.js";
import { templatesRouter } from "./routes/templates.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { startCampaignWorker } from "./lib/campaigns/worker.js";
import { mediaRouter, mediaFetchRouter } from "./routes/media.js";
import { startDedupWorker } from "./lib/party/dedup-worker.js";
import { ensureCheckpointerSetup } from "./agents/runtime.js";

const app = express();

// Twilio's inbound webhook posts application/x-www-form-urlencoded, and its
// X-Twilio-Signature is HMAC-SHA1 over the URL + sorted form params. We mount
// its parser BEFORE the global express.json so the request body ends up in
// req.body as a parsed object AND the raw buffer is available on req.rawBody
// for signature verification (belt-and-braces — we canonicalize from req.body
// in the verify path).
app.use(
  "/webhooks/twilio",
  express.urlencoded({
    extended: false,
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }),
  twilioWebhookRouter,
);

// Exotel webhooks — StatusCallback POSTs JSON (we set that on outbound),
// Passthru inbound POSTs form-urlencoded. Both parsers are mounted here
// BEFORE the global express.json so the body is object-parsed regardless
// of Content-Type. Same body-parser-first-body-then-router pattern as
// Twilio above. No HMAC — Exotel doesn't sign webhooks; the route enforces
// IP allowlist + 200-on-error to prevent retries.
app.use(
  "/webhooks/exotel",
  express.urlencoded({ extended: false }),
  express.json(),
  exotelWebhookRouter,
);

// 6 MB gives us headroom for base64-encoded receipt images (3 MB source →
// ~4 MB after encoding) posted to /learners/:partyId/fee. The per-endpoint
// cap for the fee-ledger route is enforced in learners.ts (~5 MB); this is
// just the outer body-parser guard.
app.use(express.json({ limit: "6mb" }));

// CORS_ORIGIN can be a single origin or a comma-separated allowlist (e.g.
// the prod Vercel domain plus any custom domain). Credentialed requests
// require an exact echoed origin — wildcards are rejected by the browser.
//
// When the incoming origin ISN'T on the allowlist we don't set the header at
// all. The browser then produces a clean "no Access-Control-Allow-Origin
// header present" error, which is easier to diagnose than the previous
// behaviour of echoing back a different (wrong) origin.
const corsAllowed = (process.env.CORS_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use((req, res, next) => {
  const reqOrigin = req.headers.origin;
  if (reqOrigin && corsAllowed.includes(reqOrigin)) {
    res.header("Access-Control-Allow-Origin", reqOrigin);
    res.header("Access-Control-Allow-Credentials", "true");
  }
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Intake-Key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

// ── Public ─────────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    const r = await appPool.query<{ now: Date }>("SELECT now() AS now");
    res.json({ ok: true, db: { now: r.rows[0]?.now } });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// Public lead-intake endpoint (marketing website form, ad landing pages, …).
// Gated by INTAKE_API_KEY env var + a per-IP rate limit inside the router —
// it deliberately sits BEFORE authMiddleware so no Auth0 token is needed.
app.use("/leads/intake", intakeRouter);

// Slack OAuth callback — Slack redirects the user's browser here after
// they approve the "Connect Slack" screen. The browser has NO auth
// cookies for the API on this hop; security comes from the signed
// state param the API included when it sent them to Slack.
app.use("/auth/slack", slackOAuthCallbackRouter);

// Google OAuth callback — same deal as Slack above. Google redirects the
// user's browser here after they approve the "Connect Gmail" consent screen,
// so there's no Bearer token on the hop; trust comes from the signed state.
app.use("/auth/google", googleOAuthCallbackRouter);

// Public signed-URL fetch for outbound Twilio media. Twilio has no JWT;
// authentication is a short-lived HMAC in the querystring. Mounted BEFORE
// authMiddleware for that reason.
app.use("/media/fetch", mediaFetchRouter);

// ── Authenticated ──────────────────────────────────────────────────────────
// Auth is owned by Auth0 (see middleware/auth.ts — verifies the Bearer JWT
// against Auth0's JWKS). The legacy /auth/login + /auth/logout endpoints
// were removed; the web app calls the SDK-mounted Next.js routes
// (/auth/login, /auth/logout) instead.
app.use(authMiddleware);
app.use("/me", meRouter);

// Slack OAuth authorize-url + disconnect — need req.userId, so behind auth.
app.use("/auth/slack", slackOAuthRouter);

// Gmail connect/status/disconnect — need req.userId, so behind auth.
app.use("/auth/google", googleOAuthRouter);

// Method-aware guard: reads need readPerm, mutating verbs need writePerm.
// We treat GET as the read fence so routes with PATCH/POST/DELETE always
// fall through the write check (POST /:id/notes, POST /:id/comms, etc.).
type Perm = Parameters<typeof requirePermission>[0];
const readWrite = (readPerm: Perm, writePerm: Perm) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const perm = req.method === "GET" ? readPerm : writePerm;
    return requirePermission(perm)(req, res, next);
  };
const writeOnly = (perm: Perm) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method === "GET") return next();
    return requirePermission(perm)(req, res, next);
  };
// Like readWrite, but with a separate gate for DELETE — used by /leads where
// deletion is a strictly higher privilege than write.
const readWriteDelete = (readPerm: Perm, writePerm: Perm, deletePerm: Perm) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const perm =
      req.method === "GET"    ? readPerm
    : req.method === "DELETE" ? deletePerm
    :                           writePerm;
    return requirePermission(perm)(req, res, next);
  };

app.use("/leads",    readWriteDelete("leads.read", "leads.write", "leads.delete"), leadsRouter);
app.use("/leads",    requirePermission("leads.write"),             convertRouter); // POST /leads/:idOrNumber/convert
app.use("/learners", readWrite("learners.read", "learners.write"), learnersRouter);
app.use("/approvals", approvalsRouter);
app.use("/cases",    readWrite("cases.read",    "cases.write"),    casesRouter);
app.use("/pipeline", readWrite("pipeline.read", "pipeline.write"), pipelineRouter);
// /activity is the home-page agent feed (tag IN auto/sent/need), not the
// per-record timeline (which lives behind /records/:id). Agents.read fits
// because what the feed surfaces is "what the agents have been doing."
app.use("/activity", requirePermission("agents.read"),             activityRouter);
app.use("/agents",   agentsRouter);
app.use("/records",  requirePermission("leads.read"),              recordsRouter);
app.use("/summary",  summaryRouter);
app.use("/catalog",  catalogRouter);
// programs/courses/cohorts/stacks: GET is readable by any authenticated user
// (admin dialogs need them); writes require the manage permission. Stacks
// reuse admin.programs.manage — there's no separate stack RBAC yet.
app.use("/programs", writeOnly("admin.programs.manage"), programsRouter);
app.use("/stacks",   writeOnly("admin.programs.manage"), stacksRouter);
app.use("/cohorts",  writeOnly("admin.batches.manage"),  cohortsRouter);
app.use("/courses",  writeOnly("admin.courses.manage"),  coursesRouter);
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
app.use("/batches",     batchesRouter);
// Saved views — gated per-handler against the surface's read perm
// (pipeline_list ⇒ pipeline.read for GET, etc.). The router itself does
// the visibility checks (personal vs shared, owner vs others).
app.use("/views",       requirePermission("pipeline.read"), viewsRouter);
// Integrations admin — Slack rules + delivery log.
app.use("/integrations", readWrite("integrations.read", "integrations.manage"), integrationsRouter);
// User-facing Slack reads needed by the "Share to Slack" dialog — workspace
// status, per-user connection status, and channel/user picker directory.
// Kept OUT of /integrations so it doesn't require integrations.read; any
// authenticated user who can see a lead can hit these read-only endpoints.
app.use("/share-slack", shareSlackUserRouter);
// Manual "Share to Slack" — gated per-handler by the surface's read perm.
app.use("/share", shareRouter);

// Phase 4 Party Model — dedup + consent endpoints. Gated per-handler
// (admin-only for merge/scan). Consent PUT is any-authenticated for now;
// tighten via a dedicated permission later if needed.
app.use("/parties", partiesRouter);
app.use("/party",   partyConsentRouter);

// Twilio SMS/WhatsApp — inbox reads + outbound send. Per-handler perms
// (messaging.read / messaging.send / leads.write for promote-to-lead).
app.use("/twilio", twilioRouter);

// Exotel — click-to-call. Only one endpoint (POST /exotel/call) so we mount
// the whole router here. Voice threads then appear as channel='voice' rows
// in the same tw_conversation table Twilio uses; nothing else to wire.
app.use("/exotel", exotelRouter);

// Gmail — outbound send. Inbound is pulled by the sync worker below rather
// than pushed to a webhook, so there's no public /webhooks/gmail counterpart.
// Email threads are channel='email' rows in the same tw_conversation table.
app.use("/gmail", gmailRouter);

// WhatsApp templates (Twilio Content Builder cache + approval status).
app.use("/templates", templatesRouter);

// Campaign engine — bulk template sends with per-recipient state.
app.use("/campaigns", campaignsRouter);

// Media library + file uploads for Twilio attachments. Per-handler perms
// (media.read / media.upload / media.manage). Uploads flow client→Vercel
// Blob directly; the API only mints short-lived tokens.
app.use("/media", mediaRouter);

// JSON error envelope
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[api]", err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, async () => {
  console.log(`api listening on http://localhost:${port}`);
  startDedupWorker();
  startCampaignWorker();
  // No-ops if the Gmail env vars aren't set.
  startGmailWorker();
  // Idempotent: creates the LangGraph checkpoint tables on first boot.
  try {
    await ensureCheckpointerSetup();
  } catch (err) {
    console.error("[api] LangGraph checkpointer setup failed:", err);
  }
});
