import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { emitEvent } from "../lib/events.js";
import { partyIdFromAppUserId, resolveActorPartyId, resolveSentinelPartyId } from "../lib/party/resolve.js";

export const casesRouter = Router();

// Internally the table is "support_case" because plain "case" is a reserved
// SQL keyword in PostgreSQL. Externally — URL paths, response field names,
// log lines, error messages — everything is "case". The aliasing happens
// only at the SQL boundary.

// ─── shared constants ─────────────────────────────────────────────────────

const STATUSES = ["open", "in_progress", "pending", "resolved", "closed", "cancelled"] as const;
const CATEGORIES = ["billing", "technical", "content_lms", "onboarding", "cohort_batch", "refund", "certificate", "other"] as const;
const REQ_KINDS = ["lead", "learner", "external"] as const;
const RES_CODES = ["fixed", "duplicate", "wont_fix", "no_action"] as const;

const STATUS_LABEL: Record<string, string> = {
  open: "Open", in_progress: "In progress", pending: "Pending",
  resolved: "Resolved", closed: "Closed", cancelled: "Cancelled",
};
const CATEGORY_LABEL: Record<string, string> = {
  billing: "Billing", technical: "Technical", content_lms: "Content / LMS",
  onboarding: "Onboarding", cohort_batch: "Cohort / Batch", refund: "Refund",
  certificate: "Certificate", other: "Other",
};
const PRIORITY_LABEL: Record<number, string> = { 1: "Urgent", 2: "High", 3: "Medium", 4: "Low" };

// Drizzle's tagged template handles binding for us — these helpers keep the
// route bodies focused on logic.
function isUuid(s: string): boolean {
  return /^[0-9a-fA-F-]{36}$/.test(s);
}

function statusToWiState(s: string): string {
  if (s === "closed" || s === "resolved") return "closed_won";
  if (s === "cancelled") return "closed_lost";
  if (s === "in_progress" || s === "pending") return "in_progress";
  return "open";
}

// ─── GET /cases/dashboard ─────────────────────────────────────────────────

casesRouter.get("/dashboard", async (req, res, next) => {
  try {
    const data = await withTenant(req.tenantId!, async (db) => {
      const counts = await db.execute(sql`
        SELECT
          COUNT(*)::int                                                                           AS "total",
          COUNT(*) FILTER (WHERE status = 'open')::int                                            AS "open",
          COUNT(*) FILTER (WHERE status = 'in_progress')::int                                     AS "inProgress",
          COUNT(*) FILTER (WHERE status = 'pending')::int                                         AS "pending",
          COUNT(*) FILTER (WHERE status = 'resolved')::int                                        AS "resolved",
          COUNT(*) FILTER (WHERE status = 'closed')::int                                          AS "closed",
          COUNT(*) FILTER (WHERE status = 'cancelled')::int                                       AS "cancelled",
          COUNT(*) FILTER (WHERE due_at < NOW() AND status NOT IN ('closed','resolved','cancelled'))::int AS "overdue",
          COUNT(*) FILTER (WHERE due_at >= NOW() AND due_at < NOW() + interval '24 hours'
                          AND status NOT IN ('closed','resolved','cancelled'))::int               AS "dueToday",
          COUNT(*) FILTER (WHERE due_at >= NOW() AND due_at < NOW() + interval '7 days'
                          AND status NOT IN ('closed','resolved','cancelled'))::int               AS "dueThisWeek",
          COUNT(*) FILTER (WHERE closed_at >= NOW() - interval '7 days')::int                     AS "closedThisWeek"
        FROM support_case
      `);

      const byPriority = await db.execute(sql`
        SELECT priority::int AS priority, COUNT(*)::int AS count
        FROM support_case
        WHERE status NOT IN ('closed','resolved','cancelled')
        GROUP BY priority
        ORDER BY priority
      `);

      const byCategory = await db.execute(sql`
        SELECT category, COUNT(*)::int AS count
        FROM support_case
        WHERE status NOT IN ('closed','resolved','cancelled')
        GROUP BY category
        ORDER BY count DESC
      `);

      const byAssignee = await db.execute(sql`
        SELECT
          u.id                                              AS "assigneeId",
          u.name                                            AS "name",
          u.role                                            AS "role",
          COUNT(*) FILTER (WHERE t.status NOT IN ('closed','resolved','cancelled'))::int AS "open",
          COUNT(*) FILTER (WHERE t.due_at < NOW() AND t.status NOT IN ('closed','resolved','cancelled'))::int AS "overdue",
          COUNT(*) FILTER (WHERE t.closed_at >= NOW() - interval '7 days')::int          AS "closedThisWeek"
        FROM app_user u
        LEFT JOIN work_item wi ON wi.assignee_id = u.party_id AND wi.type = 'support_case'
        LEFT JOIN support_case t     ON t.work_item_id = wi.id
        WHERE u.active = true AND u.role IN ('admin','advisor','service_rep')
        GROUP BY u.id, u.name, u.role
        ORDER BY "open" DESC, u.name
      `);

      const oldestOpen = await db.execute(sql`
        SELECT
          wi.id, wi.number, t.subject, t.status, t.priority, t.due_at AS "dueAt",
          t.requester_name AS "requesterName",
          u.name AS "assigneeName",
          wi.created_at AS "createdAt",
          (t.due_at IS NOT NULL AND t.due_at < NOW()) AS "isOverdue"
        FROM support_case t
        JOIN work_item wi  ON wi.id = t.work_item_id
        LEFT JOIN app_user u ON u.party_id = wi.assignee_id
        WHERE t.status NOT IN ('closed','resolved','cancelled')
        ORDER BY wi.created_at ASC
        LIMIT 5
      `);

      const recentClosed = await db.execute(sql`
        SELECT
          wi.id, wi.number, t.subject, t.status, t.priority, t.closed_at AS "closedAt",
          t.requester_name AS "requesterName",
          u.name AS "assigneeName",
          t.resolution
        FROM support_case t
        JOIN work_item wi  ON wi.id = t.work_item_id
        LEFT JOIN app_user u ON u.party_id = wi.assignee_id
        WHERE t.status IN ('closed','resolved')
        ORDER BY COALESCE(t.closed_at, t.resolved_at) DESC NULLS LAST
        LIMIT 5
      `);

      return {
        counts: counts.rows[0] ?? {},
        byPriority: byPriority.rows,
        byCategory: byCategory.rows,
        byAssignee: byAssignee.rows,
        oldestOpen: oldestOpen.rows,
        recentClosed: recentClosed.rows,
      };
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ─── GET /cases — list with filters ───────────────────────────────────────

casesRouter.get("/", async (req, res, next) => {
  try {
    const status     = typeof req.query.status     === "string" ? req.query.status     : null;
    const assigneeId = typeof req.query.assigneeId === "string" ? req.query.assigneeId : null;
    const category   = typeof req.query.category   === "string" ? req.query.category   : null;
    const priority   = req.query.priority != null ? Number(req.query.priority) : null;
    const requesterKind = typeof req.query.requesterKind === "string" ? req.query.requesterKind : null;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    if (status     && !STATUSES.includes(status as typeof STATUSES[number])) return res.status(400).json({ error: "invalid status" });
    if (category   && !CATEGORIES.includes(category as typeof CATEGORIES[number])) return res.status(400).json({ error: "invalid category" });
    if (requesterKind && !REQ_KINDS.includes(requesterKind as typeof REQ_KINDS[number])) return res.status(400).json({ error: "invalid requesterKind" });
    if (priority != null && (Number.isNaN(priority) || priority < 1 || priority > 4)) return res.status(400).json({ error: "invalid priority" });

    const rows = await withTenant(req.tenantId!, async (db) => {
      const conditions: ReturnType<typeof sql>[] = [];
      if (status)     conditions.push(sql`t.status = ${status}`);
      // Phase 2: wi.assignee_id stores party.id — resolve inbound app_user.id.
      if (assigneeId) {
        const partyId = await partyIdFromAppUserId(db, assigneeId);
        conditions.push(sql`wi.assignee_id = ${partyId}`);
      }
      if (category)   conditions.push(sql`t.category = ${category}`);
      if (priority)   conditions.push(sql`t.priority = ${priority}`);
      if (requesterKind) conditions.push(sql`t.requester_kind = ${requesterKind}`);
      if (q) {
        conditions.push(sql`(
          wi.number ILIKE ${"%" + q + "%"} OR
          t.subject ILIKE ${"%" + q + "%"} OR
          t.requester_name ILIKE ${"%" + q + "%"} OR
          t.requester_email ILIKE ${"%" + q + "%"}
        )`);
      }

      const where = conditions.length ? sql` WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

      const r = await db.execute(sql`
        SELECT
          wi.id, wi.number, wi.created_at AS "createdAt", wi.updated_at AS "updatedAt",
          t.subject, t.description, t.category, t.priority, t.status,
          t.requester_name  AS "requesterName",
          t.requester_email AS "requesterEmail",
          t.requester_phone AS "requesterPhone",
          t.requester_kind  AS "requesterKind",
          t.party_id        AS "partyId",
          t.due_at          AS "dueAt",
          t.remind_at       AS "remindAt",
          t.resolved_at     AS "resolvedAt",
          t.closed_at       AS "closedAt",
          t.resolution,
          t.resolution_code AS "resolutionCode",
          u.id              AS "assigneeId",
          u.name            AS "assigneeName",
          (t.due_at IS NOT NULL AND t.due_at < NOW() AND t.status NOT IN ('closed','resolved','cancelled')) AS "isOverdue"
        FROM support_case t
        JOIN work_item wi  ON wi.id = t.work_item_id
        LEFT JOIN app_user u ON u.party_id = wi.assignee_id
        ${where}
        ORDER BY
          CASE WHEN t.status IN ('closed','resolved','cancelled') THEN 1 ELSE 0 END,
          t.priority ASC,
          wi.created_at DESC
      `);
      return r.rows;
    });

    res.json({ cases: rows });
  } catch (err) {
    next(err);
  }
});

// ─── GET /cases/:idOrNumber ───────────────────────────────────────────────

casesRouter.get("/:idOrNumber", async (req, res, next) => {
  try {
    const { idOrNumber } = req.params;
    const lookupIsUuid = isUuid(idOrNumber);

    const data = await withTenant(req.tenantId!, async (db) => {
      const row = await db.execute(
        lookupIsUuid
          ? sql`
              SELECT
                wi.id, wi.number, wi.created_at AS "createdAt", wi.updated_at AS "updatedAt",
                t.subject, t.description, t.category, t.priority, t.status,
                t.requester_name  AS "requesterName",
                t.requester_email AS "requesterEmail",
                t.requester_phone AS "requesterPhone",
                t.requester_kind  AS "requesterKind",
                t.party_id        AS "partyId",
                t.due_at          AS "dueAt",
                t.remind_at       AS "remindAt",
                t.resolved_at     AS "resolvedAt",
                t.closed_at       AS "closedAt",
                t.resolution,
                t.resolution_code AS "resolutionCode",
                u.id              AS "assigneeId",
                u.name            AS "assigneeName",
                u.email           AS "assigneeEmail",
                cu.name           AS "createdByName",
                p.name            AS "partyName",
                p.email           AS "partyEmail",
                p.phone           AS "partyPhone"
              FROM support_case t
              JOIN work_item wi   ON wi.id = t.work_item_id
              LEFT JOIN app_user u  ON u.party_id = wi.assignee_id
              LEFT JOIN app_user cu ON cu.party_id = t.created_by_id
              LEFT JOIN party p     ON p.id = t.party_id
              WHERE wi.id = ${idOrNumber} AND wi.type = 'support_case'
              LIMIT 1
            `
          : sql`
              SELECT
                wi.id, wi.number, wi.created_at AS "createdAt", wi.updated_at AS "updatedAt",
                t.subject, t.description, t.category, t.priority, t.status,
                t.requester_name  AS "requesterName",
                t.requester_email AS "requesterEmail",
                t.requester_phone AS "requesterPhone",
                t.requester_kind  AS "requesterKind",
                t.party_id        AS "partyId",
                t.due_at          AS "dueAt",
                t.remind_at       AS "remindAt",
                t.resolved_at     AS "resolvedAt",
                t.closed_at       AS "closedAt",
                t.resolution,
                t.resolution_code AS "resolutionCode",
                u.id              AS "assigneeId",
                u.name            AS "assigneeName",
                u.email           AS "assigneeEmail",
                cu.name           AS "createdByName",
                p.name            AS "partyName",
                p.email           AS "partyEmail",
                p.phone           AS "partyPhone"
              FROM support_case t
              JOIN work_item wi   ON wi.id = t.work_item_id
              LEFT JOIN app_user u  ON u.party_id = wi.assignee_id
              LEFT JOIN app_user cu ON cu.party_id = t.created_by_id
              LEFT JOIN party p     ON p.id = t.party_id
              WHERE wi.number = ${idOrNumber} AND wi.type = 'support_case'
              LIMIT 1
            `,
      );
      if (!row.rows[0]) return null;
      const supportCase = row.rows[0] as Record<string, unknown>;
      const wiId = supportCase.id as string;

      const timeline = await db.execute(sql`
        SELECT
          id, actor_type AS "actorType", actor_name AS "actorName",
          verb, detail, tag, payload, ts
        FROM activity
        WHERE work_item_id = ${wiId}
        ORDER BY ts DESC
      `);

      // Look up the lead/learner record number, if any, so the UI can deep-link.
      // Prefer the *current* role: if the party is an active learner, send the
      // user to the learner record. Only fall back to the lead record when
      // they're still a lead (or have no learner role yet).
      let linked: { kind: "lead" | "learner"; href: string; label: string } | null = null;
      if (supportCase.partyId) {
        const learnerActive = await db.execute(sql`
          SELECT 1 FROM party_role
          WHERE party_id = ${supportCase.partyId as string} AND role = 'learner' AND valid_to IS NULL
          LIMIT 1
        `);
        if (learnerActive.rows[0]) {
          linked = { kind: "learner", href: `/learners/${supportCase.partyId}`, label: "Learner record" };
        } else {
          const lead = await db.execute(sql`
            SELECT wi.number FROM lead l
            JOIN work_item wi ON wi.id = l.work_item_id
            WHERE wi.party_id = ${supportCase.partyId as string}
            LIMIT 1
          `);
          if (lead.rows[0]) {
            const num = (lead.rows[0] as { number: string }).number;
            linked = { kind: "lead", href: `/records/${num}`, label: num };
          }
        }
      }

      return { case: supportCase, timeline: timeline.rows, linked };
    });

    if (!data) return res.status(404).json({ error: "Case not found" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ─── POST /cases — create ─────────────────────────────────────────────────

casesRouter.post("/", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const errors: string[] = [];

    const requesterName  = String(b.requesterName ?? b.name ?? "").trim();
    const requesterEmail = String(b.requesterEmail ?? b.email ?? "").trim();
    const requesterPhone = String(b.requesterPhone ?? b.phone ?? "").trim();
    const requesterKind  = String(b.requesterKind ?? "external");
    const subject        = String(b.subject ?? "").trim();
    const description    = b.description ? String(b.description).trim() : null;
    const category       = String(b.category ?? "other");
    const priority       = b.priority != null ? Number(b.priority) : 3;
    const partyId        = b.partyId ? String(b.partyId) : null;
    const assigneeId     = b.assigneeId ? String(b.assigneeId) : null;
    const dueAt          = b.dueAt ? new Date(String(b.dueAt)) : null;
    const remindAt       = b.remindAt ? new Date(String(b.remindAt)) : null;

    if (!requesterName)  errors.push("name is required");
    if (!requesterEmail) errors.push("email is required");
    if (!requesterPhone) errors.push("phone is required");
    if (!subject)        errors.push("subject is required");
    if (requesterEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requesterEmail)) errors.push("email looks invalid");
    if (!REQ_KINDS.includes(requesterKind as typeof REQ_KINDS[number])) errors.push("requesterKind must be lead|learner|external");
    if (!CATEGORIES.includes(category as typeof CATEGORIES[number])) errors.push("invalid category");
    if (Number.isNaN(priority) || priority < 1 || priority > 4) errors.push("priority must be 1..4");
    if ((requesterKind === "lead" || requesterKind === "learner") && !partyId) errors.push("partyId is required when requesterKind is lead or learner");
    if (partyId && !isUuid(partyId)) errors.push("partyId must be a uuid");
    if (assigneeId && !isUuid(assigneeId)) errors.push("assigneeId must be a uuid");
    if (dueAt && Number.isNaN(dueAt.getTime())) errors.push("dueAt is not a valid timestamp");
    if (remindAt && Number.isNaN(remindAt.getTime())) errors.push("remindAt is not a valid timestamp");

    if (errors.length) return res.status(400).json({ error: errors.join("; ") });

    const result = await withTenant(req.tenantId!, async (db) => {
      // If linked to a party, verify the role is current.
      if (partyId && (requesterKind === "lead" || requesterKind === "learner")) {
        const r = await db.execute(sql`
          SELECT 1 FROM party_role
          WHERE party_id = ${partyId} AND role = ${requesterKind} AND valid_to IS NULL
          LIMIT 1
        `);
        if (!r.rows[0]) return { kind: "bad-link" as const };
      }

      // Resolve creator: first admin in the tenant (mirrors `me`).
      // Phase 2: created_by_id / assignee_id store party.id.
      const creatorR = await db.execute(sql`
        SELECT party_id, name FROM app_user WHERE role = 'admin' AND active = true ORDER BY created_at LIMIT 1
      `);
      const creator = creatorR.rows[0] as { party_id: string; name: string } | undefined;

      // Assignee — explicit if provided, else null (allowed; "unassigned").
      let assigneeName: string | null = null;
      let assigneePartyId: string | null = null;
      if (assigneeId) {
        const u = await db.execute(sql`SELECT name, party_id FROM app_user WHERE id = ${assigneeId} AND active = true`);
        const row = u.rows[0] as { name: string; party_id: string } | undefined;
        assigneeName = row?.name ?? null;
        assigneePartyId = row?.party_id ?? null;
        if (!assigneeName) return { kind: "bad-assignee" as const };
      }

      // Number
      const numR = await db.execute(sql`SELECT nextval('seq_support_case')::text AS n`);
      const number = `CSE-${(numR.rows[0] as { n: string }).n}`;

      // 1. work_item
      const wiR = await db.execute(sql`
        INSERT INTO work_item (tenant_id, number, type, party_id, assignee_id, state)
        VALUES (current_tenant(), ${number}, 'support_case', ${partyId}, ${assigneePartyId}, 'open')
        RETURNING id
      `);
      const wiId = (wiR.rows[0] as { id: string }).id;

      // 2. support_case extension
      await db.execute(sql`
        INSERT INTO support_case (
          work_item_id, tenant_id,
          requester_name, requester_email, requester_phone, requester_kind, party_id,
          subject, description, category, priority, status,
          due_at, remind_at, created_by_id
        ) VALUES (
          ${wiId}, current_tenant(),
          ${requesterName}, ${requesterEmail}, ${requesterPhone}, ${requesterKind}, ${partyId},
          ${subject}, ${description}, ${category}, ${priority}, 'open',
          ${dueAt ? dueAt.toISOString() : null}, ${remindAt ? remindAt.toISOString() : null},
          ${creator?.party_id ?? null}
        )
      `);

      // Phase 3: actor is the acting user if we have one; else the creator
      // party we resolved above. Falls back to sentinel if both are missing.
      const actorPartyId = req.userId
        ? await resolveActorPartyId(db, req.tenantId!, req.userId)
        : (creator?.party_id ?? await resolveSentinelPartyId(db, req.tenantId!));

      // 3. activity row — created
      await db.execute(sql`
        INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
        VALUES (
          current_tenant(), ${wiId}, ${partyId},
          'user', ${actorPartyId}, ${creator?.name ?? "System"}, 'Case created',
          ${`${subject} · ${CATEGORY_LABEL[category] ?? category} · ${PRIORITY_LABEL[priority] ?? priority}`},
          'you',
          ${JSON.stringify({ when: "Just now", kind: "create", category, priority })}::jsonb,
          NOW()
        )
      `);

      if (assigneeName) {
        await db.execute(sql`
          INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
          VALUES (
            current_tenant(), ${wiId}, ${partyId},
            'user', ${actorPartyId}, ${creator?.name ?? "System"}, 'Assigned',
            ${`Assignee: unassigned → ${assigneeName}`}, 'you',
            ${JSON.stringify({ when: "Just now", kind: "assign" })}::jsonb,
            NOW() + interval '1 second'
          )
        `);
      }

      return { kind: "ok" as const, id: wiId, number, assigneeName };
    });

    if (result.kind === "bad-link")     return res.status(400).json({ error: "linked party does not currently hold the specified role" });
    if (result.kind === "bad-assignee") return res.status(400).json({ error: "assignee not found or inactive" });

    // Fire Slack notifications post-commit. Never throws.
    await emitEvent({
      type: "case.opened",
      tenantId: req.tenantId!,
      occurredAt: new Date().toISOString(),
      context: {
        caseId: result.id,
        number: result.number,
        subject,
        category,
        priority,
        requesterName,
        requesterEmail,
        requesterKind,
        assigneeName: result.assigneeName,
      },
    });

    res.status(201).json({ case: { id: result.id, number: result.number } });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /cases/:idOrNumber — edit fields, log diff ────────────────────

casesRouter.patch("/:idOrNumber", async (req, res, next) => {
  try {
    const { idOrNumber } = req.params;
    const lookupIsUuid = isUuid(idOrNumber);
    const b = req.body ?? {};

    // Validate enums up front
    if (b.status !== undefined && !STATUSES.includes(String(b.status) as typeof STATUSES[number])) {
      return res.status(400).json({ error: "invalid status" });
    }
    if (b.category !== undefined && !CATEGORIES.includes(String(b.category) as typeof CATEGORIES[number])) {
      return res.status(400).json({ error: "invalid category" });
    }
    if (b.priority !== undefined) {
      const p = Number(b.priority);
      if (Number.isNaN(p) || p < 1 || p > 4) return res.status(400).json({ error: "invalid priority" });
    }
    if (b.status === "closed") {
      // Cannot transition to 'closed' via PATCH — must use /close so resolution is required.
      return res.status(400).json({ error: "use POST /cases/:id/close to close a case (resolution required)" });
    }

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const beforeR = await db.execute(
        lookupIsUuid
          ? sql`
              SELECT
                wi.id, wi.party_id AS "partyId",
                u.id               AS "assigneeId",  -- app_user.id via party_id (Phase 2)
                t.subject, t.description, t.category, t.priority, t.status,
                t.due_at AS "dueAt", t.remind_at AS "remindAt"
              FROM support_case t
              JOIN work_item wi ON wi.id = t.work_item_id
              LEFT JOIN app_user u ON u.party_id = wi.assignee_id
              WHERE wi.id = ${idOrNumber} AND wi.type = 'support_case'
            `
          : sql`
              SELECT
                wi.id, wi.party_id AS "partyId",
                u.id               AS "assigneeId",  -- app_user.id via party_id (Phase 2)
                t.subject, t.description, t.category, t.priority, t.status,
                t.due_at AS "dueAt", t.remind_at AS "remindAt"
              FROM support_case t
              JOIN work_item wi ON wi.id = t.work_item_id
              LEFT JOIN app_user u ON u.party_id = wi.assignee_id
              WHERE wi.number = ${idOrNumber} AND wi.type = 'support_case'
            `,
      );
      if (!beforeR.rows[0]) return { kind: "not-found" as const };
      const before = beforeR.rows[0] as Record<string, unknown>;
      const wiId = before.id as string;
      const partyId = (before.partyId as string | null) ?? null;

      // Build dynamic UPDATE
      const caseSets: ReturnType<typeof sql>[] = [];
      if (b.subject !== undefined)     caseSets.push(sql`subject = ${String(b.subject).trim()}`);
      if (b.description !== undefined) caseSets.push(sql`description = ${b.description ? String(b.description) : null}`);
      if (b.category !== undefined)    caseSets.push(sql`category = ${String(b.category)}`);
      if (b.priority !== undefined)    caseSets.push(sql`priority = ${Number(b.priority)}`);
      if (b.status !== undefined)      caseSets.push(sql`status = ${String(b.status)}`);
      if (b.dueAt !== undefined)       caseSets.push(sql`due_at = ${b.dueAt ? new Date(String(b.dueAt)).toISOString() : null}`);
      if (b.remindAt !== undefined)    caseSets.push(sql`remind_at = ${b.remindAt ? new Date(String(b.remindAt)).toISOString() : null}`);

      if (b.status === "resolved")     caseSets.push(sql`resolved_at = NOW()`);

      if (caseSets.length > 0) {
        const set = sql.join(caseSets, sql`, `);
        await db.execute(sql`UPDATE support_case SET ${set} WHERE work_item_id = ${wiId}`);
      }

      // Assignee change
      // Phase 2: work_item.assignee_id stores party.id; client sends app_user.id.
      let newAssigneeName: string | null | undefined = undefined;
      let oldAssigneeName: string | null | undefined = undefined;
      let newAssigneePartyId: string | null | undefined = undefined;
      if (b.assigneeId !== undefined) {
        const newId = b.assigneeId ? String(b.assigneeId) : null;
        if (newId) {
          const u = await db.execute(sql`SELECT name, party_id FROM app_user WHERE id = ${newId}`);
          const row = u.rows[0] as { name: string; party_id: string } | undefined;
          newAssigneeName = row?.name ?? null;
          newAssigneePartyId = row?.party_id ?? null;
        } else {
          newAssigneeName = null;
          newAssigneePartyId = null;
        }
        if (before.assigneeId) {
          const u = await db.execute(sql`SELECT name FROM app_user WHERE id = ${before.assigneeId as string}`);
          oldAssigneeName = (u.rows[0] as { name: string } | undefined)?.name ?? null;
        } else {
          oldAssigneeName = null;
        }
        await db.execute(sql`UPDATE work_item SET assignee_id = ${newAssigneePartyId} WHERE id = ${wiId}`);
      }

      // Status mirror to work_item.state
      if (b.status !== undefined) {
        await db.execute(sql`UPDATE work_item SET state = ${statusToWiState(String(b.status))} WHERE id = ${wiId}`);
      }

      // Build diff for activity log
      const fmtDate = (v: unknown) => v ? new Date(String(v)).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }) : "—";
      const lines: { verb: string; detail: string; kind: string }[] = [];

      if (b.subject !== undefined && before.subject !== b.subject) {
        lines.push({ verb: "Subject", detail: `Subject: "${before.subject}" → "${b.subject}"`, kind: "edit" });
      }
      if (b.description !== undefined && (before.description ?? "") !== (b.description ?? "")) {
        const had = !!before.description, has = !!b.description;
        const detail = !had && has ? "Description: added" : had && !has ? "Description: cleared" : "Description: updated";
        lines.push({ verb: "Description", detail, kind: "edit" });
      }
      if (b.category !== undefined && before.category !== b.category) {
        lines.push({ verb: "Category", detail: `Category: ${CATEGORY_LABEL[before.category as string] ?? before.category} → ${CATEGORY_LABEL[String(b.category)] ?? b.category}`, kind: "edit" });
      }
      if (b.priority !== undefined && Number(before.priority) !== Number(b.priority)) {
        lines.push({ verb: "Priority", detail: `Priority: ${PRIORITY_LABEL[Number(before.priority)]} → ${PRIORITY_LABEL[Number(b.priority)]}`, kind: "priority" });
      }
      if (b.status !== undefined && before.status !== b.status) {
        lines.push({ verb: "Status", detail: `Status: ${STATUS_LABEL[before.status as string]} → ${STATUS_LABEL[String(b.status)]}`, kind: "status" });
      }
      if (b.assigneeId !== undefined && before.assigneeId !== (b.assigneeId || null)) {
        lines.push({
          verb: "Assigned",
          detail: `Assignee: ${oldAssigneeName ?? "unassigned"} → ${newAssigneeName ?? "unassigned"}`,
          kind: "assign",
        });
      }
      if (b.dueAt !== undefined) {
        const beforeIso = before.dueAt ? new Date(String(before.dueAt)).toISOString() : null;
        const afterIso  = b.dueAt ? new Date(String(b.dueAt)).toISOString() : null;
        if (beforeIso !== afterIso) {
          lines.push({ verb: "Due", detail: `Due: ${fmtDate(before.dueAt)} → ${fmtDate(b.dueAt)}`, kind: "due" });
        }
      }
      if (b.remindAt !== undefined) {
        const beforeIso = before.remindAt ? new Date(String(before.remindAt)).toISOString() : null;
        const afterIso  = b.remindAt ? new Date(String(b.remindAt)).toISOString() : null;
        if (beforeIso !== afterIso) {
          lines.push({ verb: "Reminder", detail: `Reminder: ${fmtDate(before.remindAt)} → ${fmtDate(b.remindAt)}`, kind: "remind" });
        }
      }

      // Write one activity row per change so the timeline reads cleanly.
      for (let i = 0; i < lines.length; i++) {
        const L = lines[i]!;
        await db.execute(sql`
          INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
          VALUES (
            current_tenant(), ${wiId}, ${partyId},
            'user', ${actorPartyId}, 'You', ${L.verb}, ${L.detail}, 'you',
            ${JSON.stringify({ when: "Just now", kind: L.kind })}::jsonb,
            NOW() + (${i} || ' milliseconds')::interval
          )
        `);
      }

      return { kind: "ok" as const };
    });

    if (result.kind === "not-found") return res.status(404).json({ error: "Case not found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── POST /cases/:idOrNumber/comments — add a comment ─────────────────────

casesRouter.post("/:idOrNumber/comments", async (req, res, next) => {
  try {
    const { idOrNumber } = req.params;
    const lookupIsUuid = isUuid(idOrNumber);
    const text = String(req.body?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "text required" });

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const r = await db.execute(
        lookupIsUuid
          ? sql`SELECT id, party_id AS "partyId" FROM work_item WHERE id = ${idOrNumber} AND type = 'support_case'`
          : sql`SELECT id, party_id AS "partyId" FROM work_item WHERE number = ${idOrNumber} AND type = 'support_case'`,
      );
      if (!r.rows[0]) return null;
      const wiId = (r.rows[0] as { id: string }).id;
      const partyId = (r.rows[0] as { partyId: string | null }).partyId;
      const ins = await db.execute(sql`
        INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
        VALUES (current_tenant(), ${wiId}, ${partyId}, 'user', ${actorPartyId}, 'You', 'Comment', ${text}, 'you',
                ${JSON.stringify({ when: "Just now", kind: "comment" })}::jsonb, NOW())
        RETURNING id
      `);
      return ins.rows[0] as { id: string };
    });
    if (!result) return res.status(404).json({ error: "Case not found" });
    res.status(201).json({ ok: true, id: result.id });
  } catch (err) {
    next(err);
  }
});

// ─── POST /cases/:idOrNumber/close — resolution required ──────────────────

casesRouter.post("/:idOrNumber/close", async (req, res, next) => {
  try {
    const { idOrNumber } = req.params;
    const lookupIsUuid = isUuid(idOrNumber);
    const resolution = String(req.body?.resolution ?? "").trim();
    const resolutionCode = req.body?.resolutionCode ? String(req.body.resolutionCode) : "fixed";

    if (!resolution) return res.status(400).json({ error: "resolution is required to close a case" });
    if (!RES_CODES.includes(resolutionCode as typeof RES_CODES[number])) {
      return res.status(400).json({ error: "invalid resolutionCode" });
    }

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const r = await db.execute(
        lookupIsUuid
          ? sql`
              SELECT wi.id, wi.number, wi.party_id AS "partyId", t.status, t.subject
              FROM work_item wi JOIN support_case t ON t.work_item_id = wi.id
              WHERE wi.id = ${idOrNumber} AND wi.type = 'support_case'
            `
          : sql`
              SELECT wi.id, wi.number, wi.party_id AS "partyId", t.status, t.subject
              FROM work_item wi JOIN support_case t ON t.work_item_id = wi.id
              WHERE wi.number = ${idOrNumber} AND wi.type = 'support_case'
            `,
      );
      if (!r.rows[0]) return { kind: "not-found" as const };
      const row = r.rows[0] as { id: string; number: string; partyId: string | null; status: string; subject: string };
      if (row.status === "closed") return { kind: "already-closed" as const };
      if (row.status === "cancelled") return { kind: "cancelled" as const };

      await db.execute(sql`
        UPDATE support_case
        SET status = 'closed',
            resolution = ${resolution},
            resolution_code = ${resolutionCode},
            resolved_at = COALESCE(resolved_at, NOW()),
            closed_at = NOW()
        WHERE work_item_id = ${row.id}
      `);
      await db.execute(sql`UPDATE work_item SET state = 'closed_won' WHERE id = ${row.id}`);

      await db.execute(sql`
        INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
        VALUES (current_tenant(), ${row.id}, ${row.partyId}, 'user', ${actorPartyId}, 'You', 'Closed',
                ${resolution}, 'you',
                ${JSON.stringify({ when: "Just now", kind: "close", resolutionCode })}::jsonb, NOW())
      `);

      // Audit log
      await db.execute(sql`
        INSERT INTO audit_log (tenant_id, actor_type, actor_party_id, action, target_type, target_id, context)
        VALUES (current_tenant(), 'user', ${actorPartyId}, 'case_closed', 'support_case', ${row.id},
                ${JSON.stringify({ resolutionCode })}::jsonb)
      `);

      // Fetch the closer's name (req.userId set by auth middleware) so the
      // Slack notification can show who closed it.
      let closedByName: string | null = null;
      if (req.userId) {
        const u = await db.execute(sql`SELECT name FROM app_user WHERE id = ${req.userId}`);
        closedByName = (u.rows[0] as { name: string } | undefined)?.name ?? null;
      }

      return {
        kind: "ok" as const,
        caseId: row.id,
        number: row.number,
        subject: row.subject,
        closedByName,
      };
    });

    if (result.kind === "not-found")      return res.status(404).json({ error: "Case not found" });
    if (result.kind === "already-closed") return res.status(409).json({ error: "Case is already closed" });
    if (result.kind === "cancelled")      return res.status(409).json({ error: "Cancelled cases cannot be closed" });

    // Fire Slack notification post-commit. Never throws.
    await emitEvent({
      type: "case.closed",
      tenantId: req.tenantId!,
      occurredAt: new Date().toISOString(),
      context: {
        caseId: result.caseId,
        number: result.number,
        subject: result.subject,
        resolution,
        resolutionCode,
        closedByName: result.closedByName,
      },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── POST /cases/:idOrNumber/reopen ───────────────────────────────────────

casesRouter.post("/:idOrNumber/reopen", async (req, res, next) => {
  try {
    const { idOrNumber } = req.params;
    const lookupIsUuid = isUuid(idOrNumber);

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const r = await db.execute(
        lookupIsUuid
          ? sql`
              SELECT wi.id, wi.party_id AS "partyId", t.status
              FROM work_item wi JOIN support_case t ON t.work_item_id = wi.id
              WHERE wi.id = ${idOrNumber} AND wi.type = 'support_case'
            `
          : sql`
              SELECT wi.id, wi.party_id AS "partyId", t.status
              FROM work_item wi JOIN support_case t ON t.work_item_id = wi.id
              WHERE wi.number = ${idOrNumber} AND wi.type = 'support_case'
            `,
      );
      if (!r.rows[0]) return { kind: "not-found" as const };
      const row = r.rows[0] as { id: string; partyId: string | null; status: string };
      if (!["closed", "resolved"].includes(row.status)) return { kind: "not-closed" as const };

      // We keep `resolution` in place for history — the constraint only fires
      // when status='closed'. Clearing closed_at lets the dashboard re-count it.
      await db.execute(sql`
        UPDATE support_case
        SET status = 'in_progress', closed_at = NULL, resolved_at = NULL
        WHERE work_item_id = ${row.id}
      `);
      await db.execute(sql`UPDATE work_item SET state = 'in_progress' WHERE id = ${row.id}`);

      await db.execute(sql`
        INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
        VALUES (current_tenant(), ${row.id}, ${row.partyId}, 'user', ${actorPartyId}, 'You', 'Reopened',
                ${`Status: ${STATUS_LABEL[row.status]} → In progress`}, 'you',
                ${JSON.stringify({ when: "Just now", kind: "reopen" })}::jsonb, NOW())
      `);

      return { kind: "ok" as const };
    });

    if (result.kind === "not-found")  return res.status(404).json({ error: "Case not found" });
    if (result.kind === "not-closed") return res.status(409).json({ error: "Only closed/resolved cases can be reopened" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
