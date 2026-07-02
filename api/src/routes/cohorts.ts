import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { partyIdFromAppUserId } from "../lib/party/resolve.js";

export const cohortsRouter = Router();

const STATUSES = ["upcoming", "running", "completed", "cancelled"];
const SLOTS = ["morning", "afternoon", "evening"];
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type WeekDay = typeof WEEKDAYS[number];
const WEEKDAY_LABEL: Record<WeekDay, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

// Strip seconds — clients send "HH:MM"; Postgres `time` accepts both. We
// normalise to "HH:MM:00" so reads are predictable.
function normaliseTime(raw: string): string | null {
  const m = TIME_RE.exec(raw.trim());
  if (!m) return null;
  return `${m[1]}:${m[2]}:${m[3] ?? "00"}`;
}

function deriveTimeLabel(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  return `${start.slice(0, 5)} – ${end.slice(0, 5)}`;
}

function deriveSchedule(days: WeekDay[] | null): string | null {
  if (!days || days.length === 0) return null;
  // Re-order canonical so "Wed · Mon · Fri" doesn't slip through.
  const sorted = [...days].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
  return sorted.map((d) => WEEKDAY_LABEL[d]).join(" · ");
}

// Build a `sql` fragment that materialises a text[] (or NULL). We assemble it
// element-by-element so the driver still parameter-binds each value safely —
// this avoids Drizzle treating a JS array as a record tuple in INSERT/UPDATE.
function daysSqlValue(days: WeekDay[] | null) {
  if (!days || days.length === 0) return sql`NULL::text[]`;
  const parts = days.map((d) => sql`${d}`);
  return sql`ARRAY[${sql.join(parts, sql`, `)}]::text[]`;
}

const COHORT_SELECT = sql`
  SELECT
    c.id,
    c.name,
    c.code,
    c.slot,
    c.time_label  AS "timeLabel",
    c.schedule,
    c.start_date  AS "startDate",
    c.end_date    AS "endDate",
    c.seats,
    c.status,
    c.enabled,
    c.course_id   AS "courseId",
    co.name       AS "courseName",
    co.code       AS "courseCode",
    co.enabled    AS "courseEnabled",
    co.program_id AS "programId",
    p.name        AS "programName",
    p.enabled     AS "programEnabled",
    c.trainer_id    AS "trainerId",
    tu.name         AS "trainerName",
    c.co_trainer_id AS "coTrainerId",
    cu.name         AS "coTrainerName",
    c.days_of_week  AS "daysOfWeek",
    to_char(c.start_time, 'HH24:MI') AS "startTime",
    to_char(c.end_time,   'HH24:MI') AS "endTime",
    (SELECT COUNT(*)::int FROM batch_assignment ba WHERE ba.cohort_id = c.id)                            AS "enrolmentCount",
    (SELECT COUNT(*)::int FROM batch_assignment ba WHERE ba.cohort_id = c.id AND ba.status = 'active')   AS "activeCount"
  FROM cohort c
  LEFT JOIN course   co ON co.id = c.course_id
  LEFT JOIN program  p  ON p.id  = co.program_id
  LEFT JOIN app_user tu ON tu.party_id = c.trainer_id
  LEFT JOIN app_user cu ON cu.party_id = c.co_trainer_id
`;

cohortsRouter.get("/", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        ${COHORT_SELECT}
        ORDER BY c.enabled DESC, p.name NULLS LAST, co.name NULLS LAST, c.start_date NULLS LAST, c.name
      `);
      return r.rows;
    });
    res.json({ cohorts: rows });
  } catch (err) {
    next(err);
  }
});

cohortsRouter.post("/", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const courseId = String(b.courseId ?? "").trim();
    const name = String(b.name ?? "").trim();
    if (!courseId || !/^[0-9a-fA-F-]{36}$/.test(courseId)) return res.status(400).json({ error: "courseId required" });
    if (!name) return res.status(400).json({ error: "name is required" });
    const code      = b.code      ? String(b.code).trim()      : null;
    const slot      = b.slot ? String(b.slot).trim() : null;
    if (slot && !SLOTS.includes(slot)) return res.status(400).json({ error: "slot invalid" });
    const startDate = b.startDate ? String(b.startDate).trim() : null;
    const endDate   = b.endDate   ? String(b.endDate).trim()   : null;
    const seats     = b.seats != null && b.seats !== "" ? Number(b.seats) : null;
    const status    = String(b.status ?? "upcoming").trim();
    if (!STATUSES.includes(status)) return res.status(400).json({ error: "status invalid" });

    // ── Phase H: structured trainer + cadence ───────────────────────────────
    const trainerId   = b.trainerId   ? String(b.trainerId).trim()   : null;
    const coTrainerId = b.coTrainerId ? String(b.coTrainerId).trim() : null;
    if (trainerId   && !/^[0-9a-fA-F-]{36}$/.test(trainerId))   return res.status(400).json({ error: "trainerId invalid" });
    if (coTrainerId && !/^[0-9a-fA-F-]{36}$/.test(coTrainerId)) return res.status(400).json({ error: "coTrainerId invalid" });
    if (trainerId && coTrainerId && trainerId === coTrainerId) {
      return res.status(400).json({ error: "trainer and co-trainer must differ" });
    }

    let daysOfWeek: WeekDay[] | null = null;
    if (Array.isArray(b.daysOfWeek)) {
      const cleaned = (b.daysOfWeek as unknown[]).map((d) => String(d).trim().toLowerCase());
      for (const d of cleaned) {
        if (!WEEKDAYS.includes(d as WeekDay)) return res.status(400).json({ error: `daysOfWeek: '${d}' invalid` });
      }
      daysOfWeek = Array.from(new Set(cleaned)) as WeekDay[];
    }

    let startTime: string | null = null;
    let endTime: string | null = null;
    if (b.startTime) {
      startTime = normaliseTime(String(b.startTime));
      if (!startTime) return res.status(400).json({ error: "startTime must be HH:MM" });
    }
    if (b.endTime) {
      endTime = normaliseTime(String(b.endTime));
      if (!endTime) return res.status(400).json({ error: "endTime must be HH:MM" });
    }
    if (startTime && endTime && endTime <= startTime) {
      return res.status(400).json({ error: "endTime must be after startTime" });
    }
    if (daysOfWeek && daysOfWeek.length > 0 && (!startTime || !endTime)) {
      return res.status(400).json({ error: "startTime and endTime required when daysOfWeek is set" });
    }

    // Mirror schedule + time_label from structured fields if caller didn't send them.
    const timeLabel = b.timeLabel !== undefined
      ? (b.timeLabel ? String(b.timeLabel).trim() : null)
      : deriveTimeLabel(startTime, endTime);
    const schedule = b.schedule !== undefined
      ? (b.schedule ? String(b.schedule).trim() : null)
      : deriveSchedule(daysOfWeek);

    const created = await withTenant(req.tenantId!, async (db) => {
      // Phase 2: FK columns store party.id now; resolve incoming app_user.ids.
      const trainerPartyId   = await partyIdFromAppUserId(db, trainerId);
      const coTrainerPartyId = await partyIdFromAppUserId(db, coTrainerId);
      const r = await db.execute(sql`
        INSERT INTO cohort
          (tenant_id, course_id, name, code, slot, time_label, schedule,
           start_date, end_date, seats, status, enabled,
           trainer_id, co_trainer_id, days_of_week, start_time, end_time)
        VALUES
          (current_tenant(), ${courseId}, ${name}, ${code}, ${slot}, ${timeLabel}, ${schedule},
           ${startDate}, ${endDate}, ${seats}, ${status}, true,
           ${trainerPartyId}, ${coTrainerPartyId}, ${daysSqlValue(daysOfWeek)}, ${startTime}, ${endTime})
        RETURNING id
      `);
      const id = (r.rows[0] as { id: string }).id;
      const detail = await db.execute(sql`${COHORT_SELECT} WHERE c.id = ${id}`);
      return detail.rows[0];
    });
    res.status(201).json({ cohort: created });
  } catch (err) {
    next(err);
  }
});

cohortsRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "invalid id" });
    const b = req.body ?? {};

    const sets: ReturnType<typeof sql>[] = [];
    if (b.name !== undefined)      sets.push(sql`name = ${String(b.name).trim()}`);
    if (b.code !== undefined)      sets.push(sql`code = ${b.code ? String(b.code).trim() : null}`);
    if (b.slot !== undefined) {
      if (b.slot !== null && b.slot !== "" && !SLOTS.includes(String(b.slot))) {
        return res.status(400).json({ error: "slot invalid" });
      }
      sets.push(sql`slot = ${b.slot === "" ? null : b.slot}`);
    }
    if (b.startDate !== undefined) sets.push(sql`start_date = ${b.startDate ? String(b.startDate).trim() : null}`);
    if (b.endDate !== undefined)   sets.push(sql`end_date   = ${b.endDate   ? String(b.endDate).trim()   : null}`);
    if (b.seats !== undefined)     sets.push(sql`seats = ${b.seats !== "" && b.seats != null ? Number(b.seats) : null}`);
    if (b.status !== undefined) {
      if (!STATUSES.includes(String(b.status))) return res.status(400).json({ error: "status invalid" });
      sets.push(sql`status = ${String(b.status)}`);
    }
    if (b.enabled !== undefined)   sets.push(sql`enabled = ${Boolean(b.enabled)}`);

    // ── Phase H: structured trainer + cadence ───────────────────────────────
    let trainerProvided = false;
    let coTrainerProvided = false;
    let trainerId: string | null = null;
    let coTrainerId: string | null = null;
    // Phase 2: sets happen inside withTenant below so we can resolve
    // app_user.id → party.id via the same db handle.
    if (b.trainerId !== undefined) {
      trainerProvided = true;
      trainerId = b.trainerId ? String(b.trainerId).trim() : null;
      if (trainerId && !/^[0-9a-fA-F-]{36}$/.test(trainerId)) {
        return res.status(400).json({ error: "trainerId invalid" });
      }
    }
    if (b.coTrainerId !== undefined) {
      coTrainerProvided = true;
      coTrainerId = b.coTrainerId ? String(b.coTrainerId).trim() : null;
      if (coTrainerId && !/^[0-9a-fA-F-]{36}$/.test(coTrainerId)) {
        return res.status(400).json({ error: "coTrainerId invalid" });
      }
    }
    if (trainerProvided && coTrainerProvided && trainerId && coTrainerId && trainerId === coTrainerId) {
      return res.status(400).json({ error: "trainer and co-trainer must differ" });
    }

    let daysProvided = false;
    let daysOfWeek: WeekDay[] | null = null;
    if (b.daysOfWeek !== undefined) {
      daysProvided = true;
      if (b.daysOfWeek === null) {
        daysOfWeek = null;
      } else if (Array.isArray(b.daysOfWeek)) {
        const cleaned = (b.daysOfWeek as unknown[]).map((d) => String(d).trim().toLowerCase());
        for (const d of cleaned) {
          if (!WEEKDAYS.includes(d as WeekDay)) return res.status(400).json({ error: `daysOfWeek: '${d}' invalid` });
        }
        daysOfWeek = Array.from(new Set(cleaned)) as WeekDay[];
      } else {
        return res.status(400).json({ error: "daysOfWeek must be array or null" });
      }
      sets.push(sql`days_of_week = ${daysSqlValue(daysOfWeek)}`);
    }

    let startTimeProvided = false;
    let endTimeProvided   = false;
    let startTime: string | null = null;
    let endTime: string | null = null;
    if (b.startTime !== undefined) {
      startTimeProvided = true;
      if (b.startTime) {
        startTime = normaliseTime(String(b.startTime));
        if (!startTime) return res.status(400).json({ error: "startTime must be HH:MM" });
      }
      sets.push(sql`start_time = ${startTime}`);
    }
    if (b.endTime !== undefined) {
      endTimeProvided = true;
      if (b.endTime) {
        endTime = normaliseTime(String(b.endTime));
        if (!endTime) return res.status(400).json({ error: "endTime must be HH:MM" });
      }
      sets.push(sql`end_time = ${endTime}`);
    }
    if (startTimeProvided && endTimeProvided && startTime && endTime && endTime <= startTime) {
      return res.status(400).json({ error: "endTime must be after startTime" });
    }

    // Mirror time_label / schedule unless the caller is touching them
    // explicitly, but only if the structured side was just edited.
    if (b.timeLabel !== undefined) {
      sets.push(sql`time_label = ${b.timeLabel ? String(b.timeLabel).trim() : null}`);
    } else if ((startTimeProvided || endTimeProvided) && startTime && endTime) {
      sets.push(sql`time_label = ${deriveTimeLabel(startTime, endTime)}`);
    } else if ((startTimeProvided || endTimeProvided) && (!startTime || !endTime)) {
      sets.push(sql`time_label = NULL`);
    }
    if (b.schedule !== undefined) {
      sets.push(sql`schedule = ${b.schedule ? String(b.schedule).trim() : null}`);
    } else if (daysProvided) {
      sets.push(sql`schedule = ${deriveSchedule(daysOfWeek)}`);
    }

    const updated = await withTenant(req.tenantId!, async (db) => {
      // Phase 2: resolve trainerId / coTrainerId (which are app_user.ids from
      // the client) to party.id before pushing them into the SET clause.
      if (trainerProvided) {
        const partyId = await partyIdFromAppUserId(db, trainerId);
        sets.push(sql`trainer_id = ${partyId}`);
      }
      if (coTrainerProvided) {
        const partyId = await partyIdFromAppUserId(db, coTrainerId);
        sets.push(sql`co_trainer_id = ${partyId}`);
      }
      if (sets.length === 0) return "empty";
      const setClause = sql.join(sets, sql`, `);
      const r = await db.execute(sql`
        UPDATE cohort SET ${setClause}
        WHERE id = ${id}
        RETURNING id
      `);
      const row = r.rows[0] as { id: string } | undefined;
      if (!row) return null;
      const detail = await db.execute(sql`${COHORT_SELECT} WHERE c.id = ${row.id}`);
      return detail.rows[0];
    });
    if (updated === "empty") return res.status(400).json({ error: "no fields to update" });
    if (!updated) return res.status(404).json({ error: "cohort not found" });
    res.json({ cohort: updated });
  } catch (err) {
    next(err);
  }
});
