// Calendar events — in-app only. Organizer creates an event, picks invitees,
// invitees see it on their /calendar with Accept / Decline / Tentative buttons.

import { Router } from "@/server/http";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";
import { requirePermission } from "../middleware/require";
import { partyIdFromAppUserId } from "../lib/party/resolve";

export const eventsRouter = Router();

const RSVP = new Set(["pending", "accepted", "declined", "tentative"]);

// GET /events?from=&to= — events where the user is organizer OR an invitee.
eventsRouter.get("/", requirePermission("events.manage.self"), async (req, res, next) => {
  try {
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    const rows = await withTenant(req.tenantId!, async (db) => {
      // Phase 2: organizer_id / invitee user_id store party.id — resolve me.
      const mePartyId = await partyIdFromAppUserId(db, req.userId!);
      if (!mePartyId) return [];
      const inviteJoin = sql`
        LEFT JOIN calendar_invitee i ON i.event_id = e.id AND i.user_id = ${mePartyId}
        LEFT JOIN app_user uo ON uo.party_id = e.organizer_id
      `;
      // Compose a single query with optional date filters.
      const dateFilter = from && to
        ? sql`AND e.start_at < (${to}::date + INTERVAL '1 day') AND e.end_at > ${from}::date`
        : sql``;
      const r = await db.execute(sql`
        SELECT
          e.id, e.title, e.description, e.location,
          e.start_at AS "startAt", e.end_at AS "endAt",
          e.all_day AS "allDay",
          uo.id  AS "organizerId",       -- app_user.id via party_id (Phase 2)
          uo.name AS "organizerName", uo.email AS "organizerEmail",
          (e.organizer_id = ${mePartyId}) AS "isOrganizer",
          i.rsvp,
          i.responded_at AS "respondedAt"
        FROM calendar_event e
        ${inviteJoin}
        WHERE (e.organizer_id = ${mePartyId} OR i.user_id = ${mePartyId})
          ${dateFilter}
        ORDER BY e.start_at
      `);
      return r.rows;
    });
    res.json({ events: rows });
  } catch (err) {
    next(err);
  }
});

// GET /events/:id — full event with invitee list
eventsRouter.get("/:id", requirePermission("events.manage.self"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const out = await withTenant(req.tenantId!, async (db) => {
      const mePartyId = await partyIdFromAppUserId(db, req.userId!);
      if (!mePartyId) return null;
      const eR = await db.execute(sql`
        SELECT e.id, e.title, e.description, e.location,
               e.start_at AS "startAt", e.end_at AS "endAt", e.all_day AS "allDay",
               uo.id  AS "organizerId",       -- app_user.id via party_id (Phase 2)
               e.organizer_id AS "organizerPartyId",
               uo.name AS "organizerName"
        FROM calendar_event e
        LEFT JOIN app_user uo ON uo.party_id = e.organizer_id
        WHERE e.id = ${id}
      `);
      const event = eR.rows[0] as Record<string, unknown> | undefined;
      if (!event) return null;
      // Visibility: organizer or invitee.
      const inv = await db.execute(sql`
        SELECT i.id,
               u.id           AS "userId",   -- app_user.id via party_id (Phase 2)
               i.user_id      AS "partyId",
               i.rsvp, i.responded_at AS "respondedAt",
               u.name, u.email
        FROM calendar_invitee i
        JOIN app_user u ON u.party_id = i.user_id
        WHERE i.event_id = ${id}
        ORDER BY u.name
      `);
      const callerOk = (event.organizerPartyId as string) === mePartyId
        || (inv.rows as Array<{ partyId: string }>).some((r) => r.partyId === mePartyId);
      if (!callerOk) return null;
      // Strip internal partyId fields from wire response.
      delete (event as Record<string, unknown>).organizerPartyId;
      const invitees = (inv.rows as Array<Record<string, unknown>>).map((r) => {
        const { partyId: _partyId, ...rest } = r;
        void _partyId;
        return rest;
      });
      return { event, invitees };
    });
    if (!out) return res.status(404).json({ error: "Event not found" });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// POST /events — create + invite
eventsRouter.post("/", requirePermission("events.manage.self"), async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const title = String(b.title ?? "").trim();
    const description = b.description ? String(b.description).trim() : null;
    const location = b.location ? String(b.location).trim() : null;
    const startAt = b.startAt ? new Date(String(b.startAt)) : null;
    const endAt = b.endAt ? new Date(String(b.endAt)) : null;
    const allDay = !!b.allDay;
    const inviteeIds: string[] = Array.isArray(b.inviteeIds) ? b.inviteeIds : [];

    if (!title) return res.status(400).json({ error: "title required" });
    if (!startAt || !endAt || isNaN(startAt.getTime()) || isNaN(endAt.getTime()) || endAt <= startAt) {
      return res.status(400).json({ error: "startAt/endAt required, end > start" });
    }

    const created = await withTenant(req.tenantId!, async (db) => {
      // Phase 2: organizer_id + calendar_invitee.user_id store party.id.
      const mePartyId = await partyIdFromAppUserId(db, req.userId!);
      if (!mePartyId) throw new Error("organizer has no party record");
      const eR = await db.execute(sql`
        INSERT INTO calendar_event (tenant_id, organizer_id, title, description, location, start_at, end_at, all_day)
        VALUES (${req.tenantId}, ${mePartyId}, ${title}, ${description}, ${location},
                ${startAt.toISOString()}, ${endAt.toISOString()}, ${allDay})
        RETURNING id
      `);
      const eventId = (eR.rows[0] as { id: string }).id;
      // Organizer is auto-accepted.
      await db.execute(sql`
        INSERT INTO calendar_invitee (event_id, user_id, rsvp, responded_at)
        VALUES (${eventId}, ${mePartyId}, 'accepted', NOW())
        ON CONFLICT DO NOTHING
      `);
      // Resolve each invitee's app_user.id → party.id.
      for (const uid of inviteeIds) {
        if (uid === req.userId) continue;
        const invPartyId = await partyIdFromAppUserId(db, uid);
        if (!invPartyId) continue;
        await db.execute(sql`
          INSERT INTO calendar_invitee (event_id, user_id, rsvp)
          VALUES (${eventId}, ${invPartyId}, 'pending')
          ON CONFLICT DO NOTHING
        `);
      }
      return eventId;
    });
    res.status(201).json({ id: created });
  } catch (err) {
    next(err);
  }
});

// PATCH /events/:id — organizer edits details
eventsRouter.patch("/:id", requirePermission("events.manage.self"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const b = req.body ?? {};
    const out = await withTenant(req.tenantId!, async (db) => {
      const mePartyId = await partyIdFromAppUserId(db, req.userId!);
      if (!mePartyId) return { kind: "forbidden" as const };
      const own = await db.execute(sql`SELECT organizer_id FROM calendar_event WHERE id = ${id}`);
      const row = own.rows[0] as { organizer_id: string } | undefined;
      if (!row) return { kind: "not-found" as const };
      if (row.organizer_id !== mePartyId) return { kind: "forbidden" as const };
      const startAt = b.startAt ? new Date(String(b.startAt)).toISOString() : null;
      const endAt = b.endAt ? new Date(String(b.endAt)).toISOString() : null;
      await db.execute(sql`
        UPDATE calendar_event SET
          title = COALESCE(${b.title ?? null}, title),
          description = COALESCE(${b.description ?? null}, description),
          location = COALESCE(${b.location ?? null}, location),
          start_at = COALESCE(${startAt}, start_at),
          end_at = COALESCE(${endAt}, end_at),
          all_day = COALESCE(${b.allDay ?? null}, all_day)
        WHERE id = ${id}
      `);
      return { kind: "ok" as const };
    });
    if (out.kind === "not-found") return res.status(404).json({ error: "Event not found" });
    if (out.kind === "forbidden") return res.status(403).json({ error: "Only organizer can edit" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /events/:id — organizer only
eventsRouter.delete("/:id", requirePermission("events.manage.self"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const out = await withTenant(req.tenantId!, async (db) => {
      const mePartyId = await partyIdFromAppUserId(db, req.userId!);
      if (!mePartyId) return false;
      const r = await db.execute(sql`
        DELETE FROM calendar_event WHERE id = ${id} AND organizer_id = ${mePartyId} RETURNING id
      `);
      return r.rows.length > 0;
    });
    if (!out) return res.status(404).json({ error: "Event not found or not yours" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /events/:id/invitees — replace invitee list (organizer only)
eventsRouter.post("/:id/invitees", requirePermission("events.manage.self"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const userIds: string[] = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
    const out = await withTenant(req.tenantId!, async (db) => {
      const mePartyId = await partyIdFromAppUserId(db, req.userId!);
      if (!mePartyId) return { kind: "forbidden" as const };
      const own = await db.execute(sql`SELECT organizer_id FROM calendar_event WHERE id = ${id}`);
      const row = own.rows[0] as { organizer_id: string } | undefined;
      if (!row) return { kind: "not-found" as const };
      if (row.organizer_id !== mePartyId) return { kind: "forbidden" as const };
      // Wipe everyone except the organizer's own row, then re-add.
      await db.execute(sql`
        DELETE FROM calendar_invitee WHERE event_id = ${id} AND user_id <> ${mePartyId}
      `);
      for (const uid of userIds) {
        if (uid === req.userId) continue;
        const invPartyId = await partyIdFromAppUserId(db, uid);
        if (!invPartyId) continue;
        await db.execute(sql`
          INSERT INTO calendar_invitee (event_id, user_id, rsvp)
          VALUES (${id}, ${invPartyId}, 'pending')
          ON CONFLICT DO NOTHING
        `);
      }
      return { kind: "ok" as const };
    });
    if (out.kind === "not-found") return res.status(404).json({ error: "Event not found" });
    if (out.kind === "forbidden") return res.status(403).json({ error: "Only organizer can edit invitees" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /events/:id/respond — invitee RSVP
eventsRouter.post("/:id/respond", requirePermission("events.manage.self"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const rsvp = String(req.body?.rsvp ?? "").trim();
    if (!RSVP.has(rsvp) || rsvp === "pending") {
      return res.status(400).json({ error: "rsvp must be accepted/declined/tentative" });
    }
    const out = await withTenant(req.tenantId!, async (db) => {
      const mePartyId = await partyIdFromAppUserId(db, req.userId!);
      if (!mePartyId) return false;
      const r = await db.execute(sql`
        UPDATE calendar_invitee SET
          rsvp = ${rsvp},
          responded_at = NOW()
        WHERE event_id = ${id} AND user_id = ${mePartyId}
        RETURNING id
      `);
      return r.rows.length > 0;
    });
    if (!out) return res.status(404).json({ error: "You are not invited to this event" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
