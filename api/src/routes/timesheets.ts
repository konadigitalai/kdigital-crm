// Timesheets — clock-in/out, the 1-hour grid, block CRUD.
//
// Day-boundary policy: the "date" column on work_session and time_block uses
// the IST date the work happened on. We compute it server-side from clock_in.
// All times are stored as UTC (timestamptz) and rendered in IST on the web.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { requirePermission, requireAnyPermission } from "../middleware/require.js";

export const timesheetsRouter = Router();

// IST = UTC + 5:30. Returns YYYY-MM-DD as the "working day" for an instant.
function istDateString(when: Date): string {
  const istMs = when.getTime() + (5 * 60 + 30) * 60_000;
  return new Date(istMs).toISOString().slice(0, 10);
}

// Render an ISO timestamp as "HH:MM" in IST — used in user-facing error
// messages so overlap conflicts cite a real time the user can find.
function fmtClock(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  const ist = new Date(d.getTime() + (5 * 60 + 30) * 60_000);
  return ist.toISOString().slice(11, 16);
}

// Conflict shape returned with 409s so the UI can render an inline "edit the
// existing block" pane instead of just showing a toast.
interface ConflictRow {
  id: string;
  startAt: string;
  endAt: string;
  clientId: string | null;
  clientName: string | null;
  note: string | null;
}

// Generate 1-hour-aligned blocks between [from, to). Top-of-hour boundaries.
// Examples:
//   09:30 → 18:30 = 9:30-10, 10-11, 11-12, …, 18-18:30
//   14:00 → 14:30 = 14:00-14:30 (single short block)
function generateBlocks(from: Date, to: Date): Array<{ startAt: Date; endAt: Date }> {
  if (to <= from) return [];
  const blocks: Array<{ startAt: Date; endAt: Date }> = [];
  let cursor = new Date(from);
  while (cursor < to) {
    // Next top-of-hour relative to cursor.
    const nextHour = new Date(cursor);
    nextHour.setUTCMinutes(0, 0, 0);
    nextHour.setUTCHours(nextHour.getUTCHours() + 1);
    const slotEnd = nextHour <= to ? nextHour : to;
    if (slotEnd > cursor) {
      blocks.push({ startAt: new Date(cursor), endAt: new Date(slotEnd) });
    }
    cursor = slotEnd;
  }
  return blocks;
}

// ─── Clock-in ────────────────────────────────────────────────────────────
timesheetsRouter.post("/clock-in", requirePermission("timesheets.read.self"), async (req, res, next) => {
  try {
    const now = new Date();
    const date = istDateString(now);
    const out = await withTenant(req.tenantId!, async (db) => {
      // Refuse if a session is already open.
      const open = await db.execute(sql`
        SELECT id FROM work_session WHERE user_id = ${req.userId} AND clock_out IS NULL
      `);
      if (open.rows.length > 0) {
        return { error: "already_open", id: (open.rows[0] as { id: string }).id };
      }
      const r = await db.execute(sql`
        INSERT INTO work_session (tenant_id, user_id, date, clock_in)
        VALUES (${req.tenantId}, ${req.userId}, ${date}, ${now.toISOString()})
        RETURNING id, date, clock_in AS "clockIn", clock_out AS "clockOut", notes
      `);
      return { session: r.rows[0] };
    });
    if ("error" in out) {
      return res.status(409).json({ error: "Already clocked in", sessionId: out.id });
    }
    res.status(201).json({ session: out.session });
  } catch (err) {
    next(err);
  }
});

// ─── Clock-out + auto grid generation ─────────────────────────────────────
timesheetsRouter.post("/clock-out", requirePermission("timesheets.read.self"), async (req, res, next) => {
  try {
    const now = new Date();
    const notes = req.body?.notes ? String(req.body.notes) : null;
    const out = await withTenant(req.tenantId!, async (db) => {
      const sessR = await db.execute(sql`
        SELECT id, date, clock_in AS "clockIn"
        FROM work_session
        WHERE user_id = ${req.userId} AND clock_out IS NULL
        LIMIT 1
      `);
      const sess = sessR.rows[0] as { id: string; date: string; clockIn: Date } | undefined;
      if (!sess) return { error: "no_open" };
      const sessionId = sess.id;
      const clockIn = new Date(sess.clockIn);

      // Close the session.
      await db.execute(sql`
        UPDATE work_session SET
          clock_out = ${now.toISOString()},
          notes = COALESCE(${notes}, notes)
        WHERE id = ${sessionId}
      `);

      // Generate the 1-hour-aligned grid. Inserts blocks only for time that
      // doesn't already overlap with an existing block (so re-running the
      // clock-out flow after manual adjustments doesn't trample edits).
      const blocks = generateBlocks(clockIn, now);
      const inserted: Array<{ id: string; startAt: string; endAt: string }> = [];
      for (const b of blocks) {
        // Skip if any existing block overlaps this slot for this user.
        const overlap = await db.execute(sql`
          SELECT 1 FROM time_block
          WHERE user_id = ${req.userId}
            AND start_at < ${b.endAt.toISOString()}
            AND end_at   > ${b.startAt.toISOString()}
          LIMIT 1
        `);
        if (overlap.rows.length > 0) continue;
        const r = await db.execute(sql`
          INSERT INTO time_block (
            tenant_id, user_id, session_id, date, start_at, end_at, billable
          ) VALUES (
            ${req.tenantId}, ${req.userId}, ${sessionId}, ${sess.date},
            ${b.startAt.toISOString()}, ${b.endAt.toISOString()}, true
          )
          RETURNING id, start_at AS "startAt", end_at AS "endAt"
        `);
        const row = r.rows[0] as { id: string; startAt: string; endAt: string };
        inserted.push({
          id: row.id,
          startAt: new Date(row.startAt).toISOString(),
          endAt: new Date(row.endAt).toISOString(),
        });
      }

      return { sessionId, inserted };
    });
    if ("error" in out) return res.status(409).json({ error: "Not clocked in" });
    res.json({ ok: true, sessionId: out.sessionId, blocks: out.inserted });
  } catch (err) {
    next(err);
  }
});

// ─── GET /timesheets/today ───────────────────────────────────────────────
timesheetsRouter.get("/today", requirePermission("timesheets.read.self"), async (req, res, next) => {
  try {
    const today = istDateString(new Date());
    const userId = req.userId!;
    const data = await withTenant(req.tenantId!, async (db) => {
      const sessR = await db.execute(sql`
        SELECT id, date, clock_in AS "clockIn", clock_out AS "clockOut", notes
        FROM work_session
        WHERE user_id = ${userId} AND date = ${today}
        ORDER BY clock_in DESC
        LIMIT 1
      `);
      const blocksR = await db.execute(sql`
        SELECT
          b.id, b.session_id AS "sessionId", b.date,
          b.start_at AS "startAt", b.end_at AS "endAt",
          b.client_id AS "clientId", c.name AS "clientName",
          b.note, b.billable
        FROM time_block b
        LEFT JOIN client c ON c.id = b.client_id
        WHERE b.user_id = ${userId} AND b.date = ${today}
        ORDER BY b.start_at
      `);
      return {
        session: sessR.rows[0] ?? null,
        blocks: blocksR.rows,
      };
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ─── GET /timesheets/range ───────────────────────────────────────────────
// Default: own data. Admin (timesheets.read.all) can pass ?userId=… to view another user.
timesheetsRouter.get(
  "/range",
  requireAnyPermission("timesheets.read.self", "timesheets.read.all"),
  async (req, res, next) => {
    try {
      const from = String(req.query.from ?? "");
      const to = String(req.query.to ?? "");
      const targetUserId = req.query.userId ? String(req.query.userId) : req.userId!;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return res.status(400).json({ error: "from/to must be YYYY-MM-DD" });
      }
      if (targetUserId !== req.userId && !req.permissions?.has("timesheets.read.all")) {
        return res.status(403).json({ error: "Cannot read another user's timesheet" });
      }

      const data = await withTenant(req.tenantId!, async (db) => {
        const sessions = await db.execute(sql`
          SELECT id, user_id AS "userId", date,
                 clock_in AS "clockIn", clock_out AS "clockOut", notes
          FROM work_session
          WHERE user_id = ${targetUserId} AND date BETWEEN ${from} AND ${to}
          ORDER BY date, clock_in
        `);
        const blocks = await db.execute(sql`
          SELECT
            b.id, b.session_id AS "sessionId", b.user_id AS "userId", b.date,
            b.start_at AS "startAt", b.end_at AS "endAt",
            b.client_id AS "clientId", c.name AS "clientName",
            b.note, b.billable
          FROM time_block b
          LEFT JOIN client c ON c.id = b.client_id
          WHERE b.user_id = ${targetUserId} AND b.date BETWEEN ${from} AND ${to}
          ORDER BY b.date, b.start_at
        `);
        const leaves = await db.execute(sql`
          SELECT id, user_id AS "userId", date, kind, half_day AS "halfDay", note
          FROM leave_day
          WHERE user_id = ${targetUserId} AND date BETWEEN ${from} AND ${to}
          ORDER BY date
        `);
        return {
          sessions: sessions.rows,
          blocks: blocks.rows,
          leaves: leaves.rows,
        };
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /timesheets/report ──────────────────────────────────────────────
// Admin pivot view of every user's blocks in a date range. Returns:
//   { rows:  [{ userId, userName, clientId, clientName, date, mins }], total }
// Hours are summed per (user, client, date) — the UI pivots / drills further.
timesheetsRouter.get("/report", requirePermission("timesheets.read.all"), async (req, res, next) => {
  try {
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: "from/to must be YYYY-MM-DD" });
    }
    const userIds = parseIdList(req.query.userIds);
    const clientIds = parseIdList(req.query.clientIds);

    const rows = await withTenant(req.tenantId!, async (db) => {
      const userFilter = userIds.length === 0
        ? sql``
        : sql`AND b.user_id = ANY(${uuidArrayLiteral(userIds)})`;
      const clientFilter = clientIds.length === 0
        ? sql``
        : sql`AND b.client_id = ANY(${uuidArrayLiteral(clientIds)})`;
      const r = await db.execute(sql`
        SELECT
          b.user_id   AS "userId",
          u.name      AS "userName",
          u.email     AS "userEmail",
          b.client_id AS "clientId",
          c.name      AS "clientName",
          b.date,
          ROUND(SUM(EXTRACT(EPOCH FROM (b.end_at - b.start_at)) / 60))::int AS mins,
          COUNT(*)::int AS blocks
        FROM time_block b
        JOIN app_user u ON u.id = b.user_id
        LEFT JOIN client c ON c.id = b.client_id
        WHERE b.date BETWEEN ${from}::date AND ${to}::date
          ${userFilter}
          ${clientFilter}
        GROUP BY b.user_id, u.name, u.email, b.client_id, c.name, b.date
        ORDER BY u.name, b.date, c.name NULLS LAST
      `);
      return r.rows;
    });
    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

function parseIdList(q: unknown): string[] {
  if (!q) return [];
  const s = Array.isArray(q) ? q.join(",") : String(q);
  return s.split(",").map((x) => x.trim()).filter((x) => /^[0-9a-fA-F-]{36}$/.test(x));
}

// Render a JS string[] of UUIDs as `ARRAY['…','…',…]::uuid[]` so Drizzle's
// parameterised `${arr}` doesn't get coerced into a record tuple. Each element
// is still individually parameter-bound — input is already validated as UUIDs
// by parseIdList, so injection isn't possible either way.
function uuidArrayLiteral(ids: string[]) {
  if (ids.length === 0) return sql`ARRAY[]::uuid[]`;
  const parts = ids.map((id) => sql`${id}::uuid`);
  return sql`ARRAY[${sql.join(parts, sql`, `)}]::uuid[]`;
}

// ─── Block CRUD ──────────────────────────────────────────────────────────

timesheetsRouter.patch("/blocks/:id", requirePermission("timesheets.read.self"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const b = req.body ?? {};
    const updated = await withTenant(req.tenantId!, async (db) => {
      // Pull the current row so we can validate before/after times against it.
      const cur = await db.execute(sql`
        SELECT user_id, start_at, end_at FROM time_block WHERE id = ${id}
      `);
      const curRow = cur.rows[0] as { user_id: string; start_at: string; end_at: string } | undefined;
      if (!curRow) return { kind: "not-found" as const };
      if (curRow.user_id !== req.userId && !req.permissions?.has("timesheets.read.all")) {
        return { kind: "forbidden" as const };
      }

      // Build the patch. Only fields *present* on the body are touched —
      // explicit nulls clear them, undefined leaves them alone. (The previous
      // COALESCE-everything approach made it impossible to clear a client or
      // empty out a note from the UI.)
      const sets: ReturnType<typeof sql>[] = [];

      if ("clientId" in b) {
        const cid = b.clientId ? String(b.clientId).trim() : null;
        sets.push(sql`client_id = ${cid}`);
      }
      if ("note" in b) {
        const note = b.note ? String(b.note) : null;
        sets.push(sql`note = ${note}`);
      }
      if ("billable" in b) {
        sets.push(sql`billable = ${Boolean(b.billable)}`);
      }

      // Time edits: only valid as a pair, must be sane, and must not overlap
      // any *other* block belonging to the same user. Also recompute `date`
      // from the new start (IST) so the weekly roll-up stays correct.
      let nextStart: Date | null = null;
      let nextEnd: Date | null = null;
      if ("startAt" in b || "endAt" in b) {
        nextStart = b.startAt ? new Date(String(b.startAt)) : new Date(curRow.start_at);
        nextEnd   = b.endAt   ? new Date(String(b.endAt))   : new Date(curRow.end_at);
        if (isNaN(nextStart.getTime()) || isNaN(nextEnd.getTime()) || nextEnd <= nextStart) {
          return { kind: "bad-times" as const };
        }
        const overlap = await db.execute(sql`
          SELECT b.id, b.start_at AS "startAt", b.end_at AS "endAt",
                 b.client_id AS "clientId", c.name AS "clientName", b.note
          FROM time_block b
          LEFT JOIN client c ON c.id = b.client_id
          WHERE b.user_id = ${curRow.user_id}
            AND b.id <> ${id}
            AND b.start_at < ${nextEnd.toISOString()}
            AND b.end_at   > ${nextStart.toISOString()}
          LIMIT 1
        `);
        if (overlap.rows.length > 0) {
          return { kind: "overlap" as const, conflict: overlap.rows[0] as unknown as ConflictRow };
        }
        sets.push(sql`start_at = ${nextStart.toISOString()}`);
        sets.push(sql`end_at   = ${nextEnd.toISOString()}`);
        sets.push(sql`date     = ${istDateString(nextStart)}`);
      }

      if (sets.length === 0) {
        return { kind: "no-op" as const };
      }
      const setClause = sql.join(sets, sql`, `);
      await db.execute(sql`UPDATE time_block SET ${setClause} WHERE id = ${id}`);
      const r = await db.execute(sql`
        SELECT id, session_id AS "sessionId", date,
               start_at AS "startAt", end_at AS "endAt",
               client_id AS "clientId", note, billable
        FROM time_block WHERE id = ${id}
      `);
      return { kind: "ok" as const, block: r.rows[0] };
    });
    if (updated.kind === "not-found") return res.status(404).json({ error: "Block not found" });
    if (updated.kind === "forbidden") return res.status(403).json({ error: "Not your block" });
    if (updated.kind === "bad-times") return res.status(400).json({ error: "End must be after start" });
    if (updated.kind === "overlap") {
      const c = updated.conflict;
      return res.status(409).json({
        error: `Overlaps an existing block (${fmtClock(c.startAt)}–${fmtClock(c.endAt)} IST). Adjust or delete it first.`,
        conflict: c,
      });
    }
    if (updated.kind === "no-op") return res.status(400).json({ error: "Nothing to update" });
    res.json({ block: updated.block });
  } catch (err) {
    next(err);
  }
});

timesheetsRouter.post("/blocks/:id/split", requirePermission("timesheets.read.self"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const at = req.body?.atISO ? new Date(String(req.body.atISO)) : null;
    if (!at || isNaN(at.getTime())) return res.status(400).json({ error: "atISO required" });
    const out = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT id, tenant_id, user_id, session_id, date, start_at, end_at, client_id, note, billable
        FROM time_block WHERE id = ${id}
      `);
      const orig = r.rows[0] as Record<string, unknown> | undefined;
      if (!orig) return { kind: "not-found" as const };
      if ((orig.user_id as string) !== req.userId) return { kind: "forbidden" as const };
      const start = new Date(orig.start_at as string);
      const end = new Date(orig.end_at as string);
      if (at <= start || at >= end) return { kind: "out-of-range" as const };
      // Shorten original, insert second.
      await db.execute(sql`UPDATE time_block SET end_at = ${at.toISOString()} WHERE id = ${id}`);
      const ins = await db.execute(sql`
        INSERT INTO time_block (tenant_id, user_id, session_id, date, start_at, end_at, client_id, note, billable)
        VALUES (${orig.tenant_id}, ${orig.user_id}, ${orig.session_id}, ${orig.date},
                ${at.toISOString()}, ${end.toISOString()}, ${orig.client_id}, ${orig.note}, ${orig.billable})
        RETURNING id
      `);
      return { kind: "ok" as const, originalId: id, newId: (ins.rows[0] as { id: string }).id };
    });
    if (out.kind !== "ok") {
      const code = out.kind === "not-found" ? 404 : out.kind === "forbidden" ? 403 : 400;
      return res.status(code).json({ error: out.kind });
    }
    res.json({ ok: true, originalId: out.originalId, newId: out.newId });
  } catch (err) {
    next(err);
  }
});

timesheetsRouter.post("/blocks/merge", requirePermission("timesheets.read.self"), async (req, res, next) => {
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length < 2) return res.status(400).json({ error: "Need at least 2 ids" });
    const out = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT id, user_id, session_id, date, start_at, end_at, client_id, note, billable
        FROM time_block
        WHERE id = ANY(${ids}::uuid[])
        ORDER BY start_at
      `);
      const rows = r.rows as Array<Record<string, unknown>>;
      if (rows.length !== ids.length) return { kind: "missing" as const };
      // All same user; all contiguous.
      const userId = rows[0]!.user_id as string;
      if (userId !== req.userId) return { kind: "forbidden" as const };
      for (let i = 0; i < rows.length; i++) {
        if ((rows[i]!.user_id as string) !== userId) return { kind: "mixed-users" as const };
        if (i > 0) {
          const prevEnd = new Date(rows[i - 1]!.end_at as string).getTime();
          const thisStart = new Date(rows[i]!.start_at as string).getTime();
          if (Math.abs(prevEnd - thisStart) > 60_000) return { kind: "not-contiguous" as const };
        }
      }
      // Keep the first row, extend its end_at and delete the rest.
      const firstId = rows[0]!.id as string;
      const lastEnd = rows[rows.length - 1]!.end_at as string;
      await db.execute(sql`UPDATE time_block SET end_at = ${lastEnd} WHERE id = ${firstId}`);
      const others = rows.slice(1).map((r) => r.id as string);
      if (others.length > 0) {
        await db.execute(sql`DELETE FROM time_block WHERE id = ANY(${others}::uuid[])`);
      }
      return { kind: "ok" as const, mergedId: firstId };
    });
    if (out.kind !== "ok") {
      const code = out.kind === "forbidden" ? 403 : 400;
      return res.status(code).json({ error: out.kind });
    }
    res.json({ ok: true, mergedId: out.mergedId });
  } catch (err) {
    next(err);
  }
});

// POST /timesheets/blocks — ad-hoc block insert (e.g. logging time after the fact).
timesheetsRouter.post("/blocks", requirePermission("timesheets.read.self"), async (req, res, next) => {
  try {
    const startAt = req.body?.startAt ? new Date(String(req.body.startAt)) : null;
    const endAt   = req.body?.endAt   ? new Date(String(req.body.endAt))   : null;
    const clientId = req.body?.clientId ? String(req.body.clientId) : null;
    const note = req.body?.note ? String(req.body.note) : null;
    if (!startAt || !endAt || isNaN(startAt.getTime()) || isNaN(endAt.getTime()) || endAt <= startAt) {
      return res.status(400).json({ error: "startAt and endAt required, end > start" });
    }
    if (!clientId) {
      return res.status(400).json({ error: "Pick a client for this block." });
    }
    const date = istDateString(startAt);
    const inserted = await withTenant(req.tenantId!, async (db) => {
      // No-overlap check — return the conflicting row so we can describe it.
      const overlap = await db.execute(sql`
        SELECT b.id, b.start_at AS "startAt", b.end_at AS "endAt",
               b.client_id AS "clientId", c.name AS "clientName", b.note
        FROM time_block b
        LEFT JOIN client c ON c.id = b.client_id
        WHERE b.user_id = ${req.userId}
          AND b.start_at < ${endAt.toISOString()}
          AND b.end_at   > ${startAt.toISOString()}
        LIMIT 1
      `);
      if (overlap.rows.length > 0) {
        return { kind: "overlap" as const, conflict: overlap.rows[0] as unknown as ConflictRow };
      }
      const r = await db.execute(sql`
        INSERT INTO time_block (
          tenant_id, user_id, date, start_at, end_at, client_id, note, billable
        ) VALUES (
          ${req.tenantId}, ${req.userId}, ${date},
          ${startAt.toISOString()}, ${endAt.toISOString()},
          ${clientId}, ${note}, true
        )
        RETURNING id, date, start_at AS "startAt", end_at AS "endAt", client_id AS "clientId", note, billable
      `);
      return { kind: "ok" as const, block: r.rows[0] };
    });
    if (inserted.kind === "overlap") {
      const c = inserted.conflict;
      return res.status(409).json({
        error: `Overlaps an existing block (${fmtClock(c.startAt)}–${fmtClock(c.endAt)} IST). Pick a free slot or edit the existing one.`,
        conflict: c,
      });
    }
    res.status(201).json({ block: inserted.block });
  } catch (err) {
    next(err);
  }
});

timesheetsRouter.delete("/blocks/:id", requirePermission("timesheets.read.self"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const out = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        DELETE FROM time_block WHERE id = ${id} AND user_id = ${req.userId} RETURNING id
      `);
      return r.rows.length > 0;
    });
    if (!out) return res.status(404).json({ error: "Block not found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
