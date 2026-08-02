// Batches operational board — enriched cohort rows + KPI summary for the
// top-level /batches board (List / Kanban / Chart / Calendar). Mirrors the
// enriched-GET pattern in routes/enrollments.ts: one withTenant() query with
// correlated rollups + a primary-programme LATERAL, then a JS .map() for derived
// percentages/labels. Session/attendance rollups (coverage %, attendance %,
// recording-SLA) land in Phase 2; Phase 1 returns them as null/0.
//
// Mounted at /batches alongside routes/batches.ts (the personal calendar
// /sessions handler). Paths here are distinct (/board, /summary) so the two
// routers never collide. Every handler is gated by admin.batches.manage.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { requirePermission } from "../middleware/require.js";
import { partyIdFromAppUserId } from "../lib/party/resolve.js";

export const batchBoardRouter = Router();

const UNDER_ENROLLED_PCT = 0.6; // active learners below 60% of seats ⇒ under-enrolled
const SLA_HOURS = 24;           // recording must be published within N hours of session end (IST)
const UUID_RE = /^[0-9a-fA-F-]{36}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MATERIALIZE_HORIZON_DAYS = 120; // how far to project sessions when a batch has no end date

// IST weekday + inclusive date-range helpers (mirror routes/batches.ts). All
// dates are YYYY-MM-DD; anchoring at noon avoids any DST/edge-of-day drift.
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
function weekdayForDate(dateISO: string): string {
  return WEEKDAYS[new Date(`${dateISO}T12:00:00+05:30`).getUTCDay()]!;
}
function* dateRange(from: string, to: string): Generator<string> {
  let cur = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (cur <= end) {
    yield cur.toISOString().slice(0, 10);
    cur = new Date(cur.getTime() + 24 * 60 * 60_000);
  }
}
function addDaysISO(dateISO: string, days: number): string {
  return new Date(new Date(`${dateISO}T12:00:00Z`).getTime() + days * 24 * 60 * 60_000)
    .toISOString().slice(0, 10);
}
const maxISO = (a: string, b: string) => (a > b ? a : b);
const minISO = (a: string, b: string) => (a < b ? a : b);

// Primary programme for a batch: a batch teaches one course, but a course is
// reachable from many programmes via program_course. Pick the programme the
// batch's own active learners are actually enrolled in; else the lowest
// program_course.rank; else any. Returns one row (none for un-mapped courses).
//
// Was PRIMARY_STACK_LATERAL until post-0094 dropped the stack level. The
// coarse grouping the board offered now comes from the programme's registry
// family instead, which is the same idea sourced from the registry.
const PRIMARY_PROGRAM_LATERAL = sql`
  LEFT JOIN LATERAL (
    SELECT pg.family AS program_family, pg.name AS program_name
    FROM program_course pc
    JOIN program pg  ON pg.id  = pc.program_id
    WHERE pc.course_id = c.course_id
      AND pc.component_type = 'course' 
    ORDER BY
      (EXISTS (
        SELECT 1 FROM batch_assignment ba
        JOIN enrolment e ON e.id = ba.enrolment_id
        WHERE ba.cohort_id = c.id AND ba.status = 'active' AND e.program_id = pg.id
      )) DESC,
      pc.rank ASC, pg.name ASC
    LIMIT 1
  ) prg ON true
`;

interface BoardRaw {
  id: string;
  name: string;
  code: string | null;
  slot: string | null;
  timeLabel: string | null;
  schedule: string | null;
  startDate: string | null;
  endDate: string | null;
  seats: number | null;
  status: string;
  enabled: boolean;
  courseId: string | null;
  courseName: string | null;
  trainerId: string | null;
  trainerName: string | null;
  coTrainerId: string | null;
  coTrainerName: string | null;
  daysOfWeek: string[] | null;
  startTime: string | null;
  endTime: string | null;
  programFamily: string | null;
  programName: string | null;
  activeCount: number;
  enrolmentCount: number;
  expectedToDate: number;
  recordedToDate: number;
  deliveredToDate: number;
  attExpected: number;
  attPresent: number;
  slaBreachCount: number;
}

// GET /batches/board — one row per cohort (batch), enriched with course, stack,
// trainer names, learner counts, and rollup placeholders. Newest-relevant first.
batchBoardRouter.get("/board", requirePermission("admin.batches.manage"), async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          c.id,
          c.name,
          c.code,
          c.slot,
          c.time_label   AS "timeLabel",
          c.schedule,
          c.start_date   AS "startDate",
          c.end_date     AS "endDate",
          c.seats,
          c.status,
          c.enabled,
          c.course_id    AS "courseId",
          co.name        AS "courseName",
          c.trainer_id   AS "trainerId",
          tp.name        AS "trainerName",
          c.co_trainer_id AS "coTrainerId",
          cp.name        AS "coTrainerName",
          c.days_of_week AS "daysOfWeek",
          to_char(c.start_time, 'HH24:MI') AS "startTime",
          to_char(c.end_time,   'HH24:MI') AS "endTime",
          prg.program_family AS "programFamily",
          prg.program_name   AS "programName",
          (SELECT COUNT(*)::int FROM batch_assignment ba
             WHERE ba.cohort_id = c.id AND ba.status = 'active')  AS "activeCount",
          (SELECT COUNT(*)::int FROM batch_assignment ba
             WHERE ba.cohort_id = c.id)                           AS "enrolmentCount",
          -- ── session/attendance rollups (Phase 2) ──────────────────────────
          -- Coverage denominator: non-cancelled sessions due by today.
          (SELECT COUNT(*)::int FROM batch_session s
             WHERE s.cohort_id = c.id AND s.status <> 'cancelled'
               AND s.session_date <= CURRENT_DATE)                AS "expectedToDate",
          -- Coverage numerator: delivered AND recording published.
          (SELECT COUNT(*)::int FROM batch_session s
             WHERE s.cohort_id = c.id AND s.status = 'delivered'
               AND s.recording_published_at IS NOT NULL
               AND s.session_date <= CURRENT_DATE)                AS "recordedToDate",
          (SELECT COUNT(*)::int FROM batch_session s
             WHERE s.cohort_id = c.id AND s.status = 'delivered'
               AND s.session_date <= CURRENT_DATE)                AS "deliveredToDate",
          -- Attendance across delivered sessions.
          (SELECT COUNT(*)::int FROM attendance a
             JOIN batch_session s ON s.id = a.batch_session_id
             WHERE s.cohort_id = c.id AND s.status = 'delivered') AS "attExpected",
          (SELECT COUNT(*)::int FROM attendance a
             JOIN batch_session s ON s.id = a.batch_session_id
             WHERE s.cohort_id = c.id AND s.status = 'delivered'
               AND a.status IN ('present','late'))                AS "attPresent",
          -- Recording-SLA breaches: delivered past sessions with no recording,
          -- or one published later than session-end (IST) + SLA window.
          (SELECT COUNT(*)::int FROM batch_session s
             WHERE s.cohort_id = c.id AND s.status = 'delivered'
               AND s.session_date <= CURRENT_DATE
               AND (
                 s.recording_published_at IS NULL
                 OR s.recording_published_at >
                    ((s.session_date + COALESCE(s.end_time, '23:59'::time)) AT TIME ZONE 'Asia/Kolkata')
                    + (${SLA_HOURS} || ' hours')::interval
               ))                                                 AS "slaBreachCount"
        FROM cohort c
        LEFT JOIN course co ON co.id = c.course_id
        LEFT JOIN party  tp ON tp.id = c.trainer_id
        LEFT JOIN party  cp ON cp.id = c.co_trainer_id
        ${PRIMARY_PROGRAM_LATERAL}
        -- Live batches only. This is an operational board — archived batches
        -- would be noise on every rollup and row. They stay reachable and
        -- re-enableable via the admin cohorts screen (routes/cohorts.ts),
        -- which deliberately has no enabled filter.
        WHERE c.enabled = true
        ORDER BY
          CASE c.status WHEN 'running' THEN 0 WHEN 'upcoming' THEN 1
                        WHEN 'completed' THEN 2 ELSE 3 END,
          c.start_date NULLS LAST, co.name NULLS LAST, c.name
      `);
      return r.rows as unknown as BoardRaw[];
    });

    const batches = rows.map((row) => {
      const seats = row.seats;
      const underEnrolled =
        seats != null && seats > 0 && row.activeCount < Math.ceil(UNDER_ENROLLED_PCT * seats);
      // Percentages are null (not 0) when there's no denominator yet, so the UI
      // can render "—" rather than a misleading 0%.
      const coveragePct =
        row.expectedToDate > 0 ? Math.round((row.recordedToDate / row.expectedToDate) * 100) : null;
      const attendancePct =
        row.attExpected > 0 ? Math.round((row.attPresent / row.attExpected) * 100) : null;
      return {
        ...row,
        coveragePct,
        attendancePct,
        slaBreachCount: row.slaBreachCount,
        // Sessions due-by-today that haven't been delivered.
        behindSchedule: row.expectedToDate > row.deliveredToDate,
        staffed: row.trainerId != null,
        underEnrolled,
      };
    });

    res.json({ batches });
  } catch (err) {
    next(err);
  }
});

// GET /batches/summary — KPI aggregates for the board stat cards.
batchBoardRouter.get("/summary", requirePermission("admin.batches.manage"), async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          c.status,
          c.seats,
          (c.trainer_id IS NULL) AS "unstaffed",
          (SELECT COUNT(*)::int FROM batch_assignment ba
             WHERE ba.cohort_id = c.id AND ba.status = 'active') AS "activeCount",
          (SELECT COUNT(*)::int FROM batch_session s
             WHERE s.cohort_id = c.id AND s.status <> 'cancelled'
               AND s.session_date <= CURRENT_DATE)                AS "expectedToDate",
          (SELECT COUNT(*)::int FROM batch_session s
             WHERE s.cohort_id = c.id AND s.status = 'delivered'
               AND s.recording_published_at IS NOT NULL
               AND s.session_date <= CURRENT_DATE)                AS "recordedToDate",
          (SELECT COUNT(*)::int FROM attendance a
             JOIN batch_session s ON s.id = a.batch_session_id
             WHERE s.cohort_id = c.id AND s.status = 'delivered') AS "attExpected",
          (SELECT COUNT(*)::int FROM attendance a
             JOIN batch_session s ON s.id = a.batch_session_id
             WHERE s.cohort_id = c.id AND s.status = 'delivered'
               AND a.status IN ('present','late'))                AS "attPresent"
        FROM cohort c
        -- Counters stay on live batches. An archived one would inflate
        -- "unstaffed" and drag Avg coverage down permanently.
        WHERE c.enabled = true
      `);
      return r.rows as Array<{
        status: string; seats: number | null; unstaffed: boolean; activeCount: number;
        expectedToDate: number; recordedToDate: number; attExpected: number; attPresent: number;
      }>;
    });

    let totalBatches = 0;
    let running = 0;
    let upcoming = 0;
    let unstaffed = 0;
    let underEnrolled = 0;
    let totalActive = 0;
    let totalSeats = 0;
    // Coverage/attendance are averaged only over batches that actually have a
    // denominator, so a fleet of un-materialized batches doesn't drag it to 0.
    let coverageSum = 0, coverageN = 0;
    let attendanceSum = 0, attendanceN = 0;

    for (const row of rows) {
      totalBatches += 1;
      if (row.status === "running") running += 1;
      if (row.status === "upcoming") upcoming += 1;
      if (row.unstaffed) unstaffed += 1;
      totalActive += row.activeCount;
      if (row.seats != null) totalSeats += row.seats;
      if (row.seats != null && row.seats > 0 && row.activeCount < Math.ceil(UNDER_ENROLLED_PCT * row.seats)) {
        underEnrolled += 1;
      }
      if (row.expectedToDate > 0) {
        coverageSum += (row.recordedToDate / row.expectedToDate) * 100;
        coverageN += 1;
      }
      if (row.attExpected > 0) {
        attendanceSum += (row.attPresent / row.attExpected) * 100;
        attendanceN += 1;
      }
    }

    res.json({
      summary: {
        totalBatches,
        running,
        upcoming,
        unstaffed,
        underEnrolled,
        totalActive,
        totalSeats,
        fillPct: totalSeats > 0 ? Math.round((totalActive / totalSeats) * 100) : null,
        avgCoveragePct: coverageN > 0 ? Math.round(coverageSum / coverageN) : null,
        avgAttendancePct: attendanceN > 0 ? Math.round(attendanceSum / attendanceN) : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /batches/:id/detail — everything the batch record page needs: header,
// delivery rollups, risk, schedule, linked counts, and a derived next-best-action.
batchBoardRouter.get("/:id/detail", requirePermission("admin.batches.manage"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "invalid id" });

    const raw = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          c.id, c.code, c.name,
          co.name AS "courseName",
          prg.program_family AS "programFamily", prg.program_name AS "programName",
          c.status, c.slot, c.time_label AS "timeLabel", c.schedule,
          c.start_date AS "startDate", c.end_date AS "endDate", c.seats,
          c.trainer_id AS "trainerId", tp.name AS "trainerName",
          c.co_trainer_id AS "coTrainerId", cp.name AS "coTrainerName",
          to_char(c.start_time, 'HH24:MI') AS "startTime",
          to_char(c.end_time,   'HH24:MI') AS "endTime",
          (SELECT COUNT(*)::int FROM batch_assignment ba WHERE ba.cohort_id = c.id AND ba.status = 'active')                      AS "activeCount",
          (SELECT COUNT(*)::int FROM batch_assignment ba WHERE ba.cohort_id = c.id AND ba.status IN ('dropped','deferred'))       AS "movedOut",
          (SELECT COUNT(*)::int FROM batch_session s WHERE s.cohort_id = c.id AND s.status <> 'cancelled')                        AS "sessionsTotal",
          (SELECT COUNT(*)::int FROM batch_session s WHERE s.cohort_id = c.id AND s.status = 'delivered')                         AS "sessionsDelivered",
          (SELECT COUNT(*)::int FROM batch_session s WHERE s.cohort_id = c.id AND s.status = 'delivered' AND s.recording_published_at IS NULL) AS "sessionsNoRecording",
          (SELECT COUNT(*)::int FROM batch_session s WHERE s.cohort_id = c.id AND s.status <> 'cancelled' AND s.session_date <= CURRENT_DATE)  AS "expectedToDate",
          (SELECT COUNT(*)::int FROM batch_session s WHERE s.cohort_id = c.id AND s.status = 'delivered' AND s.recording_published_at IS NOT NULL AND s.session_date <= CURRENT_DATE) AS "recordedToDate",
          (SELECT COUNT(*)::int FROM batch_session s WHERE s.cohort_id = c.id AND s.status = 'delivered' AND s.session_date <= CURRENT_DATE)   AS "deliveredToDate",
          (SELECT COUNT(*)::int FROM attendance a JOIN batch_session s ON s.id = a.batch_session_id WHERE s.cohort_id = c.id AND s.status = 'delivered')                            AS "attExpected",
          (SELECT COUNT(*)::int FROM attendance a JOIN batch_session s ON s.id = a.batch_session_id WHERE s.cohort_id = c.id AND s.status = 'delivered' AND a.status IN ('present','late')) AS "attPresent",
          (SELECT COUNT(*)::int FROM batch_session s
             WHERE s.cohort_id = c.id AND s.status = 'delivered' AND s.session_date <= CURRENT_DATE
               AND ( s.recording_published_at IS NULL
                  OR s.recording_published_at > ((s.session_date + COALESCE(s.end_time,'23:59'::time)) AT TIME ZONE 'Asia/Kolkata') + (${SLA_HOURS} || ' hours')::interval)) AS "slaBreachCount",
          (SELECT COUNT(*)::int FROM (
             SELECT al.party_id,
               COUNT(a.*) FILTER (WHERE a.status IN ('present','late')) AS present,
               COUNT(a.*) AS marks
             FROM batch_assignment al
             LEFT JOIN attendance a ON a.party_id = al.party_id
               AND a.batch_session_id IN (SELECT id FROM batch_session WHERE cohort_id = c.id AND status = 'delivered')
             WHERE al.cohort_id = c.id AND al.status = 'active'
             GROUP BY al.party_id
           ) t WHERE t.marks > 0 AND t.present::float / t.marks < 0.6)                                                            AS "atRisk"
        FROM cohort c
        LEFT JOIN course co ON co.id = c.course_id
        LEFT JOIN party  tp ON tp.id = c.trainer_id
        LEFT JOIN party  cp ON cp.id = c.co_trainer_id
        ${PRIMARY_PROGRAM_LATERAL}
        WHERE c.id = ${id}
        LIMIT 1
      `);
      return r.rows[0] as Record<string, unknown> | undefined;
    });

    if (!raw) return res.status(404).json({ error: "batch not found" });

    const n = (v: unknown) => Number(v ?? 0);
    const expectedToDate = n(raw.expectedToDate);
    const deliveredToDate = n(raw.deliveredToDate);
    const sessionsDelivered = n(raw.sessionsDelivered);
    const attExpected = n(raw.attExpected);
    const behindSessions = Math.max(0, expectedToDate - deliveredToDate);
    const sessionsNoRecording = n(raw.sessionsNoRecording);
    const activeCount = n(raw.activeCount);
    const staffed = raw.trainerId != null;
    const startDate = raw.startDate ? String(raw.startDate).slice(0, 10) : null;

    const coveragePct = expectedToDate > 0 ? Math.round((n(raw.recordedToDate) / expectedToDate) * 100) : null;
    const attendancePct = attExpected > 0 ? Math.round((n(raw.attPresent) / attExpected) * 100) : null;
    const recordingSlaPct = sessionsDelivered > 0
      ? Math.round(((sessionsDelivered - n(raw.slaBreachCount)) / sessionsDelivered) * 100) : null;

    // Next-best-action — a plain-language summary + the single most useful move.
    const fmtDate = (iso: string) =>
      new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    const parts: string[] = [];
    if (!staffed) parts.push("No trainer assigned");
    parts.push(`${activeCount} learner${activeCount === 1 ? "" : "s"}`);
    if (raw.status === "running" && startDate) parts.push(`Ongoing since ${fmtDate(startDate)}`);
    if (sessionsNoRecording > 0) parts.push(`${sessionsNoRecording} session${sessionsNoRecording === 1 ? "" : "s"} have no recording`);
    if (behindSessions > 0) parts.push(`Coverage ${behindSessions} session${behindSessions === 1 ? "" : "s"} behind plan`);
    let action = "On track — keep it up.";
    if (!staffed) action = "Assign a trainer today.";
    else if (sessionsNoRecording > 0) action = `Publish ${sessionsNoRecording} missing recording${sessionsNoRecording === 1 ? "" : "s"}.`;
    else if (behindSessions > 0) action = `Catch up on ${behindSessions} session${behindSessions === 1 ? "" : "s"}.`;

    res.json({
      detail: {
        id: raw.id, code: raw.code, name: raw.name,
        courseName: raw.courseName, programFamily: raw.programFamily, programName: raw.programName,
        status: raw.status, staffed,
        trainerId: raw.trainerId, trainerName: raw.trainerName,
        coTrainerId: raw.coTrainerId, coTrainerName: raw.coTrainerName,
        slot: raw.slot, timeLabel: raw.timeLabel, schedule: raw.schedule,
        startDate, endDate: raw.endDate ? String(raw.endDate).slice(0, 10) : null,
        seats: raw.seats, activeCount, movedOut: n(raw.movedOut), atRisk: n(raw.atRisk),
        sessionsTotal: n(raw.sessionsTotal), sessionsDelivered, sessionsNoRecording,
        coveragePct, attendancePct, recordingSlaPct, behindSessions,
        timezone: "Asia/Kolkata",
        nba: { text: parts.join(" · "), action },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Sessions + attendance ────────────────────────────────────────────────

// POST /batches/:id/sessions/materialize — generate `planned` batch_session rows
// from the cohort's weekly schedule (days_of_week + times) over its date bounds.
// Idempotent via UNIQUE(cohort_id, session_date); returns how many were created.
batchBoardRouter.post("/:id/sessions/materialize", requirePermission("admin.batches.manage"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "invalid id" });
    const body = req.body ?? {};
    const fromArg = body.from ? String(body.from).trim() : null;
    const toArg   = body.to   ? String(body.to).trim()   : null;
    if (fromArg && !DATE_RE.test(fromArg)) return res.status(400).json({ error: "from must be YYYY-MM-DD" });
    if (toArg   && !DATE_RE.test(toArg))   return res.status(400).json({ error: "to must be YYYY-MM-DD" });

    const result = await withTenant(req.tenantId!, async (db) => {
      const c = await db.execute(sql`
        SELECT
          c.days_of_week AS "daysOfWeek",
          c.start_date   AS "startDate",
          c.end_date     AS "endDate",
          to_char(c.start_time, 'HH24:MI:SS') AS "startTime",
          to_char(c.end_time,   'HH24:MI:SS') AS "endTime"
        FROM cohort c WHERE c.id = ${id} LIMIT 1
      `);
      const row = c.rows[0] as {
        daysOfWeek: string[] | null; startDate: string | null; endDate: string | null;
        startTime: string | null; endTime: string | null;
      } | undefined;
      if (!row) return { notFound: true as const };

      const days = new Set((row.daysOfWeek ?? []).map((d) => d.toLowerCase()));
      if (days.size === 0) return { error: "batch has no weekly schedule (days_of_week)" as const };

      const startDate = row.startDate ? String(row.startDate).slice(0, 10) : null;
      const anchor = fromArg ?? startDate;
      if (!anchor) return { error: "batch has no start date — set one or pass `from`" as const };

      const endDate = row.endDate ? String(row.endDate).slice(0, 10) : null;
      const horizonEnd = endDate ?? toArg ?? addDaysISO(anchor, MATERIALIZE_HORIZON_DAYS);
      const lo = startDate ? maxISO(anchor, startDate) : anchor;
      const hi = toArg ? minISO(horizonEnd, toArg) : horizonEnd;
      if (lo > hi) return { created: 0 };

      const dates: string[] = [];
      for (const d of dateRange(lo, hi)) if (days.has(weekdayForDate(d))) dates.push(d);
      if (dates.length === 0) return { created: 0 };

      const valuesSql = dates.map(
        (d) => sql`(current_tenant(), ${id}, ${d}::date, ${row.startTime}::time, ${row.endTime}::time, 'planned')`,
      );
      const ins = await db.execute(sql`
        INSERT INTO batch_session (tenant_id, cohort_id, session_date, start_time, end_time, status)
        VALUES ${sql.join(valuesSql, sql`, `)}
        ON CONFLICT (cohort_id, session_date) DO NOTHING
        RETURNING id
      `);
      return { created: ins.rows.length };
    });

    if ("notFound" in result) return res.status(404).json({ error: "batch not found" });
    if ("error" in result)    return res.status(400).json({ error: result.error });
    res.json({ created: result.created });
  } catch (err) {
    next(err);
  }
});

// GET /batches/:id/sessions — persisted sessions for a batch (detail timeline),
// newest first, each with its attendance mark counts.
batchBoardRouter.get("/:id/sessions", requirePermission("admin.batches.manage"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "invalid id" });
    const sessions = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          s.id, s.cohort_id AS "cohortId", s.session_date AS "sessionDate",
          to_char(s.start_time, 'HH24:MI') AS "startTime",
          to_char(s.end_time,   'HH24:MI') AS "endTime",
          s.status, s.recording_url AS "recordingUrl",
          s.recording_published_at AS "recordingPublishedAt", s.notes,
          (SELECT COUNT(*)::int FROM attendance a WHERE a.batch_session_id = s.id)                                 AS "markedCount",
          (SELECT COUNT(*)::int FROM attendance a WHERE a.batch_session_id = s.id AND a.status IN ('present','late')) AS "presentCount"
        FROM batch_session s
        WHERE s.cohort_id = ${id}
        ORDER BY s.session_date DESC
      `);
      return r.rows;
    });
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

// PATCH /batches/sessions/:sessionId — update status / recording / notes.
batchBoardRouter.patch("/sessions/:sessionId", requirePermission("admin.batches.manage"), async (req, res, next) => {
  try {
    const sid = String(req.params.sessionId);
    if (!UUID_RE.test(sid)) return res.status(400).json({ error: "invalid session id" });
    const b = req.body ?? {};
    const sets: ReturnType<typeof sql>[] = [];
    if (b.status !== undefined) {
      if (!["planned", "delivered", "cancelled"].includes(String(b.status))) {
        return res.status(400).json({ error: "status invalid" });
      }
      sets.push(sql`status = ${String(b.status)}`);
    }
    if (b.recordingUrl !== undefined) {
      sets.push(sql`recording_url = ${b.recordingUrl ? String(b.recordingUrl).trim() : null}`);
    }
    if (b.recordingPublishedAt !== undefined) {
      // Accept an ISO timestamp, or true → now(), or null/false → clear.
      if (b.recordingPublishedAt === true) sets.push(sql`recording_published_at = now()`);
      else if (!b.recordingPublishedAt)    sets.push(sql`recording_published_at = NULL`);
      else                                 sets.push(sql`recording_published_at = ${String(b.recordingPublishedAt)}::timestamptz`);
    }
    if (b.notes !== undefined) sets.push(sql`notes = ${b.notes ? String(b.notes) : null}`);
    if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });
    sets.push(sql`updated_at = now()`);

    const updated = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        UPDATE batch_session SET ${sql.join(sets, sql`, `)}
        WHERE id = ${sid}
        RETURNING id, status, recording_url AS "recordingUrl",
                  recording_published_at AS "recordingPublishedAt", notes
      `);
      return r.rows[0] ?? null;
    });
    if (!updated) return res.status(404).json({ error: "session not found" });
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
});

// GET /batches/sessions/:sessionId/attendance — the active-learner roster for a
// session, LEFT JOINed to any existing marks (unmarked learners appear too).
batchBoardRouter.get("/sessions/:sessionId/attendance", requirePermission("admin.batches.manage"), async (req, res, next) => {
  try {
    const sid = String(req.params.sessionId);
    if (!UUID_RE.test(sid)) return res.status(400).json({ error: "invalid session id" });
    const result = await withTenant(req.tenantId!, async (db) => {
      const meta = await db.execute(sql`SELECT cohort_id AS "cohortId" FROM batch_session WHERE id = ${sid} LIMIT 1`);
      const cohortId = (meta.rows[0] as { cohortId: string } | undefined)?.cohortId;
      if (!cohortId) return null;
      const r = await db.execute(sql`
        SELECT
          p.id AS "partyId", p.name, p.email,
          a.status AS "status", a.marked_at AS "markedAt"
        FROM batch_assignment ba
        JOIN party p ON p.id = ba.party_id
        LEFT JOIN attendance a ON a.batch_session_id = ${sid} AND a.party_id = p.id
        WHERE ba.cohort_id = ${cohortId} AND ba.status = 'active'
        ORDER BY p.name
      `);
      return r.rows;
    });
    if (result === null) return res.status(404).json({ error: "session not found" });
    res.json({ roster: result });
  } catch (err) {
    next(err);
  }
});

// PUT /batches/sessions/:sessionId/attendance — bulk upsert marks.
// Body: { marks: [{ partyId, status }] }. Upsert keyed on (session, party).
batchBoardRouter.put("/sessions/:sessionId/attendance", requirePermission("admin.batches.manage"), async (req, res, next) => {
  try {
    const sid = String(req.params.sessionId);
    if (!UUID_RE.test(sid)) return res.status(400).json({ error: "invalid session id" });
    const marks = Array.isArray(req.body?.marks) ? req.body.marks : null;
    if (!marks) return res.status(400).json({ error: "marks must be an array" });
    const clean: Array<{ partyId: string; status: string }> = [];
    for (const m of marks) {
      const partyId = String(m?.partyId ?? "");
      const status = String(m?.status ?? "");
      if (!UUID_RE.test(partyId)) return res.status(400).json({ error: "mark.partyId invalid" });
      if (!["present", "absent", "late", "excused"].includes(status)) {
        return res.status(400).json({ error: `mark.status '${status}' invalid` });
      }
      clean.push({ partyId, status });
    }

    const saved = await withTenant(req.tenantId!, async (db) => {
      const exists = await db.execute(sql`SELECT 1 FROM batch_session WHERE id = ${sid} LIMIT 1`);
      if (exists.rows.length === 0) return { notFound: true as const };
      const markedBy = await partyIdFromAppUserId(db, req.userId!);
      if (clean.length === 0) return { count: 0 };
      const valuesSql = clean.map(
        (m) => sql`(current_tenant(), ${sid}, ${m.partyId}, ${m.status}, ${markedBy})`,
      );
      await db.execute(sql`
        INSERT INTO attendance (tenant_id, batch_session_id, party_id, status, marked_by)
        VALUES ${sql.join(valuesSql, sql`, `)}
        ON CONFLICT (batch_session_id, party_id)
        DO UPDATE SET status = EXCLUDED.status, marked_by = EXCLUDED.marked_by, marked_at = now()
      `);
      return { count: clean.length };
    });
    if ("notFound" in saved) return res.status(404).json({ error: "session not found" });
    res.json({ saved: saved.count });
  } catch (err) {
    next(err);
  }
});

// GET /batches/board-sessions?from&to — persisted sessions across all batches for
// the board calendar. Distinct from the personal on-the-fly /batches/sessions.
batchBoardRouter.get("/board-sessions", requirePermission("admin.batches.manage"), async (req, res, next) => {
  try {
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) return res.status(400).json({ error: "from/to must be YYYY-MM-DD" });
    if (to < from) return res.status(400).json({ error: "to must be >= from" });

    const sessions = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          s.id, s.cohort_id AS "cohortId",
          c.name AS "title", co.name AS "courseName",
          s.session_date AS "sessionDate",
          to_char(s.start_time, 'HH24:MI') AS "startTime",
          to_char(s.end_time,   'HH24:MI') AS "endTime",
          s.status, s.recording_url AS "recordingUrl",
          s.recording_published_at AS "recordingPublishedAt",
          tp.name AS "trainerName", cp.name AS "coTrainerName"
        FROM batch_session s
        JOIN cohort c   ON c.id  = s.cohort_id
        LEFT JOIN course co ON co.id = c.course_id
        LEFT JOIN party  tp ON tp.id = c.trainer_id
        LEFT JOIN party  cp ON cp.id = c.co_trainer_id
        WHERE s.session_date BETWEEN ${from}::date AND ${to}::date
        ORDER BY s.session_date, s.start_time NULLS LAST
      `);
      return r.rows;
    });
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});
