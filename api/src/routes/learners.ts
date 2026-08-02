import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { resolveActorPartyId } from "../lib/party/resolve.js";

export const learnersRouter = Router();

// Human-friendly board status derived from the learner's engagement counts.
// Kept a pure function so the list route can compute it per-row.
//   activeBatches > 0            → "In batch"
//   activeCourses > 0, no batch  → "Assigned"
//   anything else                → "Enrolled"
function learnerStatus(activeCourses: number, activeBatches: number): string {
  if (activeBatches > 0) return "In batch";
  if (activeCourses > 0) return "Assigned";
  return "Enrolled";
}

// GET /learners — enriched learner rows for the Learners board (list/kanban/
// chart/calendar). One row per learner (party currently 'learner'), newest
// first. Carries contact, program, course-module chips, primary batch
// code, best-effort advisor (via the party's originating lead), the sparse
// learner_profile satellite, and the engagement counts the board groups on.
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
          -- Primary enrolment: prefer an active one, else the newest.
          pe.id          AS "enrolmentId",
          pe.status      AS "enrolmentStatus",
          pg.id          AS "programId",
          pg.name        AS "programName",
          -- The programme's registry family (Data Engineering, ServiceNow…).
          -- The coarse grouping axis the board used to get from stack.
          pg.family      AS "family",
          au.id          AS "advisorId",     -- app_user.id (l.advisor_id stores party.id)
          au.name        AS "advisorName",
          -- learner_profile satellite (sparse — nulls fine).
          lp.skill_level       AS "skillLevel",
          lp.placement_status  AS "placementStatus",
          lp.mentor_party_id   AS "mentorPartyId",
          -- post-0088: how they are DOING, not just where they ended up.
          -- Risk is what an advisor acts on weeks before a drop-out; without
          -- it the first signal is the drop-out.
          lp.progress_percent  AS "progressPercent",
          lp.risk_level        AS "riskLevel",
          lp.risk_reason       AS "riskReason",
          -- The staffing gate. Both live here, on the learner rather than on
          -- the candidate record, so that withdrawing consent removes someone
          -- from staffing however many applications are open.
          lp.staffing_eligibility_status AS "staffingEligibilityStatus",
          lp.staffing_consent_status     AS "staffingConsentStatus",
          lp.staffing_consent_at         AS "staffingConsentAt",
          (SELECT COUNT(*)::int FROM candidate cd WHERE cd.party_id = p.id) AS "hasCandidateProfile",
          -- Course-module chips: the learner's assigned course names.
          (
            SELECT COALESCE(array_agg(DISTINCT co.name) FILTER (WHERE co.name IS NOT NULL), '{}')
            FROM course_assignment ca
            JOIN course co ON co.id = ca.course_id
            WHERE ca.party_id = p.id
          )              AS "courseModules",
          -- Primary batch code: prefer an active assignment, else the newest.
          (
            SELECT c.code FROM batch_assignment b
            JOIN cohort c ON c.id = b.cohort_id
            WHERE b.party_id = p.id
            ORDER BY (b.status = 'active') DESC, b.created_at DESC
            LIMIT 1
          )              AS "batchCode",
          (SELECT COUNT(*)::int FROM course_assignment ca WHERE ca.party_id = p.id)                          AS "totalCourses",
          (SELECT COUNT(*)::int FROM course_assignment ca WHERE ca.party_id = p.id AND ca.status = 'active') AS "activeCourses",
          (SELECT COUNT(*)::int FROM batch_assignment b WHERE b.party_id = p.id)                              AS "totalBatches",
          (SELECT COUNT(*)::int FROM batch_assignment b WHERE b.party_id = p.id AND b.status = 'active')      AS "activeBatches"
        FROM party p
        JOIN party_role pr ON pr.party_id = p.id
        LEFT JOIN LATERAL (
          SELECT e.id, e.program_id, e.status
          FROM enrolment e
          WHERE e.party_id = p.id
          ORDER BY (e.status = 'active') DESC, e.created_at DESC
          LIMIT 1
        ) pe ON true
        LEFT JOIN program pg  ON pg.id  = pe.program_id
        LEFT JOIN LATERAL (
          SELECT l.advisor_id
          FROM lead l
          JOIN work_item wi ON wi.id = l.work_item_id
          WHERE wi.party_id = p.id
          ORDER BY wi.created_at
          LIMIT 1
        ) al ON true
        LEFT JOIN app_user au        ON au.party_id = al.advisor_id
        LEFT JOIN learner_profile lp ON lp.party_id = p.id
        WHERE pr.role = 'learner' AND pr.valid_to IS NULL
        ORDER BY pr.valid_from DESC, p.name
      `);
      return r.rows;
    });

    const learners = rows.map((raw) => {
      const row = raw as {
        partyId: string; name: string; email: string | null; phone: string | null;
        city: string | null; attributes: { initials?: string } | null; learnerSince: string;
        enrolmentId: string | null; enrolmentStatus: string | null;
        programId: string | null; programName: string | null; family: string | null;
        advisorId: string | null; advisorName: string | null;
        skillLevel: string | null; placementStatus: string | null; mentorPartyId: string | null;
        progressPercent: number | null; riskLevel: string | null; riskReason: string | null;
        staffingEligibilityStatus: string | null; staffingConsentStatus: string | null;
        staffingConsentAt: string | null; hasCandidateProfile: number;
        courseModules: string[] | null; batchCode: string | null;
        totalCourses: number; activeCourses: number; totalBatches: number; activeBatches: number;
      };
      return {
        ...row,
        attributes: row.attributes ?? {},
        courseModules: row.courseModules ?? [],
        status: learnerStatus(row.activeCourses, row.activeBatches),
        primaryEnrolment: row.enrolmentId
          ? {
              id: row.enrolmentId,
              programId: row.programId,
              programName: row.programName,
              status: row.enrolmentStatus,
            }
          : null,
      };
    });

    res.json({ learners });
  } catch (err) {
    next(err);
  }
});

// GET /learners/summary — KPI aggregates for the Learners board stat cards.
// Same population as GET / (parties currently 'learner'). One efficient query;
// the roll-ups are computed in SQL.
//
// Registered BEFORE the /:partyId route so "summary" isn't captured as an id.
learnersRouter.get("/summary", async (req, res, next) => {
  try {
    const summary = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          COUNT(*)::int AS "totalLearners",
          COUNT(*) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM batch_assignment b
              WHERE b.party_id = p.id AND b.status = 'active'
            )
          )::int AS "activeInBatch",
          COUNT(*) FILTER (
            WHERE NOT EXISTS (
              SELECT 1 FROM batch_assignment b
              WHERE b.party_id = p.id AND b.status = 'active'
            )
          )::int AS "notBatched",
          COUNT(*) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM enrolment e
              WHERE e.party_id = p.id AND e.status = 'completed'
            )
          )::int AS "completed",
          COUNT(*) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM learner_profile lp
              WHERE lp.party_id = p.id AND lp.placement_status = 'placed'
            )
          )::int AS "placed"
        FROM party p
        JOIN party_role pr ON pr.party_id = p.id
        WHERE pr.role = 'learner' AND pr.valid_to IS NULL
      `);
      return r.rows[0] as {
        totalLearners: number; activeInBatch: number;
        notBatched: number; completed: number; placed: number;
      };
    });

    res.json({ summary });
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
               -- Fee ledger now lives on the enrolment (post-0077). A learner
               -- has one enrolment; prefer the active one if several ever exist.
               e.fee_quoted        AS "feeQuoted",
               e.fee_paid          AS "feePaid",
               e.due_date          AS "dueDate",
               e.payment_status    AS "paymentStatus",
               e.payment_proof_url AS "paymentProofUrl",
               COALESCE(e.payment_proofs, '{}'::text[]) AS "paymentProofs",
               e.fee_notes         AS "feeNotes",
               (SELECT valid_from FROM party_role WHERE party_id = p.id AND role = 'learner' AND valid_to IS NULL) AS "learnerSince",
               (SELECT MIN(valid_from) FROM party_role WHERE party_id = p.id AND role = 'lead') AS "leadSince",
               -- post-0088: progress, risk, and the staffing gate. Both
               -- staffing columns live on the learner, not on the candidate
               -- record, so withdrawing consent removes them from staffing
               -- however many applications are open.
               lp.progress_percent AS "progressPercent",
               lp.risk_level       AS "riskLevel",
               lp.risk_reason      AS "riskReason",
               lp.staffing_eligibility_status AS "staffingEligibilityStatus",
               lp.staffing_consent_status     AS "staffingConsentStatus",
               lp.staffing_consent_at         AS "staffingConsentAt",
               (SELECT COUNT(*)::int FROM candidate cd WHERE cd.party_id = p.id) AS "hasCandidateProfile"
        FROM party p
        LEFT JOIN learner_profile lp ON lp.party_id = p.id
        LEFT JOIN LATERAL (
          SELECT fee_quoted, fee_paid, due_date, payment_status,
                 payment_proof_url, payment_proofs, fee_notes
          FROM enrolment
          WHERE party_id = p.id
          ORDER BY (status = 'active') DESC, created_at DESC
          LIMIT 1
        ) e ON true
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

// PATCH /learners/:partyId/fee — update the learner's fee ledger. Any subset
// of fields can be sent; unsent fields are left untouched. fee_due is NOT a
// stored field — the client computes it from (fee_quoted − fee_paid).
//
// Emits a single "Fee ledger updated" activity row with a diff summary so
// the learner timeline records who changed what and when.
const PAYMENT_STATUSES = ["pending", "paid", "refund", "on_hold"] as const;

const FEE_STATUS_LABEL: Record<string, string> = {
  pending: "Pending", paid: "Paid", refund: "Refund", on_hold: "On hold",
};

// Format a fee-related value into the string that appears in the diff.
// Kept short so several changes fit on one line in the timeline.
function fmtFeeValue(field: string, v: string | number | null): string {
  if (v == null || v === "") return "—";
  if (field === "feeQuoted" || field === "feePaid") return `₹${Number(v).toLocaleString("en-IN")}`;
  if (field === "paymentStatus") return FEE_STATUS_LABEL[String(v)] ?? String(v);
  if (field === "paymentProofs") {
    const n = Number(v);
    return n === 0 ? "none" : `${n} receipt${n === 1 ? "" : "s"}`;
  }
  if (field === "feeNotes") {
    const s = String(v);
    return s.length > 40 ? `${s.slice(0, 37)}…` : s;
  }
  return String(v);
}

const FEE_FIELD_LABEL: Record<string, string> = {
  feeQuoted:      "Fee quoted",
  feePaid:        "Fee paid",
  dueDate:        "Due date",
  paymentStatus:  "Payment status",
  paymentProofs:  "Payment proof",
  feeNotes:       "Notes",
};

// Cap each receipt at ~5 MB (base64) and the whole array at ~20 MB, so a
// runaway upload can't wedge Postgres or fill the JSON body.
const MAX_PROOF_ENTRY_BYTES = 6_500_000;
const MAX_PROOF_TOTAL_BYTES = 26_000_000;

// ─── PATCH /:partyId/profile — progress, risk, and the staffing gate ─────
//
// The two staffing columns are the reason this endpoint exists rather than
// the fields being edited on the candidate record. They are facts about the
// LEARNER: a learner who withdraws consent has to leave staffing however many
// applications are open, and that only works if there is one place the answer
// lives. `candidate_eligible` reads these; nothing else may restate them.
//
// Setting consent to 'granted' stamps staffing_consent_at server-side —
// consent with no timestamp is not evidence of anything.

const RISK_LEVELS = ["low", "medium", "high"];
const ELIGIBILITY = ["not_assessed", "qualified", "not_qualified"];
const CONSENT     = ["not_asked", "granted", "withheld", "withdrawn"];

learnersRouter.patch("/:partyId/profile", async (req, res, next) => {
  try {
    const partyId = String(req.params.partyId);
    if (!/^[0-9a-fA-F-]{36}$/.test(partyId)) return res.status(400).json({ error: "invalid id" });
    const b = req.body ?? {};
    const actorName = req.user?.name?.trim() || "You";

    const sets: ReturnType<typeof sql>[] = [];
    const changes: string[] = [];

    if (b.progressPercent !== undefined) {
      const v = b.progressPercent == null || b.progressPercent === "" ? null : Number(b.progressPercent);
      if (v !== null && (!Number.isInteger(v) || v < 0 || v > 100)) {
        return res.status(400).json({ error: "progressPercent must be an integer between 0 and 100" });
      }
      sets.push(sql`progress_percent = ${v}`);
      changes.push(`Progress: ${v ?? "—"}%`);
    }

    if (b.riskLevel !== undefined) {
      const v = b.riskLevel == null || b.riskLevel === "" ? null : String(b.riskLevel).trim().toLowerCase();
      if (v !== null && !RISK_LEVELS.includes(v)) {
        return res.status(400).json({ error: `riskLevel must be one of: ${RISK_LEVELS.join(", ")}` });
      }
      sets.push(sql`risk_level = ${v}`);
      changes.push(`Risk: ${v ?? "cleared"}`);
    }

    if (b.riskReason !== undefined) {
      sets.push(sql`risk_reason = ${b.riskReason ? String(b.riskReason).trim() : null}`);
    }

    if (b.staffingEligibilityStatus !== undefined) {
      const v = String(b.staffingEligibilityStatus).trim();
      if (!ELIGIBILITY.includes(v)) {
        return res.status(400).json({ error: `staffingEligibilityStatus must be one of: ${ELIGIBILITY.join(", ")}` });
      }
      sets.push(sql`staffing_eligibility_status = ${v}`);
      changes.push(`Staffing eligibility: ${v.replace(/_/g, " ")}`);
    }

    if (b.staffingConsentStatus !== undefined) {
      const v = String(b.staffingConsentStatus).trim();
      if (!CONSENT.includes(v)) {
        return res.status(400).json({ error: `staffingConsentStatus must be one of: ${CONSENT.join(", ")}` });
      }
      sets.push(sql`staffing_consent_status = ${v}`);
      // Granting stamps the moment; anything else clears it, so a withdrawn
      // consent cannot leave a timestamp behind that reads as still valid.
      sets.push(v === "granted" ? sql`staffing_consent_at = NOW()` : sql`staffing_consent_at = NULL`);
      changes.push(`Staffing consent: ${v.replace(/_/g, " ")}`);
    }

    if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });

    const result = await withTenant(req.tenantId!, async (db) => {
      // The profile row is created on convert-to-learner. Upsert anyway so a
      // legacy learner without one does not 404 on their first edit.
      await db.execute(sql`
        INSERT INTO learner_profile (tenant_id, party_id)
        VALUES (current_tenant(), ${partyId})
        ON CONFLICT (party_id) DO NOTHING
      `);

      const r = await db.execute(sql`
        UPDATE learner_profile SET ${sql.join(sets, sql`, `)}
        WHERE party_id = ${partyId}
        RETURNING party_id AS "partyId",
                  progress_percent AS "progressPercent",
                  risk_level  AS "riskLevel",
                  risk_reason AS "riskReason",
                  staffing_eligibility_status AS "staffingEligibilityStatus",
                  staffing_consent_status     AS "staffingConsentStatus",
                  staffing_consent_at         AS "staffingConsentAt"
      `);
      if (!r.rows[0]) return null;

      if (changes.length > 0) {
        const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
        await db.execute(sql`
          INSERT INTO activity (tenant_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
          VALUES (current_tenant(), ${partyId}, 'user', ${actorPartyId}, ${actorName}, 'Learner profile updated',
                  ${changes.join(" · ")}, 'you',
                  ${JSON.stringify({ when: "Just now", quote: null })}::jsonb, NOW())
        `);
      }
      return r.rows[0];
    });

    if (!result) return res.status(404).json({ error: "learner not found" });
    res.json({ ok: true, profile: result });
  } catch (err) {
    next(err);
  }
});

learnersRouter.patch("/:partyId/fee", async (req, res, next) => {
  try {
    const partyId = String(req.params.partyId);
    if (!/^[0-9a-fA-F-]{36}$/.test(partyId)) return res.status(400).json({ error: "invalid id" });
    const b = req.body ?? {};

    // Money coerces to a string ("12345.67") because Postgres NUMERIC returns
    // strings on the way out — we keep the write path symmetric.
    function money(v: unknown): string | null | undefined {
      if (v === undefined) return undefined;
      if (v === null || v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error("fee amount must be a non-negative number");
      return String(n);
    }

    let feeQuoted: string | null | undefined;
    let feePaid:   string | null | undefined;
    try {
      feeQuoted = money(b.feeQuoted);
      feePaid   = money(b.feePaid);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    const dueDate = b.dueDate !== undefined
      ? (b.dueDate ? String(b.dueDate).trim() : null)
      : undefined;
    if (dueDate !== undefined && dueDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      return res.status(400).json({ error: "dueDate must be YYYY-MM-DD" });
    }

    const paymentStatus = b.paymentStatus !== undefined
      ? (b.paymentStatus ? String(b.paymentStatus).trim() : null)
      : undefined;
    if (paymentStatus !== undefined && paymentStatus !== null
        && !PAYMENT_STATUSES.includes(paymentStatus as typeof PAYMENT_STATUSES[number])) {
      return res.status(400).json({ error: `paymentStatus must be one of ${PAYMENT_STATUSES.join(", ")}` });
    }

    // Payment proofs — ordered list. Each entry is either an https URL or
    // a data: URL (base64 inline receipt image). We keep the legacy
    // paymentProofUrl in sync (write the first entry there) for one release
    // so any older reader stays coherent.
    let paymentProofs: string[] | undefined;
    if (b.paymentProofs !== undefined) {
      if (!Array.isArray(b.paymentProofs)) {
        return res.status(400).json({ error: "paymentProofs must be an array" });
      }
      const cleaned: string[] = [];
      let total = 0;
      for (const raw of b.paymentProofs) {
        const s = String(raw ?? "").trim();
        if (!s) continue;
        if (s.length > MAX_PROOF_ENTRY_BYTES) {
          return res.status(413).json({ error: "one payment proof is too large (max ~5 MB)" });
        }
        total += s.length;
        cleaned.push(s);
      }
      if (total > MAX_PROOF_TOTAL_BYTES) {
        return res.status(413).json({ error: "combined payment proofs are too large (max ~20 MB)" });
      }
      paymentProofs = cleaned;
    }

    const feeNotes = b.feeNotes !== undefined
      ? (b.feeNotes ? String(b.feeNotes).trim().slice(0, 2000) : null)
      : undefined;

    const sets: ReturnType<typeof sql>[] = [];
    if (feeQuoted     !== undefined) sets.push(sql`fee_quoted     = ${feeQuoted}`);
    if (feePaid       !== undefined) sets.push(sql`fee_paid       = ${feePaid}`);
    if (dueDate       !== undefined) sets.push(sql`due_date       = ${dueDate}`);
    if (paymentStatus !== undefined) sets.push(sql`payment_status = ${paymentStatus}`);
    if (paymentProofs !== undefined) {
      // Postgres text[] literal — build safely element by element.
      const arrExpr = paymentProofs.length === 0
        ? sql`ARRAY[]::text[]`
        : sql`ARRAY[${sql.join(paymentProofs.map((p) => sql`${p}`), sql`, `)}]::text[]`;
      sets.push(sql`payment_proofs = ${arrExpr}`);
      // Mirror the first entry into the legacy singular column so old readers
      // keep working. Null when the array is empty.
      sets.push(sql`payment_proof_url = ${paymentProofs[0] ?? null}`);
    }
    if (feeNotes      !== undefined) sets.push(sql`fee_notes      = ${feeNotes}`);

    if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });

    const outcome = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);

      // Only learners can have their ledger edited via this route.
      const isLearner = await db.execute(sql`
        SELECT 1 FROM party_role
        WHERE party_id = ${partyId} AND role = 'learner' AND valid_to IS NULL LIMIT 1
      `);
      if (isLearner.rows.length === 0) return null;

      // The fee ledger lives on the enrolment (post-0077). A learner has one
      // enrolment; target the active one if several ever exist.
      const enrolR = await db.execute(sql`
        SELECT id FROM enrolment WHERE party_id = ${partyId}
        ORDER BY (status = 'active') DESC, created_at DESC LIMIT 1
      `);
      const enrolmentId = (enrolR.rows[0] as { id: string } | undefined)?.id;
      if (!enrolmentId) return null;

      // Snapshot BEFORE so we can produce a diff for the timeline.
      const beforeR = await db.execute(sql`
        SELECT
          fee_quoted     AS "feeQuoted",
          fee_paid       AS "feePaid",
          due_date       AS "dueDate",
          payment_status AS "paymentStatus",
          payment_proofs AS "paymentProofs",
          fee_notes      AS "feeNotes"
        FROM enrolment WHERE id = ${enrolmentId}
      `);
      type LedgerRow = {
        feeQuoted: string | null; feePaid: string | null; dueDate: string | null;
        paymentStatus: string | null; paymentProofs: string[] | null; feeNotes: string | null;
      };
      const before = beforeR.rows[0] as LedgerRow | undefined;

      const setClause = sql.join(sets, sql`, `);
      const r = await db.execute(sql`
        UPDATE enrolment SET ${setClause}
        WHERE id = ${enrolmentId}
        RETURNING
          fee_quoted        AS "feeQuoted",
          fee_paid          AS "feePaid",
          due_date          AS "dueDate",
          payment_status    AS "paymentStatus",
          payment_proof_url AS "paymentProofUrl",
          payment_proofs    AS "paymentProofs",
          fee_notes         AS "feeNotes"
      `);
      const after = r.rows[0] as (LedgerRow & { paymentProofUrl: string | null }) | undefined;
      if (!after) return null;

      // Build a compact diff string, skipping any incoming field whose value
      // didn't actually change (client may send unchanged values).
      const changes: string[] = [];
      const dueDateStr = (v: string | null): string | null => {
        if (!v) return null;
        // Postgres date columns come back as ISO Date objects in pg-node.
        return typeof v === "string" ? v.slice(0, 10) : new Date(v as unknown as string).toISOString().slice(0, 10);
      };
      const proofsEqual = (a: string[] | null, b: string[] | null): boolean => {
        const aa = a ?? []; const bb = b ?? [];
        if (aa.length !== bb.length) return false;
        for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
        return true;
      };
      for (const key of ["feeQuoted","feePaid","dueDate","paymentStatus","paymentProofs","feeNotes"] as const) {
        if (key === "paymentProofs") {
          if (proofsEqual(before?.paymentProofs ?? null, after.paymentProofs ?? null)) continue;
          const bLen = (before?.paymentProofs ?? []).length;
          const aLen = (after.paymentProofs   ?? []).length;
          changes.push(`${FEE_FIELD_LABEL[key]}: ${fmtFeeValue(key, bLen)} → ${fmtFeeValue(key, aLen)}`);
          continue;
        }
        const bv = key === "dueDate" ? dueDateStr(before?.[key] ?? null) : (before?.[key] ?? null);
        const av = key === "dueDate" ? dueDateStr(after[key]    ?? null) : (after[key]    ?? null);
        if (bv === av) continue;
        changes.push(`${FEE_FIELD_LABEL[key]}: ${fmtFeeValue(key, bv)} → ${fmtFeeValue(key, av)}`);
      }

      if (changes.length > 0) {
        const actorName = req.user?.name?.trim() || "You";
        const detail = `Updated fee ledger — ${changes.join("; ")}.`;
        await db.execute(sql`
          INSERT INTO activity (tenant_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
          VALUES (current_tenant(), ${partyId}, 'user', ${actorPartyId}, ${actorName}, 'Fee ledger updated',
                  ${detail}, 'you',
                  ${JSON.stringify({ when: "Just now", quote: null, changes })}::jsonb, NOW())
        `);
      }

      return after;
    });

    if (!outcome) return res.status(404).json({ error: "learner not found" });
    res.json({ ok: true, fee: outcome });
  } catch (err) {
    next(err);
  }
});
