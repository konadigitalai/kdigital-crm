// LMS — learner-facing routes. Mounted at /lms behind lms.read.self.
//
// ─── THE ONE RULE ────────────────────────────────────────────────────────
// RLS on these tables is TENANT-scoped, not learner-scoped. It will happily
// return another student's submissions. The `.self` in the permission names
// is a naming convention; it enforces nothing.
//
// So every query below reaches the learner's data through exactly one path:
//
//     batch_assignment (party_id = caller, status = 'active')
//       └── cohort → module (status='published') → module_resource
//                                                → coursework → submission
//
// If you add a route here, join through batch_assignment. Never accept a
// cohort_id / module_id / resource_id from the client and trust it — always
// re-derive access from the caller's party_id. A missing join here is a data
// breach, not a bug.
//
// Unreachable rows return 404, never 403: a learner shouldn't be able to
// probe which module ids exist by reading the status code.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { partyIdFromAppUserId } from "../lib/party/resolve.js";

export const lmsRouter = Router();

/** The caller's party.id, or null if the token maps to no app_user. */
async function callerPartyId(db: Parameters<Parameters<typeof withTenant>[1]>[0], userId: string) {
  return partyIdFromAppUserId(db, userId);
}

// Reused everywhere: the set of cohort ids this learner may see. Kept as a
// subquery rather than a fetched array so the database does the filtering
// and a forgotten `.includes()` on our side can't leak anything.
const myCohorts = (partyId: string) => sql`
  SELECT ba.cohort_id
  FROM batch_assignment ba
  WHERE ba.party_id = ${partyId} AND ba.status = 'active'
`;

// ─── GET /lms/me ─────────────────────────────────────────────────────────
// Portal header: display name + LRN number + headline counts.

lmsRouter.get("/me", async (req, res, next) => {
  try {
    const out = await withTenant(req.tenantId!, async (db) => {
      const partyId = await callerPartyId(db, req.userId!);
      if (!partyId) return null;
      const r = await db.execute(sql`
        SELECT
          p.id AS "partyId",
          p.name,
          p.email,
          lp.number AS "learnerNumber",
          lp.status AS "learnerStatus",
          (SELECT count(*)::int FROM batch_assignment ba
             WHERE ba.party_id = p.id AND ba.status = 'active')    AS "activeBatches",
          (SELECT count(*)::int FROM batch_assignment ba
             WHERE ba.party_id = p.id AND ba.status = 'completed') AS "completedBatches"
        FROM party p
        LEFT JOIN learner_profile lp ON lp.party_id = p.id
        WHERE p.id = ${partyId}
      `);
      return r.rows[0] ?? null;
    });
    if (!out) return res.status(404).json({ error: "No learner record for this account" });
    res.json(out);
  } catch (err) { next(err); }
});

// ─── GET /lms/batches ────────────────────────────────────────────────────
// "My learning". One row per assigned batch with computed progress.
//
// Progress counts only REQUIRED resources in PUBLISHED modules, so adding a
// draft module or an optional reading can never move a learner backwards.

lmsRouter.get("/batches", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const partyId = await callerPartyId(db, req.userId!);
      if (!partyId) return [];
      const r = await db.execute(sql`
        WITH mine AS (${myCohorts(partyId)}),
        res AS (
          SELECT m.cohort_id, mr.id AS resource_id
          FROM module m
          JOIN module_resource mr ON mr.module_id = m.id AND mr.enabled AND mr.required
          WHERE m.cohort_id IN (SELECT cohort_id FROM mine)
            AND m.status = 'published' AND m.enabled
        )
        SELECT
          c.id, c.name, c.code, c.status, c.start_date AS "startDate",
          c.end_date AS "endDate", c.time_label AS "timeLabel", c.join_url AS "joinUrl",
          co.name AS "courseName",
          tp.name AS "trainerName",
          (SELECT count(*)::int FROM module m
             WHERE m.cohort_id = c.id AND m.status='published' AND m.enabled) AS "moduleCount",
          (SELECT count(*)::int FROM res WHERE res.cohort_id = c.id)          AS "resourceCount",
          (SELECT count(*)::int FROM res
             JOIN resource_progress rp
               ON rp.resource_id = res.resource_id AND rp.party_id = ${partyId}
             WHERE res.cohort_id = c.id AND rp.completed_at IS NOT NULL)      AS "resourcesDone"
        FROM cohort c
        JOIN mine ON mine.cohort_id = c.id
        LEFT JOIN course co ON co.id = c.course_id
        LEFT JOIN party  tp ON tp.id = c.trainer_id
        ORDER BY c.status, c.start_date DESC NULLS LAST, c.name
      `);
      return r.rows;
    });
    res.json({ batches: rows });
  } catch (err) { next(err); }
});

// ─── GET /lms/batches/:cohortId ──────────────────────────────────────────
// Batch detail: published modules, their resources, and my progress on each.

lmsRouter.get("/batches/:cohortId", async (req, res, next) => {
  try {
    const cohortId = String(req.params.cohortId);
    const out = await withTenant(req.tenantId!, async (db) => {
      const partyId = await callerPartyId(db, req.userId!);
      if (!partyId) return null;

      // Access check and batch header in one go — the join to
      // batch_assignment is what makes an unassigned cohort invisible.
      const head = await db.execute(sql`
        SELECT c.id, c.name, c.code, c.status, c.start_date AS "startDate",
               c.end_date AS "endDate", c.join_url AS "joinUrl",
               co.name AS "courseName", tp.name AS "trainerName"
        FROM cohort c
        JOIN batch_assignment ba
          ON ba.cohort_id = c.id AND ba.party_id = ${partyId} AND ba.status = 'active'
        LEFT JOIN course co ON co.id = c.course_id
        LEFT JOIN party  tp ON tp.id = c.trainer_id
        WHERE c.id = ${cohortId}
      `);
      if (!head.rows[0]) return null;

      const modules = await db.execute(sql`
        SELECT m.id, m.rank, m.title, m.summary
        FROM module m
        WHERE m.cohort_id = ${cohortId} AND m.status = 'published' AND m.enabled
        ORDER BY m.rank, m.title
      `);

      const resources = await db.execute(sql`
        SELECT
          mr.id, mr.module_id AS "moduleId", mr.rank, mr.title, mr.kind,
          mr.video_provider AS "videoProvider", mr.video_ref AS "videoRef",
          mr.duration_seconds AS "durationSeconds", mr.body,
          mr.external_url AS "externalUrl", mr.required,
          bs.recording_url AS "recordingUrl",
          COALESCE(rp.position_seconds, 0) AS "positionSeconds",
          rp.completed_at AS "completedAt"
        FROM module_resource mr
        JOIN module m ON m.id = mr.module_id
        LEFT JOIN batch_session bs ON bs.id = mr.batch_session_id
        LEFT JOIN resource_progress rp
          ON rp.resource_id = mr.id AND rp.party_id = ${partyId}
        WHERE m.cohort_id = ${cohortId} AND m.status = 'published' AND m.enabled
          AND mr.enabled
        ORDER BY m.rank, mr.rank, mr.title
      `);

      const coursework = await db.execute(sql`
        SELECT
          cw.id, cw.module_id AS "moduleId", cw.type, cw.title, cw.brief,
          cw.max_score AS "maxScore", cw.due_at AS "dueAt", cw.closes_at AS "closesAt",
          s.status AS "submissionStatus", s.score, s.submitted_at AS "submittedAt"
        FROM coursework cw
        JOIN module m ON m.id = cw.module_id
        LEFT JOIN LATERAL (
          SELECT status, score, submitted_at FROM submission
          WHERE coursework_id = cw.id AND party_id = ${partyId}
          ORDER BY attempt DESC LIMIT 1
        ) s ON true
        WHERE m.cohort_id = ${cohortId} AND m.status = 'published' AND m.enabled
          AND cw.enabled
        ORDER BY m.rank, cw.rank
      `);

      return {
        batch: head.rows[0],
        modules: modules.rows,
        resources: resources.rows,
        coursework: coursework.rows,
      };
    });
    if (!out) return res.status(404).json({ error: "Batch not found" });
    res.json(out);
  } catch (err) { next(err); }
});

// ─── PUT /lms/resources/:id/progress ─────────────────────────────────────
// Upsert playback position / completion. Called on a timer by the player, so
// it must stay cheap and idempotent.
//
// completed_at is sticky once set: re-watching a video must not un-complete
// it, and the client sending completed:false shouldn't wipe a real record.

lmsRouter.put("/resources/:id/progress", async (req, res, next) => {
  try {
    if (!req.permissions?.has("lms.progress.write.self")) {
      return res.status(403).json({ error: "Missing permission: lms.progress.write.self" });
    }
    const resourceId = String(req.params.id);
    const b = req.body ?? {};
    const position = Math.max(0, Math.floor(Number(b.positionSeconds ?? 0)) || 0);
    const completed = b.completed === true;

    const out = await withTenant(req.tenantId!, async (db) => {
      const partyId = await callerPartyId(db, req.userId!);
      if (!partyId) return null;

      // Re-derive access from the caller rather than trusting the id.
      const ok = await db.execute(sql`
        SELECT mr.id
        FROM module_resource mr
        JOIN module m ON m.id = mr.module_id
        JOIN batch_assignment ba
          ON ba.cohort_id = m.cohort_id AND ba.party_id = ${partyId} AND ba.status='active'
        WHERE mr.id = ${resourceId} AND m.status='published' AND m.enabled AND mr.enabled
      `);
      if (!ok.rows[0]) return null;

      const r = await db.execute(sql`
        INSERT INTO resource_progress
          (tenant_id, party_id, resource_id, position_seconds, completed_at, last_seen_at)
        VALUES (
          current_tenant(), ${partyId}, ${resourceId}, ${position},
          ${completed ? sql`now()` : sql`NULL`}, now()
        )
        ON CONFLICT (party_id, resource_id) DO UPDATE SET
          position_seconds = EXCLUDED.position_seconds,
          -- sticky: never clear a completion that already happened
          completed_at     = COALESCE(resource_progress.completed_at, EXCLUDED.completed_at),
          last_seen_at     = now()
        RETURNING position_seconds AS "positionSeconds", completed_at AS "completedAt"
      `);
      return r.rows[0];
    });
    if (!out) return res.status(404).json({ error: "Resource not found" });
    res.json(out);
  } catch (err) { next(err); }
});

// ─── GET /lms/schedule ───────────────────────────────────────────────────
// Live classes and deadlines across every batch I'm in, merged and sorted.
// ?days=N (default 14, max 90) bounds the window.

lmsRouter.get("/schedule", async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days ?? 14) || 14));
    const out = await withTenant(req.tenantId!, async (db) => {
      const partyId = await callerPartyId(db, req.userId!);
      if (!partyId) return { classes: [], deadlines: [] };

      const classes = await db.execute(sql`
        SELECT
          bs.id, bs.session_date AS "sessionDate", bs.start_time AS "startTime",
          bs.end_time AS "endTime", bs.status,
          COALESCE(bs.join_url, c.join_url) AS "joinUrl",
          bs.recording_url AS "recordingUrl",
          c.id AS "cohortId", c.name AS "batchName", c.code AS "batchCode",
          tp.name AS "trainerName"
        FROM batch_session bs
        JOIN cohort c ON c.id = bs.cohort_id
        JOIN batch_assignment ba
          ON ba.cohort_id = c.id AND ba.party_id = ${partyId} AND ba.status='active'
        LEFT JOIN party tp ON tp.id = c.trainer_id
        WHERE bs.session_date BETWEEN current_date AND current_date + ${days}::int
          AND bs.status <> 'cancelled'
        ORDER BY bs.session_date, bs.start_time NULLS LAST
      `);

      const deadlines = await db.execute(sql`
        SELECT
          cw.id, cw.type, cw.title, cw.due_at AS "dueAt", cw.closes_at AS "closesAt",
          c.id AS "cohortId", c.name AS "batchName", c.code AS "batchCode",
          m.title AS "moduleTitle",
          s.status AS "submissionStatus"
        FROM coursework cw
        JOIN module m ON m.id = cw.module_id AND m.status='published' AND m.enabled
        JOIN cohort c ON c.id = m.cohort_id
        JOIN batch_assignment ba
          ON ba.cohort_id = c.id AND ba.party_id = ${partyId} AND ba.status='active'
        LEFT JOIN LATERAL (
          SELECT status FROM submission
          WHERE coursework_id = cw.id AND party_id = ${partyId}
          ORDER BY attempt DESC LIMIT 1
        ) s ON true
        WHERE cw.enabled AND cw.due_at IS NOT NULL
          AND cw.due_at BETWEEN now() - interval '1 day'
                            AND now() + (${days}::int * interval '1 day')
        ORDER BY cw.due_at
      `);

      return { classes: classes.rows, deadlines: deadlines.rows };
    });
    res.json(out);
  } catch (err) { next(err); }
});

// ─── GET /lms/work ───────────────────────────────────────────────────────
// "My work" — every coursework item across my batches plus my latest
// submission, and the headline stats.

lmsRouter.get("/work", async (req, res, next) => {
  try {
    const out = await withTenant(req.tenantId!, async (db) => {
      const partyId = await callerPartyId(db, req.userId!);
      if (!partyId) return { items: [], stats: { dueThisWeek: 0, graded: 0, averagePct: null } };

      const items = await db.execute(sql`
        SELECT
          cw.id, cw.type, cw.title, cw.brief,
          cw.max_score AS "maxScore", cw.pass_score AS "passScore", cw.grading,
          cw.opens_at AS "opensAt", cw.due_at AS "dueAt", cw.closes_at AS "closesAt",
          m.id AS "moduleId", m.title AS "moduleTitle",
          c.id AS "cohortId", c.name AS "batchName", c.code AS "batchCode",
          s.id AS "submissionId", s.status AS "submissionStatus", s.attempt,
          s.score, s.feedback, s.submitted_at AS "submittedAt", s.graded_at AS "gradedAt"
        FROM coursework cw
        JOIN module m ON m.id = cw.module_id AND m.status='published' AND m.enabled
        JOIN cohort c ON c.id = m.cohort_id
        JOIN batch_assignment ba
          ON ba.cohort_id = c.id AND ba.party_id = ${partyId} AND ba.status='active'
        LEFT JOIN LATERAL (
          SELECT id, status, attempt, score, feedback, submitted_at, graded_at
          FROM submission
          WHERE coursework_id = cw.id AND party_id = ${partyId}
          ORDER BY attempt DESC LIMIT 1
        ) s ON true
        WHERE cw.enabled
        ORDER BY cw.due_at NULLS LAST, cw.rank
      `);

      const stats = await db.execute(sql`
        WITH mine AS (${myCohorts(partyId)}),
        cw AS (
          SELECT cw.id, cw.due_at, cw.max_score
          FROM coursework cw
          JOIN module m ON m.id = cw.module_id AND m.status='published' AND m.enabled
          WHERE m.cohort_id IN (SELECT cohort_id FROM mine) AND cw.enabled
        )
        SELECT
          (SELECT count(*)::int FROM cw
             WHERE cw.due_at BETWEEN now() AND now() + interval '7 days') AS "dueThisWeek",
          (SELECT count(*)::int FROM submission s
             WHERE s.party_id = ${partyId} AND s.status = 'graded')       AS "graded",
          -- Percentage of max, not raw score: items have different ceilings.
          (SELECT round(avg(s.score / NULLIF(cw.max_score,0)) * 100)::int
             FROM submission s JOIN cw ON cw.id = s.coursework_id
             WHERE s.party_id = ${partyId} AND s.status='graded' AND s.score IS NOT NULL)
                                                                          AS "averagePct"
      `);

      return { items: items.rows, stats: stats.rows[0] };
    });
    res.json(out);
  } catch (err) { next(err); }
});

// ─── POST /lms/coursework/:id/submit ─────────────────────────────────────
// Create or update the learner's submission. Re-submitting before the due
// date overwrites attempt 1; we don't spawn attempts automatically because
// nothing in the UI exposes them yet.
//
// Marked 'late' — not rejected — when past due_at, so a trainer can decide.
// Rejected outright only after closes_at.

lmsRouter.post("/coursework/:id/submit", async (req, res, next) => {
  try {
    if (!req.permissions?.has("lms.submit.self")) {
      return res.status(403).json({ error: "Missing permission: lms.submit.self" });
    }
    const courseworkId = String(req.params.id);
    const content = req.body?.content ?? {};
    if (typeof content !== "object" || Array.isArray(content)) {
      return res.status(400).json({ error: "content must be an object" });
    }

    const out = await withTenant(req.tenantId!, async (db) => {
      const partyId = await callerPartyId(db, req.userId!);
      if (!partyId) return { code: 404 as const };

      const cw = await db.execute(sql`
        SELECT cw.id, cw.due_at, cw.closes_at
        FROM coursework cw
        JOIN module m ON m.id = cw.module_id AND m.status='published' AND m.enabled
        JOIN batch_assignment ba
          ON ba.cohort_id = m.cohort_id AND ba.party_id = ${partyId} AND ba.status='active'
        WHERE cw.id = ${courseworkId} AND cw.enabled
      `);
      const row = cw.rows[0] as { closes_at: string | null; due_at: string | null } | undefined;
      if (!row) return { code: 404 as const };

      const now = Date.now();
      if (row.closes_at && new Date(row.closes_at).getTime() < now) {
        return { code: 409 as const, error: "This submission window has closed" };
      }
      const isLate = !!row.due_at && new Date(row.due_at).getTime() < now;

      const ins = await db.execute(sql`
        INSERT INTO submission
          (tenant_id, coursework_id, party_id, attempt, status, submitted_at, content)
        VALUES (current_tenant(), ${courseworkId}, ${partyId}, 1,
                ${isLate ? "late" : "submitted"}, now(), ${JSON.stringify(content)}::jsonb)
        ON CONFLICT (coursework_id, party_id, attempt) DO UPDATE SET
          status       = EXCLUDED.status,
          submitted_at = now(),
          content      = EXCLUDED.content,
          updated_at   = now()
        -- Don't let a re-submit silently overwrite a grade already given.
        WHERE submission.status <> 'graded'
        RETURNING id, status, submitted_at AS "submittedAt"
      `);
      if (!ins.rows[0]) return { code: 409 as const, error: "Already graded — ask your trainer to reopen it" };
      return { code: 200 as const, submission: ins.rows[0] };
    });

    if (out.code === 404) return res.status(404).json({ error: "Coursework not found" });
    if (out.code === 409) return res.status(409).json({ error: out.error });
    res.json(out.submission);
  } catch (err) { next(err); }
});

// ─── GET /lms/today ──────────────────────────────────────────────────────
// The dashboard. Deliberately a single round trip — the "Today" screen shows
// four panels and we don't want four requests on every page load.

lmsRouter.get("/today", async (req, res, next) => {
  try {
    const out = await withTenant(req.tenantId!, async (db) => {
      const partyId = await callerPartyId(db, req.userId!);
      if (!partyId) return null;

      const nextClasses = await db.execute(sql`
        SELECT bs.id, bs.session_date AS "sessionDate", bs.start_time AS "startTime",
               bs.end_time AS "endTime",
               COALESCE(bs.join_url, c.join_url) AS "joinUrl",
               c.id AS "cohortId", c.name AS "batchName", c.code AS "batchCode",
               tp.name AS "trainerName"
        FROM batch_session bs
        JOIN cohort c ON c.id = bs.cohort_id
        JOIN batch_assignment ba
          ON ba.cohort_id = c.id AND ba.party_id = ${partyId} AND ba.status='active'
        LEFT JOIN party tp ON tp.id = c.trainer_id
        WHERE bs.session_date >= current_date AND bs.status = 'planned'
        ORDER BY bs.session_date, bs.start_time NULLS LAST
        LIMIT 3
      `);

      const dueSoon = await db.execute(sql`
        SELECT cw.id, cw.type, cw.title, cw.due_at AS "dueAt",
               m.title AS "moduleTitle", c.name AS "batchName", c.code AS "batchCode"
        FROM coursework cw
        JOIN module m ON m.id = cw.module_id AND m.status='published' AND m.enabled
        JOIN cohort c ON c.id = m.cohort_id
        JOIN batch_assignment ba
          ON ba.cohort_id = c.id AND ba.party_id = ${partyId} AND ba.status='active'
        LEFT JOIN LATERAL (
          SELECT status FROM submission
          WHERE coursework_id = cw.id AND party_id = ${partyId}
          ORDER BY attempt DESC LIMIT 1
        ) s ON true
        WHERE cw.enabled AND cw.due_at IS NOT NULL
          AND cw.due_at BETWEEN now() AND now() + interval '7 days'
          AND (s.status IS NULL OR s.status = 'draft')
        ORDER BY cw.due_at
        LIMIT 5
      `);

      // "Pick up where you left off" — started but not finished, most recent.
      const resume = await db.execute(sql`
        SELECT mr.id, mr.title, mr.kind, mr.duration_seconds AS "durationSeconds",
               rp.position_seconds AS "positionSeconds",
               m.id AS "moduleId", m.title AS "moduleTitle",
               c.id AS "cohortId", c.name AS "batchName"
        FROM resource_progress rp
        JOIN module_resource mr ON mr.id = rp.resource_id AND mr.enabled
        JOIN module m ON m.id = mr.module_id AND m.status='published' AND m.enabled
        JOIN cohort c ON c.id = m.cohort_id
        JOIN batch_assignment ba
          ON ba.cohort_id = c.id AND ba.party_id = ${partyId} AND ba.status='active'
        WHERE rp.party_id = ${partyId}
          AND rp.completed_at IS NULL
          AND rp.position_seconds > 0
        ORDER BY rp.last_seen_at DESC
        LIMIT 3
      `);

      return {
        nextClasses: nextClasses.rows,
        dueSoon: dueSoon.rows,
        resume: resume.rows,
      };
    });
    if (!out) return res.status(404).json({ error: "No learner record for this account" });
    res.json(out);
  } catch (err) { next(err); }
});
