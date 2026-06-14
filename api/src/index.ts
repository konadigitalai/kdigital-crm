import dotenv from "dotenv";
// override:true — the API's .env wins over inherited shell vars (e.g. when the
// dev shell has its own ANTHROPIC_MODEL set for unrelated tooling).
dotenv.config({ override: true });
import express from "express";
import cookieParser from "cookie-parser";
import { appPool } from "./db/app.js";
import { authMiddleware } from "./middleware/auth.js";
import { requirePermission } from "./middleware/require.js";
import { authRouter } from "./routes/auth.js";
import { leadsRouter } from "./routes/leads.js";
import { pipelineRouter } from "./routes/pipeline.js";
import { activityRouter } from "./routes/activity.js";
import { agentsRouter } from "./routes/agents.js";
import { recordsRouter } from "./routes/records.js";
import { meRouter } from "./routes/me.js";
import { summaryRouter } from "./routes/summary.js";
import { catalogRouter } from "./routes/catalog.js";
import { programsRouter } from "./routes/programs.js";
import { cohortsRouter } from "./routes/cohorts.js";
import { coursesRouter } from "./routes/courses.js";
import { convertRouter } from "./routes/convert.js";
import { learnersRouter } from "./routes/learners.js";
import { approvalsRouter } from "./routes/approvals.js";
import { casesRouter } from "./routes/cases.js";
import { usersRouter } from "./routes/users.js";
import { groupsRouter } from "./routes/groups.js";
import { clientsRouter } from "./routes/clients.js";
import { timesheetsRouter } from "./routes/timesheets.js";
import { leavesRouter } from "./routes/leaves.js";
import { eventsRouter } from "./routes/events.js";
import { batchesRouter } from "./routes/batches.js";
import { viewsRouter } from "./routes/views.js";
import { integrationsRouter } from "./routes/integrations.js";
import { shareRouter } from "./routes/share.js";

const app = express();
app.use(express.json());
app.use(cookieParser());

// CORS_ORIGIN can be a single origin or a comma-separated allowlist (e.g.
// the prod Vercel domain plus any custom domain). Credentialed requests
// require an exact echoed origin — wildcards are rejected by the browser.
const corsAllowed = (process.env.CORS_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use((req, res, next) => {
  const reqOrigin = req.headers.origin;
  const allowed = reqOrigin && corsAllowed.includes(reqOrigin) ? reqOrigin : corsAllowed[0]!;
  res.header("Access-Control-Allow-Origin", allowed);
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

app.use("/auth", authRouter);

// ── Authenticated ──────────────────────────────────────────────────────────
app.use(authMiddleware);
app.use("/me", meRouter);

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
// programs/courses/cohorts: GET is readable by any authenticated user (advisor
// dialogs need them); writes require the manage permission.
app.use("/programs", writeOnly("admin.programs.manage"), programsRouter);
app.use("/cohorts",  writeOnly("admin.batches.manage"),  cohortsRouter);
app.use("/courses",  writeOnly("admin.courses.manage"),  coursesRouter);
app.use("/users",    requirePermission("users.manage"),  usersRouter);
app.use("/groups",   requirePermission("groups.manage"), groupsRouter);
// Phase G — every route gates per-handler so we can mix self/admin permissions.
app.use("/clients",     clientsRouter);
app.use("/timesheets",  timesheetsRouter);
app.use("/leaves",      leavesRouter);
app.use("/events",      eventsRouter);
app.use("/batches",     batchesRouter);
// Saved views — gated per-handler against the surface's read perm
// (pipeline_list ⇒ pipeline.read for GET, etc.). The router itself does
// the visibility checks (personal vs shared, owner vs others).
app.use("/views",       requirePermission("pipeline.read"), viewsRouter);
// Integrations admin — Slack rules + delivery log.
app.use("/integrations", readWrite("integrations.read", "integrations.manage"), integrationsRouter);
// Manual "Share to Slack" — gated per-handler by the surface's read perm.
app.use("/share", shareRouter);

// JSON error envelope
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[api]", err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`api listening on http://localhost:${port}`));
