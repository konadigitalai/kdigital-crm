import "dotenv/config";
import express from "express";
import { appPool } from "./db/app.js";
import { tenantMiddleware } from "./middleware/tenant.js";
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

const app = express();
app.use(express.json());

const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:3000";
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", corsOrigin);
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

app.get("/health", async (_req, res) => {
  try {
    const r = await appPool.query<{ now: Date }>("SELECT now() AS now");
    res.json({ ok: true, db: { now: r.rows[0]?.now } });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// All other routes carry tenant context.
app.use(tenantMiddleware);
app.use("/leads", leadsRouter);
app.use("/leads", convertRouter);  // POST /leads/:idOrNumber/convert
app.use("/learners", learnersRouter);
app.use("/approvals", approvalsRouter);
app.use("/pipeline", pipelineRouter);
app.use("/activity", activityRouter);
app.use("/agents", agentsRouter);
app.use("/records", recordsRouter);
app.use("/me", meRouter);
app.use("/summary", summaryRouter);
app.use("/catalog", catalogRouter);
app.use("/programs", programsRouter);
app.use("/cohorts",  cohortsRouter);
app.use("/courses",  coursesRouter);

// JSON error envelope
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[api]", err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`api listening on http://localhost:${port}`));
