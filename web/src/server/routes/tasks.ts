// Lead tasks — the scheduled work an advisor owes a lead.
//
// This is what the Leads > Calendar view reads, and what the Activity panel on
// the record page writes. See post-0073-lead-task.sql for why this isn't just
// an `activity` row: `activity` is a past-tense feed with no due date, status
// or owner, so a follow-up booked for Friday was previously unqueryable.
//
// Every mutation ALSO writes a mirror row into `activity`, so the record-page
// timeline picks tasks up for free — the same trick leads.ts uses for notes
// and comms.
//
// Wire convention (matches leads.ts): assignees travel as app_user.id, but
// assignee_party_id stores party.id. Resolve at the boundary, never leak
// party ids to the client.

import { Router } from "@/server/http";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";
import { partyIdFromAppUserId, resolveActorPartyId } from "../lib/party/resolve";

export const tasksRouter = Router();

const KINDS = new Set([
  "follow_up", "call", "demo", "campus_visit",
  "trainer_talk", "enrollment", "re_engage", "task",
]);
const STATUSES = new Set(["open", "done", "cancelled"]);

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

// Human labels for the mirrored timeline row, so the record page reads
// "Demo scheduled" rather than "demo".
const KIND_LABEL: Record<string, string> = {
  follow_up:    "Follow-up",
  call:         "Call",
  demo:         "Demo",
  campus_visit: "Campus visit",
  trainer_talk: "Trainer talk",
  enrollment:   "Enrollment",
  re_engage:    "Re-engage",
  task:         "Task",
};

/** Resolve `:idOrNumber` (uuid or LEAD-1234) to a lead's work_item row. */
async function resolveLead(db: Parameters<Parameters<typeof withTenant>[1]>[0], idOrNumber: string) {
  const r = await db.execute(
    UUID_RE.test(idOrNumber)
      ? sql`SELECT id, party_id FROM work_item WHERE id = ${idOrNumber} AND type = 'lead'`
      : sql`SELECT id, party_id FROM work_item WHERE number = ${idOrNumber} AND type = 'lead'`,
  );
  return (r.rows[0] as { id: string; party_id: string } | undefined) ?? null;
}

// The task shape every endpoint returns. Joined against the lead so the
// calendar can render "Kavya · Visit 6:00p" without a second round-trip.
const TASK_SELECT = sql`
  SELECT
    t.id,
    t.kind,
    t.title,
    t.notes,
    t.due_at        AS "dueAt",
    t.all_day       AS "allDay",
    t.duration_min  AS "durationMin",
    t.status,
    t.completed_at  AS "completedAt",
    t.created_at    AS "createdAt",
    wi.id           AS "leadId",
    wi.number       AS "leadNumber",
    p.name          AS "leadName",
    au.id           AS "assigneeId",     -- app_user.id for wire compat
    au.name         AS "assigneeName"
  FROM lead_task t
  JOIN work_item wi ON wi.id = t.work_item_id
  JOIN party p      ON p.id  = wi.party_id
  LEFT JOIN app_user au ON au.party_id = t.assignee_party_id
`;

// ─── GET /tasks — list, with the calendar's date-window as the hot path ───
//
// ?from=&to=   inclusive date window (YYYY-MM-DD), resolved against due_at
// ?lead=       uuid or LEAD-number — the record page's Activity panel
// ?status=     open | done | cancelled
// ?kind=       one of KINDS
// ?assignee=   app_user.id
tasksRouter.get("/", async (req, res, next) => {
  try {
    const from     = req.query.from     ? String(req.query.from)     : null;
    const to       = req.query.to       ? String(req.query.to)       : null;
    const lead     = req.query.lead     ? String(req.query.lead)     : null;
    const status   = req.query.status   ? String(req.query.status)   : null;
    const kind     = req.query.kind     ? String(req.query.kind)     : null;
    const assignee = req.query.assignee ? String(req.query.assignee) : null;

    if (status && !STATUSES.has(status)) return res.status(400).json({ error: "bad status" });
    if (kind && !KINDS.has(kind))        return res.status(400).json({ error: "bad kind" });

    const tasks = await withTenant(req.tenantId!, async (db) => {
      // Each filter is an optional AND-fragment. `sql.empty()`-style no-ops
      // keep the query one statement instead of a string-built mess.
      let where = sql`WHERE TRUE`;

      // Window is half-open on the right: `< to + 1 day` so a task due at
      // 23:59 on the last day of the month is still inside the month.
      if (from && to) {
        where = sql`${where} AND t.due_at >= ${from}::date
                             AND t.due_at <  (${to}::date + INTERVAL '1 day')`;
      }
      if (lead) {
        const wi = await resolveLead(db, lead);
        if (!wi) return null;
        where = sql`${where} AND t.work_item_id = ${wi.id}`;
      }
      if (status) where = sql`${where} AND t.status = ${status}`;
      if (kind)   where = sql`${where} AND t.kind = ${kind}`;
      if (assignee) {
        const partyId = await partyIdFromAppUserId(db, assignee);
        // An assignee filter for a user with no party record matches nothing —
        // that's correct, and better than silently ignoring the filter.
        where = sql`${where} AND t.assignee_party_id = ${partyId ?? null}`;
      }

      const r = await db.execute(sql`${TASK_SELECT} ${where} ORDER BY t.due_at ASC`);
      return r.rows;
    });

    // `null` means the ?lead= didn't resolve — an empty list would read as
    // "this lead has no tasks", which is a different thing.
    if (tasks === null) return res.status(404).json({ error: "Lead not found" });
    res.json({ tasks });
  } catch (err) {
    next(err);
  }
});

// ─── POST /tasks — schedule something against a lead ─────────────────────
tasksRouter.post("/", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const lead  = String(b.lead ?? b.leadId ?? b.leadNumber ?? "").trim();
    const kind  = String(b.kind ?? "follow_up").trim();
    const title = String(b.title ?? "").trim();
    const notes = b.notes ? String(b.notes).trim() : null;
    const allDay = !!b.allDay;
    const durationMin = b.durationMin == null ? null : Number(b.durationMin);
    const dueAt = b.dueAt ? new Date(String(b.dueAt)) : null;

    if (!lead)  return res.status(400).json({ error: "lead required" });
    if (!title) return res.status(400).json({ error: "title required" });
    if (!KINDS.has(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${[...KINDS].join(", ")}` });
    }
    if (!dueAt || Number.isNaN(dueAt.getTime())) {
      return res.status(400).json({ error: "dueAt required (ISO timestamp)" });
    }
    if (durationMin !== null && (!Number.isFinite(durationMin) || durationMin < 1 || durationMin > 1440)) {
      return res.status(400).json({ error: "durationMin must be 1..1440" });
    }

    const actorName = req.user?.name?.trim() || "You";
    const actorId   = req.userId ?? null;

    const out = await withTenant(req.tenantId!, async (db) => {
      const wi = await resolveLead(db, lead);
      if (!wi) return null;

      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, actorId);

      // Assignee defaults to the lead's advisor — a task nobody owns is a task
      // nobody does. Falls back to the caller when the lead is unassigned.
      let assigneePartyId: string | null = null;
      if (b.assigneeId) {
        assigneePartyId = await partyIdFromAppUserId(db, String(b.assigneeId));
      } else {
        const adv = await db.execute(sql`
          SELECT advisor_id FROM lead WHERE work_item_id = ${wi.id}
        `);
        assigneePartyId = (adv.rows[0] as { advisor_id: string | null } | undefined)?.advisor_id
          ?? actorPartyId;
      }

      const ins = await db.execute(sql`
        INSERT INTO lead_task (
          tenant_id, work_item_id, kind, title, notes,
          due_at, all_day, duration_min, assignee_party_id, created_by_party_id
        )
        VALUES (
          current_tenant(), ${wi.id}, ${kind}, ${title}, ${notes},
          ${dueAt.toISOString()}, ${allDay}, ${durationMin},
          ${assigneePartyId}, ${actorPartyId}
        )
        RETURNING id
      `);
      const taskId = (ins.rows[0] as { id: string }).id;

      // Mirror into the timeline so the record page shows it with no changes.
      await db.execute(sql`
        INSERT INTO activity (
          tenant_id, work_item_id, party_id, actor_type, actor_party_id,
          actor_name, verb, detail, tag, payload, ts
        )
        VALUES (
          current_tenant(), ${wi.id}, ${wi.party_id}, 'user', ${actorPartyId},
          ${actorName}, ${`${KIND_LABEL[kind] ?? "Task"} scheduled`},
          ${title}, 'you',
          ${JSON.stringify({
            kind: "task",
            taskKind: kind,
            taskId,
            scheduledAt: dueAt.toISOString(),
            byUserId: actorId,
          })}::jsonb,
          NOW()
        )
      `);

      const r = await db.execute(sql`${TASK_SELECT} WHERE t.id = ${taskId}`);
      return r.rows[0];
    });

    if (!out) return res.status(404).json({ error: "Lead not found" });
    res.status(201).json({ ok: true, task: out });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /tasks/:id — edit, reschedule, complete ───────────────────────
//
// Also the endpoint the calendar uses to drag a chip to another day: a lone
// { dueAt } patch is a reschedule.
tasksRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "invalid task id" });
    const b = req.body ?? {};

    if (b.kind !== undefined && !KINDS.has(String(b.kind))) {
      return res.status(400).json({ error: `kind must be one of: ${[...KINDS].join(", ")}` });
    }
    if (b.status !== undefined && !STATUSES.has(String(b.status))) {
      return res.status(400).json({ error: "status must be open | done | cancelled" });
    }
    let dueAtIso: string | null = null;
    if (b.dueAt !== undefined) {
      const d = new Date(String(b.dueAt));
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: "dueAt must be an ISO timestamp" });
      dueAtIso = d.toISOString();
    }

    const actorName = req.user?.name?.trim() || "You";
    const actorId   = req.userId ?? null;

    const out = await withTenant(req.tenantId!, async (db) => {
      const existing = await db.execute(sql`
        SELECT t.id, t.status, t.title, t.kind, t.work_item_id, wi.party_id
        FROM lead_task t JOIN work_item wi ON wi.id = t.work_item_id
        WHERE t.id = ${id}
      `);
      const prev = existing.rows[0] as
        | { id: string; status: string; title: string; kind: string; work_item_id: string; party_id: string }
        | undefined;
      if (!prev) return null;

      // assigneeId travels as app_user.id; `null` explicitly unassigns.
      let assigneeSet = sql``;
      if (b.assigneeId !== undefined) {
        const partyId = b.assigneeId ? await partyIdFromAppUserId(db, String(b.assigneeId)) : null;
        assigneeSet = sql`, assignee_party_id = ${partyId}`;
      }

      const nextStatus = b.status !== undefined ? String(b.status) : null;

      await db.execute(sql`
        UPDATE lead_task SET
          kind         = COALESCE(${b.kind ?? null}, kind),
          title        = COALESCE(${b.title ?? null}, title),
          notes        = ${b.notes !== undefined ? (b.notes ? String(b.notes) : null) : sql`notes`},
          due_at       = COALESCE(${dueAtIso}, due_at),
          all_day      = COALESCE(${b.allDay ?? null}, all_day),
          duration_min = ${b.durationMin !== undefined
                            ? (b.durationMin == null ? null : Number(b.durationMin))
                            : sql`duration_min`},
          status       = COALESCE(${nextStatus}, status),
          -- completed_at tracks status: set on the open→done edge, cleared if
          -- the task is reopened, untouched otherwise.
          completed_at = CASE
                           WHEN ${nextStatus}::text = 'done' THEN COALESCE(completed_at, NOW())
                           WHEN ${nextStatus}::text IN ('open','cancelled') THEN NULL
                           ELSE completed_at
                         END,
          updated_at   = NOW()
          ${assigneeSet}
        WHERE id = ${id}
      `);

      // Completing a task is a timeline-worthy event; a silent field edit isn't.
      if (nextStatus === "done" && prev.status !== "done") {
        const actorPartyId = await resolveActorPartyId(db, req.tenantId!, actorId);
        await db.execute(sql`
          INSERT INTO activity (
            tenant_id, work_item_id, party_id, actor_type, actor_party_id,
            actor_name, verb, detail, tag, payload, ts
          )
          VALUES (
            current_tenant(), ${prev.work_item_id}, ${prev.party_id}, 'user', ${actorPartyId},
            ${actorName}, ${`${KIND_LABEL[prev.kind] ?? "Task"} completed`},
            ${prev.title}, 'you',
            ${JSON.stringify({ kind: "task_done", taskKind: prev.kind, taskId: id, byUserId: actorId })}::jsonb,
            NOW()
          )
        `);
      }

      const r = await db.execute(sql`${TASK_SELECT} WHERE t.id = ${id}`);
      return r.rows[0];
    });

    if (!out) return res.status(404).json({ error: "Task not found" });
    res.json({ ok: true, task: out });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /tasks/:id ───────────────────────────────────────────────────
//
// A hard delete. The mirrored `activity` rows stay — the timeline is a record
// of what happened, and "we scheduled a demo then dropped it" is history, not
// noise. Cancelling (PATCH status=cancelled) is the softer option.
tasksRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "invalid task id" });
    const gone = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`DELETE FROM lead_task WHERE id = ${id} RETURNING id`);
      return r.rows.length > 0;
    });
    if (!gone) return res.status(404).json({ error: "Task not found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
