// LMS administration — mounted at /lms-admin behind lms.content.manage.
//
// Deliberately NOT gated on admin.batches.manage. That permission surfaces
// the whole CRM Batches module in the sidebar, so an LMS admin would suddenly
// see CRM screens. Here they get batch *read* + status/join-url writes and
// nothing else; creating and deleting batches stays CRM-side.
//
// Grading is separately gated on lms.grade, so you can hire someone to build
// content without letting them change marks.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { requirePermission } from "../middleware/require.js";
import { partyIdFromAppUserId } from "../lib/party/resolve.js";

export const lmsAdminRouter = Router();

const RESOURCE_KINDS = ["video", "recording", "document", "note", "link"] as const;
const COURSEWORK_TYPES = ["lab", "assignment", "assessment"] as const;
const BATCH_STATUSES = ["upcoming", "running", "completed", "cancelled"] as const;

/** Trim to a string, or null when blank — so "" never lands in a NOT NULL. */
const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  return s === "" ? null : s;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ─── GET /lms-admin/batches ──────────────────────────────────────────────
// Every batch, with how much content it already has. `?q=` filters by name
// or code so this stays usable once there are hundreds.

lmsAdminRouter.get("/batches", async (req, res, next) => {
  try {
    const q = str(req.query.q);
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          c.id, c.name, c.code, c.status, c.start_date AS "startDate",
          c.end_date AS "endDate", c.join_url AS "joinUrl",
          co.name AS "courseName", tp.name AS "trainerName",
          (SELECT count(*)::int FROM module m WHERE m.cohort_id = c.id)     AS "moduleCount",
          (SELECT count(*)::int FROM module m
             WHERE m.cohort_id = c.id AND m.status='published')             AS "publishedCount",
          (SELECT count(*)::int FROM batch_assignment ba
             WHERE ba.cohort_id = c.id AND ba.status='active')              AS "learnerCount"
        FROM cohort c
        LEFT JOIN course co ON co.id = c.course_id
        LEFT JOIN party  tp ON tp.id = c.trainer_id
        WHERE ${q ? sql`(c.name ILIKE ${'%' + q + '%'} OR c.code ILIKE ${'%' + q + '%'})` : sql`true`}
        ORDER BY c.status, c.start_date DESC NULLS LAST, c.name
      `);
      return r.rows;
    });
    res.json({ batches: rows });
  } catch (err) { next(err); }
});

// ─── PATCH /lms-admin/batches/:id ────────────────────────────────────────
// Status and join link only. Everything else about a batch — dates, trainer,
// seats — belongs to the CRM Batches module.

lmsAdminRouter.patch("/batches/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const b = req.body ?? {};
    const status = str(b.status);
    if (status && !(BATCH_STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({ error: `status must be one of ${BATCH_STATUSES.join(", ")}` });
    }
    const hasJoin = Object.prototype.hasOwnProperty.call(b, "joinUrl");

    const out = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        UPDATE cohort SET
          status   = COALESCE(${status}, status),
          join_url = ${hasJoin ? sql`${str(b.joinUrl)}` : sql`join_url`}
        WHERE id = ${id}
        RETURNING id, name, status, join_url AS "joinUrl"
      `);
      return r.rows[0] ?? null;
    });
    if (!out) return res.status(404).json({ error: "Batch not found" });
    res.json(out);
  } catch (err) { next(err); }
});

// ─── Modules ─────────────────────────────────────────────────────────────

lmsAdminRouter.get("/batches/:cohortId/modules", async (req, res, next) => {
  try {
    const cohortId = String(req.params.cohortId);
    const out = await withTenant(req.tenantId!, async (db) => {
      const modules = await db.execute(sql`
        SELECT m.id, m.rank, m.title, m.summary, m.status, m.enabled,
               (SELECT count(*)::int FROM module_resource r WHERE r.module_id = m.id) AS "resourceCount",
               (SELECT count(*)::int FROM coursework cw WHERE cw.module_id = m.id)    AS "courseworkCount"
        FROM module m
        WHERE m.cohort_id = ${cohortId}
        ORDER BY m.rank, m.title
      `);
      const resources = await db.execute(sql`
        SELECT mr.id, mr.module_id AS "moduleId", mr.rank, mr.title, mr.kind,
               mr.video_provider AS "videoProvider", mr.video_ref AS "videoRef",
               mr.duration_seconds AS "durationSeconds", mr.body,
               mr.media_asset_id AS "mediaAssetId", mr.external_url AS "externalUrl",
               mr.batch_session_id AS "batchSessionId", mr.required, mr.enabled
        FROM module_resource mr
        JOIN module m ON m.id = mr.module_id
        WHERE m.cohort_id = ${cohortId}
        ORDER BY m.rank, mr.rank, mr.title
      `);
      const coursework = await db.execute(sql`
        SELECT cw.id, cw.module_id AS "moduleId", cw.rank, cw.type, cw.title, cw.brief,
               cw.max_score AS "maxScore", cw.pass_score AS "passScore", cw.grading,
               cw.opens_at AS "opensAt", cw.due_at AS "dueAt", cw.closes_at AS "closesAt",
               cw.enabled,
               (SELECT count(*)::int FROM submission s
                  WHERE s.coursework_id = cw.id AND s.status IN ('submitted','late')) AS "awaitingGrading"
        FROM coursework cw
        JOIN module m ON m.id = cw.module_id
        WHERE m.cohort_id = ${cohortId}
        ORDER BY m.rank, cw.rank
      `);
      return { modules: modules.rows, resources: resources.rows, coursework: coursework.rows };
    });
    res.json(out);
  } catch (err) { next(err); }
});

lmsAdminRouter.post("/batches/:cohortId/modules", async (req, res, next) => {
  try {
    const cohortId = String(req.params.cohortId);
    const title = str(req.body?.title);
    if (!title) return res.status(400).json({ error: "title is required" });

    const out = await withTenant(req.tenantId!, async (db) => {
      const exists = await db.execute(sql`SELECT id FROM cohort WHERE id = ${cohortId}`);
      if (!exists.rows[0]) return null;
      const r = await db.execute(sql`
        INSERT INTO module (tenant_id, cohort_id, rank, title, summary, status)
        VALUES (
          current_tenant(), ${cohortId},
          -- append to the end unless the caller pins a rank
          ${num(req.body?.rank) ?? sql`(SELECT COALESCE(max(rank),0)+1 FROM module WHERE cohort_id = ${cohortId})`},
          ${title}, ${str(req.body?.summary)},
          ${str(req.body?.status) ?? "draft"}
        )
        RETURNING id, rank, title, summary, status, enabled
      `);
      return r.rows[0];
    });
    if (!out) return res.status(404).json({ error: "Batch not found" });
    res.status(201).json(out);
  } catch (err) { next(err); }
});

lmsAdminRouter.patch("/modules/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const b = req.body ?? {};
    const status = str(b.status);
    if (status && !["draft", "published"].includes(status)) {
      return res.status(400).json({ error: "status must be draft or published" });
    }
    const out = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        UPDATE module SET
          title   = COALESCE(${str(b.title)}, title),
          summary = ${Object.prototype.hasOwnProperty.call(b, "summary") ? sql`${str(b.summary)}` : sql`summary`},
          status  = COALESCE(${status}, status),
          rank    = COALESCE(${num(b.rank)}, rank),
          enabled = COALESCE(${typeof b.enabled === "boolean" ? b.enabled : null}, enabled),
          updated_at = now()
        WHERE id = ${id}
        RETURNING id, rank, title, summary, status, enabled
      `);
      return r.rows[0] ?? null;
    });
    if (!out) return res.status(404).json({ error: "Module not found" });
    res.json(out);
  } catch (err) { next(err); }
});

lmsAdminRouter.delete("/modules/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    // Cascades to resources, coursework and submissions. Refuse once anyone
    // has submitted — deleting graded work by accident is unrecoverable.
    const out = await withTenant(req.tenantId!, async (db) => {
      const used = await db.execute(sql`
        SELECT count(*)::int AS n FROM submission s
        JOIN coursework cw ON cw.id = s.coursework_id
        WHERE cw.module_id = ${id}
      `);
      if (Number((used.rows[0] as { n: number }).n) > 0) return "in_use" as const;
      const r = await db.execute(sql`DELETE FROM module WHERE id = ${id} RETURNING id`);
      return r.rows[0] ? "deleted" as const : null;
    });
    if (out === "in_use") {
      return res.status(409).json({ error: "This module has submissions. Disable it instead of deleting." });
    }
    if (!out) return res.status(404).json({ error: "Module not found" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Resources ───────────────────────────────────────────────────────────
// The payload CHECK in post-0083 is the real guarantee; these 400s exist so
// the admin UI gets a readable message instead of a constraint violation.

lmsAdminRouter.post("/modules/:moduleId/resources", async (req, res, next) => {
  try {
    const moduleId = String(req.params.moduleId);
    const b = req.body ?? {};
    const kind = str(b.kind);
    const title = str(b.title);
    if (!title) return res.status(400).json({ error: "title is required" });
    if (!kind || !(RESOURCE_KINDS as readonly string[]).includes(kind)) {
      return res.status(400).json({ error: `kind must be one of ${RESOURCE_KINDS.join(", ")}` });
    }
    const videoRef = str(b.videoRef);
    const body = str(b.body);
    const externalUrl = str(b.externalUrl);
    const mediaAssetId = str(b.mediaAssetId);
    if ((kind === "video" || kind === "recording") && !videoRef) {
      return res.status(400).json({ error: "videoRef is required for video and recording" });
    }
    if (kind === "note" && !body) return res.status(400).json({ error: "body is required for note" });
    if (kind === "link" && !externalUrl) return res.status(400).json({ error: "externalUrl is required for link" });
    if (kind === "document" && !mediaAssetId) {
      return res.status(400).json({ error: "mediaAssetId is required for document" });
    }

    const out = await withTenant(req.tenantId!, async (db) => {
      const exists = await db.execute(sql`SELECT id FROM module WHERE id = ${moduleId}`);
      if (!exists.rows[0]) return null;
      const r = await db.execute(sql`
        INSERT INTO module_resource
          (tenant_id, module_id, rank, title, kind, video_provider, video_ref,
           duration_seconds, batch_session_id, body, media_asset_id, external_url, required)
        VALUES (
          current_tenant(), ${moduleId},
          ${num(b.rank) ?? sql`(SELECT COALESCE(max(rank),0)+1 FROM module_resource WHERE module_id = ${moduleId})`},
          ${title}, ${kind},
          ${videoRef ? (str(b.videoProvider) ?? "vimeo") : null},
          ${videoRef}, ${num(b.durationSeconds)}, ${str(b.batchSessionId)},
          ${body}, ${mediaAssetId}, ${externalUrl},
          ${typeof b.required === "boolean" ? b.required : true}
        )
        RETURNING id, rank, title, kind, video_ref AS "videoRef",
                  duration_seconds AS "durationSeconds", required
      `);
      return r.rows[0];
    });
    if (!out) return res.status(404).json({ error: "Module not found" });
    res.status(201).json(out);
  } catch (err) { next(err); }
});

lmsAdminRouter.patch("/resources/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const b = req.body ?? {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
    const out = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        UPDATE module_resource SET
          title            = COALESCE(${str(b.title)}, title),
          rank             = COALESCE(${num(b.rank)}, rank),
          video_ref        = ${has("videoRef") ? sql`${str(b.videoRef)}` : sql`video_ref`},
          duration_seconds = ${has("durationSeconds") ? sql`${num(b.durationSeconds)}` : sql`duration_seconds`},
          body             = ${has("body") ? sql`${str(b.body)}` : sql`body`},
          external_url     = ${has("externalUrl") ? sql`${str(b.externalUrl)}` : sql`external_url`},
          required         = COALESCE(${typeof b.required === "boolean" ? b.required : null}, required),
          enabled          = COALESCE(${typeof b.enabled === "boolean" ? b.enabled : null}, enabled),
          updated_at       = now()
        WHERE id = ${id}
        RETURNING id, rank, title, kind, video_ref AS "videoRef",
                  duration_seconds AS "durationSeconds", required, enabled
      `);
      return r.rows[0] ?? null;
    });
    if (!out) return res.status(404).json({ error: "Resource not found" });
    res.json(out);
  } catch (err) { next(err); }
});

lmsAdminRouter.delete("/resources/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const out = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`DELETE FROM module_resource WHERE id = ${id} RETURNING id`);
      return r.rows[0] ?? null;
    });
    if (!out) return res.status(404).json({ error: "Resource not found" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Coursework ──────────────────────────────────────────────────────────

lmsAdminRouter.post("/modules/:moduleId/coursework", async (req, res, next) => {
  try {
    const moduleId = String(req.params.moduleId);
    const b = req.body ?? {};
    const type = str(b.type);
    const title = str(b.title);
    if (!title) return res.status(400).json({ error: "title is required" });
    if (!type || !(COURSEWORK_TYPES as readonly string[]).includes(type)) {
      return res.status(400).json({ error: `type must be one of ${COURSEWORK_TYPES.join(", ")}` });
    }
    const grading = str(b.grading) ?? "trainer";
    if (!["trainer", "auto"].includes(grading)) {
      return res.status(400).json({ error: "grading must be trainer or auto" });
    }

    const out = await withTenant(req.tenantId!, async (db) => {
      const exists = await db.execute(sql`SELECT id FROM module WHERE id = ${moduleId}`);
      if (!exists.rows[0]) return null;
      const r = await db.execute(sql`
        INSERT INTO coursework
          (tenant_id, module_id, rank, type, title, brief, max_score, pass_score,
           grading, opens_at, due_at, closes_at)
        VALUES (
          current_tenant(), ${moduleId},
          ${num(b.rank) ?? sql`(SELECT COALESCE(max(rank),0)+1 FROM coursework WHERE module_id = ${moduleId})`},
          ${type}, ${title}, ${str(b.brief)}, ${num(b.maxScore)}, ${num(b.passScore)},
          ${grading}, ${str(b.opensAt)}, ${str(b.dueAt)}, ${str(b.closesAt)}
        )
        RETURNING id, rank, type, title, max_score AS "maxScore", due_at AS "dueAt"
      `);
      return r.rows[0];
    });
    if (!out) return res.status(404).json({ error: "Module not found" });
    res.status(201).json(out);
  } catch (err) { next(err); }
});

lmsAdminRouter.patch("/coursework/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const b = req.body ?? {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
    const out = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        UPDATE coursework SET
          title      = COALESCE(${str(b.title)}, title),
          brief      = ${has("brief") ? sql`${str(b.brief)}` : sql`brief`},
          rank       = COALESCE(${num(b.rank)}, rank),
          max_score  = ${has("maxScore") ? sql`${num(b.maxScore)}` : sql`max_score`},
          pass_score = ${has("passScore") ? sql`${num(b.passScore)}` : sql`pass_score`},
          opens_at   = ${has("opensAt") ? sql`${str(b.opensAt)}::timestamptz` : sql`opens_at`},
          due_at     = ${has("dueAt") ? sql`${str(b.dueAt)}::timestamptz` : sql`due_at`},
          closes_at  = ${has("closesAt") ? sql`${str(b.closesAt)}::timestamptz` : sql`closes_at`},
          enabled    = COALESCE(${typeof b.enabled === "boolean" ? b.enabled : null}, enabled),
          updated_at = now()
        WHERE id = ${id}
        RETURNING id, rank, type, title, max_score AS "maxScore", due_at AS "dueAt", enabled
      `);
      return r.rows[0] ?? null;
    });
    if (!out) return res.status(404).json({ error: "Coursework not found" });
    res.json(out);
  } catch (err) { next(err); }
});

lmsAdminRouter.delete("/coursework/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const out = await withTenant(req.tenantId!, async (db) => {
      const used = await db.execute(sql`
        SELECT count(*)::int AS n FROM submission WHERE coursework_id = ${id}
      `);
      if (Number((used.rows[0] as { n: number }).n) > 0) return "in_use" as const;
      const r = await db.execute(sql`DELETE FROM coursework WHERE id = ${id} RETURNING id`);
      return r.rows[0] ? "deleted" as const : null;
    });
    if (out === "in_use") {
      return res.status(409).json({ error: "This has submissions. Disable it instead of deleting." });
    }
    if (!out) return res.status(404).json({ error: "Coursework not found" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Grading ─────────────────────────────────────────────────────────────

lmsAdminRouter.get("/coursework/:id/submissions", requirePermission("lms.grade"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT s.id, s.attempt, s.status, s.submitted_at AS "submittedAt",
               s.content, s.score, s.feedback, s.graded_at AS "gradedAt",
               p.id AS "partyId", p.name AS "learnerName", p.email AS "learnerEmail",
               lp.number AS "learnerNumber"
        FROM submission s
        JOIN party p ON p.id = s.party_id
        LEFT JOIN learner_profile lp ON lp.party_id = p.id
        WHERE s.coursework_id = ${id}
        ORDER BY s.status, p.name NULLS LAST
      `);
      return r.rows;
    });
    res.json({ submissions: rows });
  } catch (err) { next(err); }
});

// PATCH a grade. score is validated against the coursework's max_score —
// a typo'd 900 out of 100 would otherwise skew every average on the
// learner's My work page.

lmsAdminRouter.patch("/submissions/:id", requirePermission("lms.grade"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const b = req.body ?? {};
    const score = num(b.score);
    const status = str(b.status) ?? "graded";
    if (!["graded", "returned"].includes(status)) {
      return res.status(400).json({ error: "status must be graded or returned" });
    }
    if (status === "graded" && score === null) {
      return res.status(400).json({ error: "score is required when marking graded" });
    }

    const out = await withTenant(req.tenantId!, async (db) => {
      const graderPartyId = await partyIdFromAppUserId(db, req.userId!);
      const cw = await db.execute(sql`
        SELECT cw.max_score FROM submission s
        JOIN coursework cw ON cw.id = s.coursework_id
        WHERE s.id = ${id}
      `);
      const row = cw.rows[0] as { max_score: string | null } | undefined;
      if (!row) return { code: 404 as const };
      const max = row.max_score === null ? null : Number(row.max_score);
      if (score !== null && score < 0) return { code: 400 as const, error: "score cannot be negative" };
      if (score !== null && max !== null && score > max) {
        return { code: 400 as const, error: `score cannot exceed the maximum of ${max}` };
      }
      const r = await db.execute(sql`
        UPDATE submission SET
          score     = ${score},
          feedback  = ${str(b.feedback)},
          status    = ${status},
          graded_by = ${graderPartyId},
          graded_at = now(),
          updated_at = now()
        WHERE id = ${id}
        RETURNING id, status, score, feedback, graded_at AS "gradedAt"
      `);
      return { code: 200 as const, submission: r.rows[0] };
    });
    if (out.code === 404) return res.status(404).json({ error: "Submission not found" });
    if (out.code === 400) return res.status(400).json({ error: out.error });
    res.json(out.submission);
  } catch (err) { next(err); }
});

// ─── POST /lms-admin/batches/:cohortId/copy-from/:sourceCohortId ─────────
// Modules live on the batch, so re-running a course means rebuilding its
// content. This clones structure — modules, resources and coursework — from
// a previous batch. Progress and submissions are per learner and are never
// copied. Due dates come across as NULL: they were relative to the old
// batch's calendar and silently importing them would be worse than blank.

lmsAdminRouter.post("/batches/:cohortId/copy-from/:sourceCohortId", async (req, res, next) => {
  try {
    const target = String(req.params.cohortId);
    const source = String(req.params.sourceCohortId);
    if (target === source) return res.status(400).json({ error: "Source and target are the same batch" });

    const out = await withTenant(req.tenantId!, async (db) => {
      const both = await db.execute(sql`
        SELECT count(*)::int AS n FROM cohort WHERE id IN (${target}, ${source})
      `);
      if (Number((both.rows[0] as { n: number }).n) !== 2) return null;

      const existing = await db.execute(sql`
        SELECT count(*)::int AS n FROM module WHERE cohort_id = ${target}
      `);
      if (Number((existing.rows[0] as { n: number }).n) > 0) return "not_empty" as const;

      // Copy modules, keeping a source→new id map so children can be rehomed.
      const mods = await db.execute(sql`
        INSERT INTO module (tenant_id, cohort_id, rank, title, summary, status, enabled)
        SELECT current_tenant(), ${target}, m.rank, m.title, m.summary, 'draft', m.enabled
        FROM module m WHERE m.cohort_id = ${source}
        ORDER BY m.rank
        RETURNING id, rank, title
      `);
      // Match on (rank, title) — unique enough within one batch, and avoids
      // a round trip per module.
      await db.execute(sql`
        INSERT INTO module_resource
          (tenant_id, module_id, rank, title, kind, video_provider, video_ref,
           duration_seconds, body, media_asset_id, external_url, required, enabled)
        SELECT current_tenant(), nm.id, mr.rank, mr.title, mr.kind, mr.video_provider,
               mr.video_ref, mr.duration_seconds, mr.body, mr.media_asset_id,
               mr.external_url, mr.required, mr.enabled
        FROM module_resource mr
        JOIN module om ON om.id = mr.module_id AND om.cohort_id = ${source}
        JOIN module nm ON nm.cohort_id = ${target} AND nm.rank = om.rank AND nm.title = om.title
        -- batch_session_id is deliberately NOT copied: a recording belongs to
        -- the class that produced it, and that class was another batch's.
      `);
      await db.execute(sql`
        INSERT INTO coursework
          (tenant_id, module_id, rank, type, title, brief, max_score, pass_score,
           grading, enabled)
        SELECT current_tenant(), nm.id, cw.rank, cw.type, cw.title, cw.brief,
               cw.max_score, cw.pass_score, cw.grading, cw.enabled
        FROM coursework cw
        JOIN module om ON om.id = cw.module_id AND om.cohort_id = ${source}
        JOIN module nm ON nm.cohort_id = ${target} AND nm.rank = om.rank AND nm.title = om.title
      `);
      return { modules: mods.rows.length } as const;
    });

    if (out === null) return res.status(404).json({ error: "Batch not found" });
    if (out === "not_empty") {
      return res.status(409).json({ error: "The target batch already has modules. Clear them first." });
    }
    res.json({ ok: true, modulesCopied: out.modules, note: "Copied as draft. Set due dates, then publish." });
  } catch (err) { next(err); }
});
