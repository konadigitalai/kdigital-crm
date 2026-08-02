// Staffing — /requisitions, /candidates, /applications.
//
// The last stretch of the Academy's stated end-to-end: a learner who is
// employable gets placed. Three routers, one file, because they are only
// meaningful together.
//
// The gate is NOT re-implemented here. A learner may be put forward only when
// learner_profile says they are both `qualified` and have `granted` consent —
// two facts about the LEARNER, so that withdrawing consent removes them from
// staffing however many applications are open. That rule lives in the
// `candidate_eligible` view (post-0091) and this router reads it rather than
// restating the predicate, so there is exactly one place to change it.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

export const requisitionsRouter = Router();
export const candidatesRouter   = Router();
export const applicationsRouter = Router();

const UUID = /^[0-9a-fA-F-]{36}$/;

const REQ_STATUSES   = ["draft", "open", "on_hold", "filled", "cancelled", "closed"] as const;
const WORK_MODES     = ["onsite", "remote", "hybrid"] as const;
const EMPLOYMENT     = ["full_time", "part_time", "contract", "intern"] as const;
const APPROVAL       = ["not_required", "pending", "approved", "rejected"] as const;
const CAND_STATUSES  = ["draft", "ready", "active", "placed", "withdrawn"] as const;
const APP_STAGES     = ["applied", "screening", "shortlisted", "interviewing", "offered", "hired", "rejected", "withdrawn"] as const;
const INTERVIEW      = ["not_scheduled", "scheduled", "completed", "no_show", "cancelled"] as const;
const OFFER          = ["none", "extended", "accepted", "declined", "withdrawn"] as const;

// Stages that end the application. Moving into one is gated on
// staffing.decide, not staffing.write — see index.ts.
const TERMINAL_STAGES = ["hired", "rejected", "withdrawn"] as const;

function pickEnum<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  if (!(allowed as readonly string[]).includes(s)) {
    throw Object.assign(new Error(`${field} must be one of: ${allowed.join(", ")}`), { code: "BAD_ENUM" });
  }
  return s as T[number];
}

function normaliseList(input: unknown): string[] | undefined {
  if (input === undefined) return undefined;
  if (input === null) return [];
  const raw = Array.isArray(input) ? input : String(input).split(",");
  const out: string[] = [];
  for (const item of raw) {
    const s = String(item ?? "").trim();
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

// ═══ Requisitions ═════════════════════════════════════════════════════════

const REQ_SELECT = sql`
  SELECT
    r.id, r.number,
    r.account_party_id AS "accountPartyId",
    acc.name           AS "accountName",
    r.job_title AS "jobTitle", r.designation, r.department,
    r.job_description AS "jobDescription",
    r.key_responsibilities AS "keyResponsibilities",
    r.openings,
    r.employment_type AS "employmentType",
    r.work_location   AS "workLocation",
    r.work_mode       AS "workMode",
    r.minimum_experience_months AS "minimumExperienceMonths",
    r.maximum_experience_months AS "maximumExperienceMonths",
    r.required_qualification AS "requiredQualification",
    r.required_skills  AS "requiredSkills",
    r.preferred_skills AS "preferredSkills",
    r.languages,
    r.salary_min AS "salaryMin", r.salary_max AS "salaryMax", r.currency,
    r.budget_approved AS "budgetApproved",
    r.hiring_manager_party_id AS "hiringManagerPartyId", hm.name AS "hiringManagerName",
    r.recruiter_party_id      AS "recruiterPartyId",     rc.name AS "recruiterName",
    r.approval_status AS "approvalStatus",
    r.approved_at     AS "approvedAt",
    r.priority, r.target_close_date AS "targetCloseDate", r.status,
    r.created_at AS "createdAt", r.updated_at AS "updatedAt",
    (SELECT COUNT(*)::int FROM application a WHERE a.requisition_id = r.id)                       AS "applicationCount",
    (SELECT COUNT(*)::int FROM application a WHERE a.requisition_id = r.id AND a.stage = 'hired') AS "hiredCount",
    -- What the board actually needs: openings still to fill.
    GREATEST(0, r.openings - (SELECT COUNT(*)::int FROM application a
       WHERE a.requisition_id = r.id AND a.stage = 'hired'))                                      AS "openSeats"
  FROM requisition r
  JOIN party acc ON acc.id = r.account_party_id
  LEFT JOIN party hm ON hm.id = r.hiring_manager_party_id
  LEFT JOIN party rc ON rc.id = r.recruiter_party_id
`;

requisitionsRouter.get("/", async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "").trim();
    const status = String(req.query.status ?? "").trim();
    const accountId = String(req.query.accountId ?? "").trim();
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        ${REQ_SELECT}
        WHERE ${status ? sql`r.status = ${status}` : sql`r.status NOT IN ('cancelled','closed')`}
          AND ${accountId && UUID.test(accountId) ? sql`r.account_party_id = ${accountId}` : sql`true`}
          AND ${q ? sql`(r.job_title ILIKE ${"%" + q + "%"} OR r.number ILIKE ${"%" + q + "%"} OR acc.name ILIKE ${"%" + q + "%"})` : sql`true`}
        ORDER BY r.priority, r.target_close_date NULLS LAST, r.created_at DESC
      `);
      return r.rows;
    });
    res.json({ requisitions: rows });
  } catch (err) { next(err); }
});

requisitionsRouter.get("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ error: "invalid id" });
    const found = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`${REQ_SELECT} WHERE r.id = ${id}`);
      if (!r.rows[0]) return null;
      const apps = await db.execute(sql`
        SELECT a.id, a.number, a.stage, a.screening_score AS "screeningScore",
               a.applied_at AS "appliedAt", a.candidate_party_id AS "candidatePartyId",
               p.name AS "candidateName", c.number AS "candidateNumber"
          FROM application a
          JOIN candidate c ON c.party_id = a.candidate_party_id
          JOIN party p     ON p.id = a.candidate_party_id
         WHERE a.requisition_id = ${id}
         ORDER BY a.screening_score DESC NULLS LAST, a.applied_at
      `);
      return { ...(r.rows[0] as object), applications: apps.rows };
    });
    if (!found) return res.status(404).json({ error: "requisition not found" });
    res.json({ requisition: found });
  } catch (err) { next(err); }
});

requisitionsRouter.post("/", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const jobTitle = String(b.jobTitle ?? "").trim();
    const accountPartyId = b.accountPartyId ? String(b.accountPartyId).trim() : null;
    if (!jobTitle) return res.status(400).json({ error: "jobTitle is required" });
    if (!accountPartyId || !UUID.test(accountPartyId)) {
      return res.status(400).json({ error: "accountPartyId is required" });
    }

    let status, workMode, employmentType, approvalStatus;
    try {
      status         = pickEnum(b.status, REQ_STATUSES, "status") ?? "draft";
      workMode       = pickEnum(b.workMode, WORK_MODES, "workMode");
      employmentType = pickEnum(b.employmentType, EMPLOYMENT, "employmentType");
      approvalStatus = pickEnum(b.approvalStatus, APPROVAL, "approvalStatus") ?? "not_required";
    } catch (err) { return res.status(400).json({ error: (err as Error).message }); }

    const openings = b.openings != null && b.openings !== "" ? Number(b.openings) : 1;
    if (!Number.isInteger(openings) || openings < 1) {
      return res.status(400).json({ error: "openings must be a positive integer" });
    }

    const created = await withTenant(req.tenantId!, async (db) => {
      const acc = await db.execute(sql`SELECT party_id FROM account WHERE party_id = ${accountPartyId}`);
      if (!acc.rows[0]) throw Object.assign(new Error("no account"), { code: "NO_ACCOUNT" });

      const r = await db.execute(sql`
        INSERT INTO requisition (
          tenant_id, account_party_id, job_title, designation, department,
          job_description, key_responsibilities, openings, employment_type,
          work_location, work_mode, minimum_experience_months, maximum_experience_months,
          required_qualification, required_skills, preferred_skills, languages,
          salary_min, salary_max, currency, budget_approved,
          hiring_manager_party_id, recruiter_party_id, approval_status,
          priority, target_close_date, status
        ) VALUES (
          current_tenant(), ${accountPartyId}, ${jobTitle},
          ${b.designation ? String(b.designation).trim() : null},
          ${b.department  ? String(b.department).trim()  : null},
          ${b.jobDescription ? String(b.jobDescription).trim() : null},
          ${b.keyResponsibilities ? String(b.keyResponsibilities).trim() : null},
          ${openings}, ${employmentType},
          ${b.workLocation ? String(b.workLocation).trim() : null}, ${workMode},
          ${b.minimumExperienceMonths != null && b.minimumExperienceMonths !== "" ? Number(b.minimumExperienceMonths) : null},
          ${b.maximumExperienceMonths != null && b.maximumExperienceMonths !== "" ? Number(b.maximumExperienceMonths) : null},
          ${b.requiredQualification ? String(b.requiredQualification).trim() : null},
          ${normaliseList(b.requiredSkills)  ?? []},
          ${normaliseList(b.preferredSkills) ?? []},
          ${normaliseList(b.languages)       ?? []},
          ${b.salaryMin != null && b.salaryMin !== "" ? String(b.salaryMin) : null},
          ${b.salaryMax != null && b.salaryMax !== "" ? String(b.salaryMax) : null},
          ${b.currency ? String(b.currency).trim() : "INR"},
          ${Boolean(b.budgetApproved)},
          ${b.hiringManagerPartyId && UUID.test(String(b.hiringManagerPartyId)) ? String(b.hiringManagerPartyId) : null},
          ${b.recruiterPartyId && UUID.test(String(b.recruiterPartyId)) ? String(b.recruiterPartyId) : null},
          ${approvalStatus},
          ${b.priority != null ? Number(b.priority) : 3},
          ${b.targetCloseDate || null}, ${status}
        )
        RETURNING id
      `);
      const id = (r.rows[0] as { id: string }).id;
      const detail = await db.execute(sql`${REQ_SELECT} WHERE r.id = ${id}`);
      return detail.rows[0];
    });

    res.status(201).json({ requisition: created });
  } catch (err) {
    if ((err as { code?: string }).code === "NO_ACCOUNT") {
      return res.status(400).json({ error: "account not found" });
    }
    next(err);
  }
});

requisitionsRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ error: "invalid id" });
    const b = req.body ?? {};

    const sets: ReturnType<typeof sql>[] = [];
    try {
      if (b.status         !== undefined) sets.push(sql`status = ${pickEnum(b.status, REQ_STATUSES, "status")}`);
      if (b.workMode       !== undefined) sets.push(sql`work_mode = ${pickEnum(b.workMode, WORK_MODES, "workMode")}`);
      if (b.employmentType !== undefined) sets.push(sql`employment_type = ${pickEnum(b.employmentType, EMPLOYMENT, "employmentType")}`);
    } catch (err) { return res.status(400).json({ error: (err as Error).message }); }

    if (b.jobTitle !== undefined) {
      const t = String(b.jobTitle).trim();
      if (!t) return res.status(400).json({ error: "jobTitle cannot be empty" });
      sets.push(sql`job_title = ${t}`);
    }
    if (b.designation !== undefined) sets.push(sql`designation = ${b.designation ? String(b.designation).trim() : null}`);
    if (b.department  !== undefined) sets.push(sql`department  = ${b.department  ? String(b.department).trim()  : null}`);
    if (b.jobDescription      !== undefined) sets.push(sql`job_description = ${b.jobDescription ? String(b.jobDescription).trim() : null}`);
    if (b.keyResponsibilities !== undefined) sets.push(sql`key_responsibilities = ${b.keyResponsibilities ? String(b.keyResponsibilities).trim() : null}`);
    if (b.workLocation !== undefined) sets.push(sql`work_location = ${b.workLocation ? String(b.workLocation).trim() : null}`);
    if (b.requiredQualification !== undefined) sets.push(sql`required_qualification = ${b.requiredQualification ? String(b.requiredQualification).trim() : null}`);
    if (b.targetCloseDate !== undefined) sets.push(sql`target_close_date = ${b.targetCloseDate || null}`);
    if (b.budgetApproved  !== undefined) sets.push(sql`budget_approved = ${Boolean(b.budgetApproved)}`);
    if (b.currency !== undefined) sets.push(sql`currency = ${b.currency ? String(b.currency).trim() : "INR"}`);
    if (b.priority !== undefined) sets.push(sql`priority = ${Number(b.priority)}`);
    if (b.openings !== undefined) {
      const n = Number(b.openings);
      if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "openings must be a positive integer" });
      sets.push(sql`openings = ${n}`);
    }
    for (const [key, col] of [
      ["minimumExperienceMonths", "minimum_experience_months"],
      ["maximumExperienceMonths", "maximum_experience_months"],
    ] as const) {
      if (b[key] !== undefined) {
        sets.push(sql`${sql.raw(col)} = ${b[key] != null && b[key] !== "" ? Number(b[key]) : null}`);
      }
    }
    for (const [key, col] of [["salaryMin", "salary_min"], ["salaryMax", "salary_max"]] as const) {
      if (b[key] !== undefined) {
        sets.push(sql`${sql.raw(col)} = ${b[key] != null && b[key] !== "" ? String(b[key]) : null}`);
      }
    }
    for (const [key, col] of [
      ["requiredSkills", "required_skills"],
      ["preferredSkills", "preferred_skills"],
      ["languages", "languages"],
    ] as const) {
      const list = normaliseList(b[key]);
      if (list !== undefined) sets.push(sql`${sql.raw(col)} = ${list}`);
    }
    for (const [key, col] of [
      ["hiringManagerPartyId", "hiring_manager_party_id"],
      ["recruiterPartyId", "recruiter_party_id"],
    ] as const) {
      if (b[key] !== undefined) {
        const v = b[key] ? String(b[key]).trim() : null;
        if (v && !UUID.test(v)) return res.status(400).json({ error: `invalid ${key}` });
        sets.push(sql`${sql.raw(col)} = ${v}`);
      }
    }

    // Approval carries its evidence: the DB CHECK refuses an 'approved' row
    // with no approver, so the approver is stamped here rather than expected
    // from the client.
    if (b.approvalStatus !== undefined) {
      let approval;
      try { approval = pickEnum(b.approvalStatus, APPROVAL, "approvalStatus"); }
      catch (err) { return res.status(400).json({ error: (err as Error).message }); }
      sets.push(sql`approval_status = ${approval}`);
      if (approval === "approved") {
        // The approver is the signed-in user, resolved through app_user —
        // never taken from the request body, or the audit trail is whatever
        // the client claims it is.
        sets.push(sql`approved_by_party_id = (SELECT party_id FROM app_user WHERE id = ${req.userId ?? null})`);
        sets.push(sql`approved_at = now()`);
      } else {
        sets.push(sql`approved_by_party_id = NULL`);
        sets.push(sql`approved_at = NULL`);
      }
    }

    if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });

    const updated = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        UPDATE requisition SET ${sql.join(sets, sql`, `)} WHERE id = ${id} RETURNING id
      `);
      if (!r.rows[0]) return null;
      const detail = await db.execute(sql`${REQ_SELECT} WHERE r.id = ${id}`);
      return detail.rows[0];
    });

    if (!updated) return res.status(404).json({ error: "requisition not found" });
    res.json({ requisition: updated });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("requisition_approved_evidence_check")) {
      return res.status(400).json({ error: "approving a requisition requires a signed-in approver" });
    }
    next(err);
  }
});

// ═══ Candidates ═══════════════════════════════════════════════════════════

const CAND_SELECT = sql`
  SELECT
    c.party_id AS "partyId", c.number,
    p.name, p.email, p.phone, p.city,
    c.total_experience_months AS "totalExperienceMonths",
    c.current_employer    AS "currentEmployer",
    c.current_designation AS "currentDesignation",
    c.current_ctc  AS "currentCtc",
    c.expected_ctc AS "expectedCtc",
    c.currency,
    c.notice_period_days AS "noticePeriodDays",
    c.skills,
    c.highest_qualification AS "highestQualification",
    c.work_history_summary  AS "workHistorySummary",
    c.certifications,
    c.resume_attachment_id AS "resumeAttachmentId",
    c.portfolio_url        AS "portfolioUrl",
    c.profile_status       AS "profileStatus",
    c.created_at AS "createdAt", c.updated_at AS "updatedAt",
    -- The gate, read from learner_profile — never restated on candidate.
    lp.staffing_eligibility_status AS "eligibilityStatus",
    lp.staffing_consent_status     AS "consentStatus",
    lp.progress_percent            AS "progressPercent",
    lp.placement_status            AS "placementStatus",
    -- Is this candidate actually offerable right now? Derived from the same
    -- two columns the candidate_eligible view uses.
    (lp.staffing_eligibility_status = 'qualified'
     AND lp.staffing_consent_status = 'granted'
     AND c.profile_status IN ('ready','active'))                       AS "eligible",
    (SELECT COUNT(*)::int FROM application a
      WHERE a.candidate_party_id = c.party_id AND a.status = 'open')   AS "openApplicationCount"
  FROM candidate c
  JOIN party p ON p.id = c.party_id
  LEFT JOIN learner_profile lp ON lp.party_id = c.party_id
`;

candidatesRouter.get("/", async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "").trim();
    // ?eligible=1 is what the "add to requisition" picker calls.
    const eligibleOnly = req.query.eligible === "1" || req.query.eligible === "true";
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        ${CAND_SELECT}
        WHERE ${eligibleOnly
          ? sql`c.party_id IN (SELECT party_id FROM candidate_eligible)`
          : sql`true`}
          AND ${q ? sql`(p.name ILIKE ${"%" + q + "%"} OR c.number ILIKE ${"%" + q + "%"}
                      OR EXISTS (SELECT 1 FROM unnest(c.skills) s WHERE s ILIKE ${"%" + q + "%"}))` : sql`true`}
        ORDER BY p.name
      `);
      return r.rows;
    });
    res.json({ candidates: rows });
  } catch (err) { next(err); }
});

candidatesRouter.get("/:partyId", async (req, res, next) => {
  try {
    const partyId = String(req.params.partyId);
    if (!UUID.test(partyId)) return res.status(400).json({ error: "invalid partyId" });
    const found = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`${CAND_SELECT} WHERE c.party_id = ${partyId}`);
      if (!r.rows[0]) return null;
      const apps = await db.execute(sql`
        SELECT a.id, a.number, a.stage, a.applied_at AS "appliedAt",
               a.screening_score AS "screeningScore",
               req.id AS "requisitionId", req.number AS "requisitionNumber",
               req.job_title AS "jobTitle", acc.name AS "accountName"
          FROM application a
          JOIN requisition req ON req.id = a.requisition_id
          JOIN party acc ON acc.id = req.account_party_id
         WHERE a.candidate_party_id = ${partyId}
         ORDER BY a.applied_at DESC
      `);
      return { ...(r.rows[0] as object), applications: apps.rows };
    });
    if (!found) return res.status(404).json({ error: "candidate not found" });
    res.json({ candidate: found });
  } catch (err) { next(err); }
});

// Create a candidate profile for an EXISTING learner. There is no path that
// creates a person here: a candidate is someone the Academy already taught.
candidatesRouter.post("/", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const partyId = b.partyId ? String(b.partyId).trim() : null;
    if (!partyId || !UUID.test(partyId)) {
      return res.status(400).json({ error: "partyId is required — a candidate is an existing learner" });
    }

    let profileStatus;
    try { profileStatus = pickEnum(b.profileStatus, CAND_STATUSES, "profileStatus") ?? "draft"; }
    catch (err) { return res.status(400).json({ error: (err as Error).message }); }

    const created = await withTenant(req.tenantId!, async (db) => {
      const lp = await db.execute(sql`SELECT party_id FROM learner_profile WHERE party_id = ${partyId}`);
      if (!lp.rows[0]) throw Object.assign(new Error("not a learner"), { code: "NOT_LEARNER" });
      const dup = await db.execute(sql`SELECT party_id FROM candidate WHERE party_id = ${partyId}`);
      if (dup.rows[0]) throw Object.assign(new Error("duplicate"), { code: "DUP" });

      await db.execute(sql`
        INSERT INTO candidate (
          tenant_id, party_id, total_experience_months, current_employer, current_designation,
          current_ctc, expected_ctc, currency, notice_period_days, skills,
          highest_qualification, work_history_summary, certifications,
          resume_attachment_id, portfolio_url, profile_status
        ) VALUES (
          current_tenant(), ${partyId},
          ${b.totalExperienceMonths != null && b.totalExperienceMonths !== "" ? Number(b.totalExperienceMonths) : null},
          ${b.currentEmployer    ? String(b.currentEmployer).trim()    : null},
          ${b.currentDesignation ? String(b.currentDesignation).trim() : null},
          ${b.currentCtc  != null && b.currentCtc  !== "" ? String(b.currentCtc)  : null},
          ${b.expectedCtc != null && b.expectedCtc !== "" ? String(b.expectedCtc) : null},
          ${b.currency ? String(b.currency).trim() : "INR"},
          ${b.noticePeriodDays != null && b.noticePeriodDays !== "" ? Number(b.noticePeriodDays) : null},
          ${normaliseList(b.skills) ?? []},
          ${b.highestQualification ? String(b.highestQualification).trim() : null},
          ${b.workHistorySummary   ? String(b.workHistorySummary).trim()   : null},
          ${normaliseList(b.certifications) ?? []},
          ${b.resumeAttachmentId && UUID.test(String(b.resumeAttachmentId)) ? String(b.resumeAttachmentId) : null},
          ${b.portfolioUrl ? String(b.portfolioUrl).trim() : null},
          ${profileStatus}
        )
      `);

      await db.execute(sql`
        INSERT INTO party_role (tenant_id, party_id, role, valid_from)
        VALUES (current_tenant(), ${partyId}, 'candidate', CURRENT_DATE)
        ON CONFLICT DO NOTHING
      `);

      const r = await db.execute(sql`${CAND_SELECT} WHERE c.party_id = ${partyId}`);
      return r.rows[0];
    });

    res.status(201).json({ candidate: created });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "NOT_LEARNER") return res.status(400).json({ error: "that party has no learner profile — only learners can become candidates" });
    if (code === "DUP")         return res.status(409).json({ error: "that learner already has a candidate profile" });
    next(err);
  }
});

candidatesRouter.patch("/:partyId", async (req, res, next) => {
  try {
    const partyId = String(req.params.partyId);
    if (!UUID.test(partyId)) return res.status(400).json({ error: "invalid partyId" });
    const b = req.body ?? {};

    const sets: ReturnType<typeof sql>[] = [];
    try {
      if (b.profileStatus !== undefined) sets.push(sql`profile_status = ${pickEnum(b.profileStatus, CAND_STATUSES, "profileStatus")}`);
    } catch (err) { return res.status(400).json({ error: (err as Error).message }); }

    if (b.currentEmployer    !== undefined) sets.push(sql`current_employer = ${b.currentEmployer ? String(b.currentEmployer).trim() : null}`);
    if (b.currentDesignation !== undefined) sets.push(sql`current_designation = ${b.currentDesignation ? String(b.currentDesignation).trim() : null}`);
    if (b.highestQualification !== undefined) sets.push(sql`highest_qualification = ${b.highestQualification ? String(b.highestQualification).trim() : null}`);
    if (b.workHistorySummary   !== undefined) sets.push(sql`work_history_summary = ${b.workHistorySummary ? String(b.workHistorySummary).trim() : null}`);
    if (b.portfolioUrl !== undefined) sets.push(sql`portfolio_url = ${b.portfolioUrl ? String(b.portfolioUrl).trim() : null}`);
    if (b.currency     !== undefined) sets.push(sql`currency = ${b.currency ? String(b.currency).trim() : "INR"}`);
    for (const [key, col] of [
      ["totalExperienceMonths", "total_experience_months"],
      ["noticePeriodDays", "notice_period_days"],
    ] as const) {
      if (b[key] !== undefined) sets.push(sql`${sql.raw(col)} = ${b[key] != null && b[key] !== "" ? Number(b[key]) : null}`);
    }
    for (const [key, col] of [["currentCtc", "current_ctc"], ["expectedCtc", "expected_ctc"]] as const) {
      if (b[key] !== undefined) sets.push(sql`${sql.raw(col)} = ${b[key] != null && b[key] !== "" ? String(b[key]) : null}`);
    }
    for (const [key, col] of [["skills", "skills"], ["certifications", "certifications"]] as const) {
      const list = normaliseList(b[key]);
      if (list !== undefined) sets.push(sql`${sql.raw(col)} = ${list}`);
    }
    if (b.resumeAttachmentId !== undefined) {
      const v = b.resumeAttachmentId ? String(b.resumeAttachmentId).trim() : null;
      if (v && !UUID.test(v)) return res.status(400).json({ error: "invalid resumeAttachmentId" });
      sets.push(sql`resume_attachment_id = ${v}`);
    }

    if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });

    const updated = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        UPDATE candidate SET ${sql.join(sets, sql`, `)} WHERE party_id = ${partyId} RETURNING party_id
      `);
      if (!r.rows[0]) return null;
      const detail = await db.execute(sql`${CAND_SELECT} WHERE c.party_id = ${partyId}`);
      return detail.rows[0];
    });

    if (!updated) return res.status(404).json({ error: "candidate not found" });
    res.json({ candidate: updated });
  } catch (err) { next(err); }
});

// ═══ Applications ═════════════════════════════════════════════════════════

const APP_SELECT = sql`
  SELECT
    a.id, a.number,
    a.candidate_party_id AS "candidatePartyId",
    p.name  AS "candidateName",
    c.number AS "candidateNumber",
    a.requisition_id AS "requisitionId",
    r.number AS "requisitionNumber",
    r.job_title AS "jobTitle",
    acc.name AS "accountName",
    a.applied_at AS "appliedAt",
    a.stage, a.stage_updated_at AS "stageUpdatedAt",
    a.screening_score   AS "screeningScore",
    a.screening_factors AS "screeningFactors",
    a.assigned_recruiter_party_id AS "assignedRecruiterPartyId",
    rec.name AS "assignedRecruiterName",
    a.interview_status AS "interviewStatus",
    a.offer_status     AS "offerStatus",
    a.rejection_reason AS "rejectionReason",
    a.human_review_status AS "humanReviewStatus",
    a.status,
    a.created_at AS "createdAt", a.updated_at AS "updatedAt"
  FROM application a
  JOIN candidate c   ON c.party_id = a.candidate_party_id
  JOIN party p       ON p.id = a.candidate_party_id
  JOIN requisition r ON r.id = a.requisition_id
  JOIN party acc     ON acc.id = r.account_party_id
  LEFT JOIN party rec ON rec.id = a.assigned_recruiter_party_id
`;

applicationsRouter.get("/", async (req, res, next) => {
  try {
    const requisitionId = String(req.query.requisitionId ?? "").trim();
    const candidateId   = String(req.query.candidateId ?? "").trim();
    const stage         = String(req.query.stage ?? "").trim();
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        ${APP_SELECT}
        WHERE ${requisitionId && UUID.test(requisitionId) ? sql`a.requisition_id = ${requisitionId}` : sql`true`}
          AND ${candidateId && UUID.test(candidateId) ? sql`a.candidate_party_id = ${candidateId}` : sql`true`}
          AND ${stage ? sql`a.stage = ${stage}` : sql`true`}
        ORDER BY a.applied_at DESC
      `);
      return r.rows;
    });
    res.json({ applications: rows });
  } catch (err) { next(err); }
});

applicationsRouter.post("/", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const candidatePartyId = b.candidatePartyId ? String(b.candidatePartyId).trim() : null;
    const requisitionId    = b.requisitionId    ? String(b.requisitionId).trim()    : null;
    if (!candidatePartyId || !UUID.test(candidatePartyId)) return res.status(400).json({ error: "candidatePartyId is required" });
    if (!requisitionId    || !UUID.test(requisitionId))    return res.status(400).json({ error: "requisitionId is required" });

    const created = await withTenant(req.tenantId!, async (db) => {
      // The gate. Reading the view rather than repeating its predicate means
      // a change to what "eligible" means lands here for free.
      const ok = await db.execute(sql`
        SELECT party_id FROM candidate_eligible WHERE party_id = ${candidatePartyId}
      `);
      if (!ok.rows[0]) throw Object.assign(new Error("not eligible"), { code: "NOT_ELIGIBLE" });

      const req_ = await db.execute(sql`SELECT id, status FROM requisition WHERE id = ${requisitionId}`);
      const reqRow = req_.rows[0] as { status: string } | undefined;
      if (!reqRow) throw Object.assign(new Error("no requisition"), { code: "NO_REQ" });
      if (reqRow.status !== "open") throw Object.assign(new Error("not open"), { code: "REQ_NOT_OPEN" });

      const dup = await db.execute(sql`
        SELECT id FROM application
         WHERE candidate_party_id = ${candidatePartyId} AND requisition_id = ${requisitionId}
      `);
      if (dup.rows[0]) throw Object.assign(new Error("duplicate"), { code: "DUP" });

      const r = await db.execute(sql`
        INSERT INTO application (
          tenant_id, candidate_party_id, requisition_id, stage,
          screening_score, screening_factors, assigned_recruiter_party_id, human_review_status
        ) VALUES (
          current_tenant(), ${candidatePartyId}, ${requisitionId}, 'applied',
          ${b.screeningScore != null && b.screeningScore !== "" ? Number(b.screeningScore) : null},
          ${JSON.stringify(b.screeningFactors ?? {})}::jsonb,
          ${b.assignedRecruiterPartyId && UUID.test(String(b.assignedRecruiterPartyId)) ? String(b.assignedRecruiterPartyId) : null},
          ${b.screeningScore != null && b.screeningScore !== "" ? "pending" : "not_required"}
        )
        RETURNING id
      `);
      const id = (r.rows[0] as { id: string }).id;
      const detail = await db.execute(sql`${APP_SELECT} WHERE a.id = ${id}`);
      return detail.rows[0];
    });

    res.status(201).json({ application: created });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "NOT_ELIGIBLE") {
      return res.status(400).json({
        error: "that candidate is not eligible — they must be marked qualified, have granted staffing consent, and have a ready or active profile",
      });
    }
    if (code === "NO_REQ")       return res.status(400).json({ error: "requisition not found" });
    if (code === "REQ_NOT_OPEN") return res.status(400).json({ error: "that requisition is not open" });
    if (code === "DUP")          return res.status(409).json({ error: "that candidate has already applied to this requisition" });
    next(err);
  }
});

applicationsRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ error: "invalid id" });
    const b = req.body ?? {};

    const sets: ReturnType<typeof sql>[] = [];
    let stage;
    try {
      stage = pickEnum(b.stage, APP_STAGES, "stage");
      if (b.interviewStatus !== undefined) sets.push(sql`interview_status = ${pickEnum(b.interviewStatus, INTERVIEW, "interviewStatus")}`);
      if (b.offerStatus     !== undefined) sets.push(sql`offer_status = ${pickEnum(b.offerStatus, OFFER, "offerStatus")}`);
      if (b.humanReviewStatus !== undefined) sets.push(sql`human_review_status = ${pickEnum(b.humanReviewStatus, APPROVAL, "humanReviewStatus")}`);
    } catch (err) { return res.status(400).json({ error: (err as Error).message }); }

    const rejectionReason = b.rejectionReason !== undefined
      ? (b.rejectionReason ? String(b.rejectionReason).trim() : null) : undefined;

    // The DB CHECK refuses a reasonless rejection; catching it here gives a
    // message a recruiter can act on instead of a constraint name.
    if (stage === "rejected" && rejectionReason === undefined) {
      return res.status(400).json({ error: "rejecting an application requires a rejectionReason" });
    }
    if (stage === "rejected" && !rejectionReason) {
      return res.status(400).json({ error: "rejectionReason cannot be empty" });
    }

    if (stage !== null && stage !== undefined) {
      sets.push(sql`stage = ${stage}`);
      // Terminal stages close the application, so "open applications" is a
      // single-column filter rather than a list of stages every caller
      // has to remember.
      if ((TERMINAL_STAGES as readonly string[]).includes(stage)) {
        sets.push(sql`status = 'closed'`);
      } else {
        sets.push(sql`status = 'open'`);
      }
    }
    if (rejectionReason !== undefined) sets.push(sql`rejection_reason = ${rejectionReason}`);
    if (b.screeningScore !== undefined) {
      sets.push(sql`screening_score = ${b.screeningScore != null && b.screeningScore !== "" ? Number(b.screeningScore) : null}`);
    }
    if (b.screeningFactors !== undefined) {
      sets.push(sql`screening_factors = ${JSON.stringify(b.screeningFactors ?? {})}::jsonb`);
    }
    if (b.assignedRecruiterPartyId !== undefined) {
      const v = b.assignedRecruiterPartyId ? String(b.assignedRecruiterPartyId).trim() : null;
      if (v && !UUID.test(v)) return res.status(400).json({ error: "invalid assignedRecruiterPartyId" });
      sets.push(sql`assigned_recruiter_party_id = ${v}`);
    }

    if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });

    const updated = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        UPDATE application SET ${sql.join(sets, sql`, `)} WHERE id = ${id} RETURNING id, candidate_party_id
      `);
      const row = r.rows[0] as { candidate_party_id: string } | undefined;
      if (!row) return null;

      // A hire is the end of the pipeline for this person: mark the candidate
      // placed and write it back to the learner profile, which is where the
      // rest of the app reads placement from.
      if (stage === "hired") {
        await db.execute(sql`
          UPDATE candidate SET profile_status = 'placed' WHERE party_id = ${row.candidate_party_id}
        `);
        await db.execute(sql`
          UPDATE learner_profile lp
             SET placement_status = 'placed',
                 placed_at = CURRENT_DATE,
                 placed_company = acc.name
            FROM application a
            JOIN requisition rq ON rq.id = a.requisition_id
            JOIN party acc ON acc.id = rq.account_party_id
           WHERE a.id = ${id} AND lp.party_id = ${row.candidate_party_id}
        `);
      }

      const detail = await db.execute(sql`${APP_SELECT} WHERE a.id = ${id}`);
      return detail.rows[0];
    });

    if (!updated) return res.status(404).json({ error: "application not found" });
    res.json({ application: updated });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("application_rejection_reason_check")) {
      return res.status(400).json({ error: "rejecting an application requires a rejectionReason" });
    }
    next(err);
  }
});
