// Batch sessions — expand active cohorts (the user is trainer or co-trainer of)
// into per-day occurrences for the calendar. All times stored/produced in IST.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { requirePermission } from "../middleware/require.js";

export const batchesRouter = Router();

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
type WeekDay = typeof WEEKDAYS[number];

interface CohortRow {
  id: string;
  name: string;
  programName: string | null;
  courseName: string | null;
  startDate: Date | null;
  endDate: Date | null;
  trainerId: string | null;
  trainerName: string | null;
  coTrainerId: string | null;
  coTrainerName: string | null;
  daysOfWeek: string[] | null;
  startTime: string | null;
  endTime: string | null;
}

// Convert "YYYY-MM-DD" + "HH:MM[:SS]" (interpreted as IST) to a UTC ISO string.
// IST = UTC + 05:30.
function istLocalToISO(date: string, time: string): string {
  const [hh, mm, ss = "00"] = time.split(":");
  const local = new Date(`${date}T${hh}:${mm}:${ss}+05:30`);
  return local.toISOString();
}

// Returns the IST weekday code ('mon'..'sun') for a YYYY-MM-DD string.
// We anchor at noon IST so DST/edge-of-day issues never matter.
function weekdayForDate(dateISO: string): WeekDay {
  const dt = new Date(`${dateISO}T12:00:00+05:30`);
  return WEEKDAYS[dt.getUTCDay()]!;
}

function* dateRange(from: string, to: string): Generator<string> {
  // Walk inclusive [from, to] using UTC arithmetic on noon-anchored Dates.
  let cur = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (cur <= end) {
    yield cur.toISOString().slice(0, 10);
    cur = new Date(cur.getTime() + 24 * 60 * 60_000);
  }
}

batchesRouter.get("/sessions", requirePermission("events.manage.self"), async (req, res, next) => {
  try {
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: "from/to must be YYYY-MM-DD" });
    }
    if (to < from) return res.status(400).json({ error: "to must be >= from" });

    const me = req.userId!;

    const cohorts = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          c.id,
          c.name,
          p.name AS "programName",
          co.name AS "courseName",
          c.start_date AS "startDate",
          c.end_date   AS "endDate",
          c.trainer_id AS "trainerId",
          tu.name      AS "trainerName",
          c.co_trainer_id AS "coTrainerId",
          cu.name         AS "coTrainerName",
          c.days_of_week AS "daysOfWeek",
          to_char(c.start_time, 'HH24:MI:SS') AS "startTime",
          to_char(c.end_time,   'HH24:MI:SS') AS "endTime"
        FROM cohort c
        LEFT JOIN course   co ON co.id = c.course_id
        LEFT JOIN program  p  ON p.id  = co.program_id
        LEFT JOIN app_user tu ON tu.id = c.trainer_id
        LEFT JOIN app_user cu ON cu.id = c.co_trainer_id
        WHERE (c.trainer_id = ${me} OR c.co_trainer_id = ${me})
          AND c.enabled = true
          AND c.status IN ('upcoming','running')
          AND c.days_of_week IS NOT NULL
          AND array_length(c.days_of_week, 1) > 0
          AND c.start_time IS NOT NULL
          AND c.end_time   IS NOT NULL
          AND (c.start_date IS NULL OR c.start_date <= ${to}::date)
          AND (c.end_date   IS NULL OR c.end_date   >= ${from}::date)
      `);
      return r.rows as unknown as CohortRow[];
    });

    const sessions: Array<Record<string, unknown>> = [];
    for (const c of cohorts) {
      const days = new Set((c.daysOfWeek ?? []).map((d) => d.toLowerCase()));
      // Clamp the iteration window to the batch's own date bounds.
      const cohortStart = c.startDate
        ? new Date(c.startDate as unknown as string).toISOString().slice(0, 10)
        : from;
      const cohortEnd = c.endDate
        ? new Date(c.endDate as unknown as string).toISOString().slice(0, 10)
        : to;
      const lo = cohortStart > from ? cohortStart : from;
      const hi = cohortEnd   < to   ? cohortEnd   : to;
      if (lo > hi) continue;

      for (const date of dateRange(lo, hi)) {
        const wd = weekdayForDate(date);
        if (!days.has(wd)) continue;
        sessions.push({
          cohortId: c.id,
          title: c.name,
          programName: c.programName,
          courseName: c.courseName,
          startAt: istLocalToISO(date, c.startTime!),
          endAt:   istLocalToISO(date, c.endTime!),
          isTrainer:    c.trainerId   === me,
          isCoTrainer:  c.coTrainerId === me,
          trainerName:   c.trainerName,
          coTrainerName: c.coTrainerName,
          location: [c.programName, c.courseName].filter(Boolean).join(" · ") || null,
        });
      }
    }

    sessions.sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});
