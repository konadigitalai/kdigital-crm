import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { resolveActorPartyId } from "../lib/party/resolve.js";

export const learnersRouter = Router();

// GET /learners — list of learners with their primary program enrolment + counts
learnersRouter.get("/", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          p.id           AS "partyId",
          p.name         AS "name",
          p.email        AS "email",
          p.phone        AS "phone",
          p.city         AS "city",
          p.attributes   AS "attributes",
          pr.valid_from  AS "learnerSince",
          (
            SELECT json_build_object(
              'id', e.id,
              'programId', e.program_id,
              'programName', pg.name,
              'status', e.status
            )
            FROM enrolment e
            LEFT JOIN program pg ON pg.id = e.program_id
            WHERE e.party_id = p.id AND e.status = 'active'
            ORDER BY e.created_at DESC
            LIMIT 1
          ) AS "primaryEnrolment",
          (SELECT COUNT(*)::int FROM course_assignment ca WHERE ca.party_id = p.id)                          AS "totalCourses",
          (SELECT COUNT(*)::int FROM course_assignment ca WHERE ca.party_id = p.id AND ca.status = 'active') AS "activeCourses",
          (SELECT COUNT(*)::int FROM batch_assignment b WHERE b.party_id = p.id)                              AS "totalBatches",
          (SELECT COUNT(*)::int FROM batch_assignment b WHERE b.party_id = p.id AND b.status = 'active')      AS "activeBatches"
        FROM party p
        JOIN party_role pr ON pr.party_id = p.id
        WHERE pr.role = 'learner' AND pr.valid_to IS NULL
        ORDER BY pr.valid_from DESC, p.name
      `);
      return r.rows;
    });
    res.json({ learners: rows });
  } catch (err) {
    next(err);
  }
});

// GET /learners/:partyId — full record: program enrolments, course assignments,
// batch assignments. UI groups: program → course → batches.
learnersRouter.get("/:partyId", async (req, res, next) => {
  try {
    const partyId = String(req.params.partyId);
    if (!/^[0-9a-fA-F-]{36}$/.test(partyId)) return res.status(400).json({ error: "invalid id" });

    const data = await withTenant(req.tenantId!, async (db) => {
      const partyR = await db.execute(sql`
        SELECT p.id, p.name, p.email, p.phone, p.city, p.attributes,
               (SELECT valid_from FROM party_role WHERE party_id = p.id AND role = 'learner' AND valid_to IS NULL) AS "learnerSince",
               (SELECT MIN(valid_from) FROM party_role WHERE party_id = p.id AND role = 'lead') AS "leadSince"
        FROM party p
        WHERE p.id = ${partyId}
      `);
      if (!partyR.rows[0]) return null;
      const party = partyR.rows[0];

      const enrolments = await db.execute(sql`
        SELECT e.id, e.status, e.price_paid AS "pricePaid", e.created_at AS "enrolledAt",
               pg.id AS "programId", pg.name AS "programName", pg.price AS "programPrice"
        FROM enrolment e
        JOIN program pg ON pg.id = e.program_id
        WHERE e.party_id = ${partyId}
        ORDER BY e.created_at DESC
      `);

      // Course assignments — the gate. Includes co.enabled so the learner
      // page can render a static active/inactive badge for each course.
      // Course no longer carries a code or a program FK; a course lives under
      // many programs via program_course. programId/programName come from the
      // learner's enrolment when the client needs them.
      const courseAssignments = await db.execute(sql`
        SELECT
          ca.id, ca.status, ca.created_at AS "assignedAt",
          ca.enrolment_id AS "enrolmentId",
          co.id           AS "courseId",
          co.name         AS "courseName",
          co.description  AS "courseDescription",
          co.enabled      AS "courseEnabled"
        FROM course_assignment ca
        JOIN course co ON co.id = ca.course_id
        WHERE ca.party_id = ${partyId}
        ORDER BY co.name
      `);

      const batchAssignments = await db.execute(sql`
        SELECT
          ba.id, ba.status, ba.created_at AS "assignedAt",
          ba.enrolment_id         AS "enrolmentId",
          ba.course_assignment_id AS "courseAssignmentId",
          c.id   AS "cohortId",
          c.name AS "cohortName",
          c.code AS "cohortCode",
          c.slot, c.time_label AS "timeLabel", c.schedule,
          c.start_date AS "startDate", c.end_date AS "endDate",
          c.status AS "batchStatus",
          co.id   AS "courseId",
          co.name AS "courseName"
        FROM batch_assignment ba
        JOIN cohort c       ON c.id  = ba.cohort_id
        LEFT JOIN course co ON co.id = c.course_id
        WHERE ba.party_id = ${partyId}
        ORDER BY co.name, c.start_date NULLS LAST, c.name
      `);

      const timeline = await db.execute(sql`
        SELECT
          a.id         AS "id",
          a.actor_type AS "actorType",
          a.actor_name AS "actorName",
          a.verb       AS "verb",
          a.detail     AS "detail",
          a.tag        AS "tag",
          a.payload    AS "payload",
          a.ts         AS "ts"
        FROM activity a
        WHERE a.party_id = ${partyId}
          AND a.tag IN ('ai','you')
        ORDER BY a.ts DESC
      `);

      const originLead = await db.execute(sql`
        SELECT wi.number,
               wi.id          AS "workItemId",
               l.score,
               l.heat,
               l.description  AS "description"
        FROM lead l
        JOIN work_item wi ON wi.id = l.work_item_id
        WHERE wi.party_id = ${partyId}
        ORDER BY wi.created_at
        LIMIT 1
      `);

      return {
        party,
        enrolments: enrolments.rows,
        courseAssignments: courseAssignments.rows,
        assignments: batchAssignments.rows,
        timeline: timeline.rows,
        originLead: originLead.rows[0] ?? null,
      };
    });

    if (!data) return res.status(404).json({ error: "Learner not found" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /learners/:partyId/courses  { courseId } | { courseIds: [] }
//   Creates one or more course_assignment rows under the learner's active
//   program enrolment. Courses are NOT required to belong to that program —
//   any active course can be assigned to any learner.
//   Returns per-course results so the client can show "3 added, 1 already
//   assigned" etc. instead of one-or-nothing failures.
learnersRouter.post("/:partyId/courses", async (req, res, next) => {
  try {
    const partyId = String(req.params.partyId);
    if (!/^[0-9a-fA-F-]{36}$/.test(partyId)) return res.status(400).json({ error: "invalid id" });

    // Accept either {courseId} or {courseIds: []}
    const ids = Array.isArray(req.body?.courseIds)
      ? (req.body.courseIds as unknown[]).map(String).map((s) => s.trim()).filter(Boolean)
      : req.body?.courseId
        ? [String(req.body.courseId).trim()]
        : [];
    if (ids.length === 0) return res.status(400).json({ error: "courseId or courseIds[] required" });
    for (const id of ids) {
      if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: `invalid courseId: ${id}` });
    }

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      // Must be a learner
      const isLearner = await db.execute(sql`
        SELECT 1 FROM party_role WHERE party_id = ${partyId} AND role = 'learner' AND valid_to IS NULL LIMIT 1
      `);
      if (isLearner.rows.length === 0) return { kind: "not-learner" as const };

      // Pick the learner's most recent active enrolment as the umbrella for
      // all course_assignments created in this request. (Same rule applies if
      // the learner has multiple enrolments — we use the freshest one.)
      const e = await db.execute(sql`
        SELECT id FROM enrolment
        WHERE party_id = ${partyId} AND status = 'active'
        ORDER BY created_at DESC LIMIT 1
      `);
      const enrolmentId = (e.rows[0] as { id: string } | undefined)?.id;
      if (!enrolmentId) return { kind: "no-enrolment" as const };

      type Outcome =
        | { courseId: string; ok: true; courseAssignmentId: string; courseName: string }
        | { courseId: string; ok: false; error: string };
      const outcomes: Outcome[] = [];

      for (const courseId of ids) {
        const c = await db.execute(sql`
          SELECT id, name, enabled FROM course WHERE id = ${courseId}
        `);
        if (!c.rows[0]) {
          outcomes.push({ courseId, ok: false, error: "course not found" });
          continue;
        }
        const course = c.rows[0] as { id: string; name: string; enabled: boolean };
        if (!course.enabled) {
          outcomes.push({ courseId, ok: false, error: "course inactive" });
          continue;
        }

        const dup = await db.execute(sql`
          SELECT id FROM course_assignment WHERE party_id = ${partyId} AND course_id = ${courseId} LIMIT 1
        `);
        if (dup.rows.length > 0) {
          outcomes.push({ courseId, ok: false, error: "already assigned" });
          continue;
        }

        const ins = await db.execute(sql`
          INSERT INTO course_assignment (tenant_id, enrolment_id, party_id, course_id, status)
          VALUES (current_tenant(), ${enrolmentId}, ${partyId}, ${courseId}, 'active')
          RETURNING id
        `);
        outcomes.push({
          courseId, ok: true,
          courseAssignmentId: (ins.rows[0] as { id: string }).id,
          courseName: course.name,
        });
      }

      const added = outcomes.filter((o): o is Extract<Outcome, { ok: true }> => o.ok);
      if (added.length > 0) {
        const detail = added.length === 1
          ? `Assigned course: ${added[0]!.courseName}`
          : `Assigned ${added.length} courses: ${added.map((a) => a.courseName).join(", ")}`;
        await db.execute(sql`
          INSERT INTO activity (tenant_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
          VALUES (current_tenant(), ${partyId}, 'user', ${actorPartyId}, 'You', 'Course assigned',
                  ${detail}, 'you',
                  ${JSON.stringify({ when: "Just now", quote: null, courseIds: added.map((a) => a.courseId) })}::jsonb, NOW())
        `);
      }

      return { kind: "ok" as const, outcomes };
    });

    if (result.kind === "not-learner")  return res.status(404).json({ error: "Not a learner" });
    if (result.kind === "no-enrolment") return res.status(409).json({ error: "Learner has no active program enrolment" });

    const added       = result.outcomes.filter((o) => o.ok).length;
    const skipped     = result.outcomes.filter((o) => !o.ok).length;
    const status      = added > 0 ? 201 : 409;
    res.status(status).json({ ok: added > 0, added, skipped, outcomes: result.outcomes });
  } catch (err) {
    next(err);
  }
});

// PATCH /learners/:partyId/courses/:courseAssignmentId  { status }
learnersRouter.patch("/:partyId/courses/:courseAssignmentId", async (req, res, next) => {
  try {
    const partyId = String(req.params.partyId);
    const id      = String(req.params.courseAssignmentId);
    const status = String(req.body?.status ?? "");
    if (!["active", "completed", "dropped", "deferred"].includes(status)) {
      return res.status(400).json({ error: "status invalid" });
    }
    const updated = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        UPDATE course_assignment SET status = ${status}
        WHERE id = ${id} AND party_id = ${partyId}
        RETURNING id, status
      `);
      return r.rows[0];
    });
    if (!updated) return res.status(404).json({ error: "Course assignment not found" });
    res.json({ ok: true, courseAssignment: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /learners/:partyId/courses/:courseAssignmentId
//   Hard-delete a course_assignment. Any batch_assignment rows that point at
//   it are cascade-deleted by the schema (course_assignment_id has ON DELETE
//   CASCADE). We log a single activity row capturing the course name + how
//   many batches were dropped so the timeline tells the full story.
learnersRouter.delete("/:partyId/courses/:courseAssignmentId", async (req, res, next) => {
  try {
    const partyId = String(req.params.partyId);
    const id      = String(req.params.courseAssignmentId);

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      // Capture context before the cascade so we can describe what got removed.
      const ctxR = await db.execute(sql`
        SELECT co.name AS "courseName",
               (SELECT COUNT(*)::int FROM batch_assignment ba WHERE ba.course_assignment_id = ca.id) AS "batchCount"
        FROM course_assignment ca
        JOIN course co ON co.id = ca.course_id
        WHERE ca.id = ${id} AND ca.party_id = ${partyId}
      `);
      const ctx = ctxR.rows[0] as { courseName: string; batchCount: number } | undefined;
      if (!ctx) return { kind: "missing" as const };

      const del = await db.execute(sql`
        DELETE FROM course_assignment
        WHERE id = ${id} AND party_id = ${partyId}
        RETURNING id
      `);
      if (del.rows.length === 0) return { kind: "missing" as const };

      const batchPart = Number(ctx.batchCount) > 0
        ? ` (also dropped ${ctx.batchCount} batch assignment${ctx.batchCount === 1 ? "" : "s"})`
        : "";
      await db.execute(sql`
        INSERT INTO activity (tenant_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
        VALUES (current_tenant(), ${partyId}, 'user', ${actorPartyId}, 'You', 'Course removed',
                ${`Unassigned course: ${ctx.courseName}${batchPart}`}, 'you',
                ${JSON.stringify({ when: "Just now", quote: null, courseAssignmentId: id })}::jsonb, NOW())
      `);
      return { kind: "ok" as const, courseName: ctx.courseName, removedBatches: Number(ctx.batchCount) };
    });

    if (result.kind === "missing") return res.status(404).json({ error: "Course assignment not found" });
    res.json({ ok: true, courseName: result.courseName, removedBatches: result.removedBatches });
  } catch (err) {
    next(err);
  }
});

// POST /learners/:partyId/batches  { cohortId }
//   Gate: the batch's course MUST already have a course_assignment for this
//   learner. If not, 409 with a helpful error.
learnersRouter.post("/:partyId/batches", async (req, res, next) => {
  try {
    const partyId = String(req.params.partyId);
    if (!/^[0-9a-fA-F-]{36}$/.test(partyId)) return res.status(400).json({ error: "invalid id" });
    const cohortId = String(req.body?.cohortId ?? "").trim();
    if (!/^[0-9a-fA-F-]{36}$/.test(cohortId)) return res.status(400).json({ error: "cohortId required" });

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const isLearner = await db.execute(sql`
        SELECT 1 FROM party_role WHERE party_id = ${partyId} AND role = 'learner' AND valid_to IS NULL LIMIT 1
      `);
      if (isLearner.rows.length === 0) return { kind: "not-learner" as const };

      // Cohort + its course
      const c = await db.execute(sql`
        SELECT c.id, c.name, c.code, c.enabled, c.status, c.course_id AS "courseId",
               co.name AS "courseName"
        FROM cohort c
        LEFT JOIN course co ON co.id = c.course_id
        WHERE c.id = ${cohortId}
      `);
      if (!c.rows[0]) return { kind: "cohort-missing" as const };
      const cohort = c.rows[0] as { id: string; name: string; code: string|null; enabled: boolean; status: string; courseId: string|null; courseName: string|null };
      if (!cohort.enabled) return { kind: "cohort-inactive" as const };
      if (!cohort.courseId) return { kind: "cohort-no-course" as const };

      // Course assignment for that course
      const ca = await db.execute(sql`
        SELECT id, enrolment_id AS "enrolmentId" FROM course_assignment
        WHERE party_id = ${partyId} AND course_id = ${cohort.courseId} LIMIT 1
      `);
      const courseAssignment = ca.rows[0] as { id: string; enrolmentId: string } | undefined;
      if (!courseAssignment) {
        return { kind: "course-not-assigned" as const, courseName: cohort.courseName ?? "this course" };
      }

      // Already assigned to this batch?
      const dup = await db.execute(sql`
        SELECT 1 FROM batch_assignment WHERE party_id = ${partyId} AND cohort_id = ${cohortId} LIMIT 1
      `);
      if (dup.rows.length > 0) return { kind: "duplicate" as const };

      const r = await db.execute(sql`
        INSERT INTO batch_assignment (tenant_id, enrolment_id, course_assignment_id, party_id, cohort_id, status)
        VALUES (current_tenant(), ${courseAssignment.enrolmentId}, ${courseAssignment.id}, ${partyId}, ${cohortId}, 'active')
        RETURNING id
      `);

      await db.execute(sql`
        INSERT INTO activity (tenant_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
        VALUES (current_tenant(), ${partyId}, 'user', ${actorPartyId}, 'You', 'Batch assigned',
                ${`Assigned to ${cohort.name} (course: ${cohort.courseName}).`}, 'you',
                ${JSON.stringify({ when: "Just now", quote: null, cohortId, courseId: cohort.courseId })}::jsonb, NOW())
      `);

      return { kind: "ok" as const, assignmentId: (r.rows[0] as { id: string }).id };
    });

    if (result.kind === "not-learner")        return res.status(404).json({ error: "Not a learner" });
    if (result.kind === "cohort-missing")     return res.status(404).json({ error: "Batch not found" });
    if (result.kind === "cohort-inactive")    return res.status(409).json({ error: "Batch is inactive" });
    if (result.kind === "cohort-no-course")   return res.status(409).json({ error: "Batch is not attached to a course" });
    if (result.kind === "course-not-assigned") {
      return res.status(409).json({
        error: `Learner is not assigned to the course "${result.courseName}". Add the course first, then assign a batch.`,
        code: "course_not_assigned",
      });
    }
    if (result.kind === "duplicate")          return res.status(409).json({ error: "Already assigned to this batch" });

    res.status(201).json({ ok: true, assignmentId: result.assignmentId });
  } catch (err) {
    next(err);
  }
});

// PATCH /learners/:partyId/batches/:assignmentId
learnersRouter.patch("/:partyId/batches/:assignmentId", async (req, res, next) => {
  try {
    const partyId = String(req.params.partyId);
    const assignmentId = String(req.params.assignmentId);
    const status = String(req.body?.status ?? "");
    if (!["active", "completed", "dropped", "deferred"].includes(status)) {
      return res.status(400).json({ error: "status invalid" });
    }
    const updated = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        UPDATE batch_assignment SET status = ${status}
        WHERE id = ${assignmentId} AND party_id = ${partyId}
        RETURNING id, status
      `);
      return r.rows[0];
    });
    if (!updated) return res.status(404).json({ error: "Assignment not found" });
    res.json({ ok: true, assignment: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /learners/:partyId/batches/:assignmentId
//   Hard-delete a batch_assignment. Mirrors the unassign-course route but at
//   batch granularity — removes the learner from one cohort without touching
//   the parent course assignment or other batches under it. Logs one
//   activity row so the timeline tells the story.
learnersRouter.delete("/:partyId/batches/:assignmentId", async (req, res, next) => {
  try {
    const partyId      = String(req.params.partyId);
    const assignmentId = String(req.params.assignmentId);

    const actorName = req.user?.name?.trim() || "You";

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const ctxR = await db.execute(sql`
        SELECT c.name AS "cohortName",
               co.name AS "courseName"
        FROM batch_assignment ba
        JOIN cohort c ON c.id = ba.cohort_id
        LEFT JOIN course co ON co.id = c.course_id
        WHERE ba.id = ${assignmentId} AND ba.party_id = ${partyId}
      `);
      const ctx = ctxR.rows[0] as { cohortName: string; courseName: string | null } | undefined;
      if (!ctx) return { kind: "missing" as const };

      const del = await db.execute(sql`
        DELETE FROM batch_assignment
        WHERE id = ${assignmentId} AND party_id = ${partyId}
        RETURNING id
      `);
      if (del.rows.length === 0) return { kind: "missing" as const };

      const detail = ctx.courseName
        ? `Unassigned batch: ${ctx.cohortName} (course: ${ctx.courseName})`
        : `Unassigned batch: ${ctx.cohortName}`;
      await db.execute(sql`
        INSERT INTO activity (tenant_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
        VALUES (current_tenant(), ${partyId}, 'user', ${actorPartyId}, ${actorName}, 'Batch removed',
                ${detail}, 'you',
                ${JSON.stringify({ when: "Just now", quote: null, batchAssignmentId: assignmentId })}::jsonb, NOW())
      `);
      return { kind: "ok" as const, cohortName: ctx.cohortName };
    });

    if (result.kind === "missing") return res.status(404).json({ error: "Assignment not found" });
    res.json({ ok: true, cohortName: result.cohortName });
  } catch (err) {
    next(err);
  }
});
