// Manage Advisors — CRUD around app_user rows that hold role 'admin' or
// 'advisor'. These are the people leads get assigned to; they also happen to
// be the people who can log in.
//
// A row created here has NO auth0_sub — it can be picked in the Advisor
// dropdown immediately, but the person can't sign in until they actually go
// through Auth0. On first Auth0 login the JIT provisioner (middleware/auth.ts)
// finds the existing row by email and stamps their sub onto it. Nothing
// duplicates.
//
// Deactivating an advisor flips app_user.active = false. Existing FK
// references (lead.advisor_id, work_item.assignee_id, etc.) are untouched —
// old rows still render "Assigned to Priya", but she stops appearing in new
// pickers.

import { Router } from "@/server/http";
import { sql } from "drizzle-orm";
import { appPool, withTenant } from "../db/app";
import { provisionPartyForInternalUser } from "../lib/party/provision";

export const advisorsRouter = Router();

const ALLOWED_ROLES = ["admin", "advisor"] as const;
type AdvisorRole = typeof ALLOWED_ROLES[number];

// ─── GET /advisors — list ────────────────────────────────────────────────
// Includes both active + inactive rows so the admin table can render "hidden"
// advisors with a badge. Filter client-side.
advisorsRouter.get("/", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          u.id, u.party_id AS "partyId", u.email, u.name, u.phone, u.role, u.active,
          u.auth0_sub AS "auth0Sub",
          u.created_at AS "createdAt",
          (SELECT COUNT(*)::int FROM lead l WHERE l.advisor_id = u.party_id) AS "leadCount"
        FROM app_user u
        WHERE u.role IN ('admin','advisor')
        ORDER BY u.active DESC, u.name NULLS LAST, u.email
      `);
      return r.rows;
    });
    res.json({ advisors: rows });
  } catch (err) { next(err); }
});

// ─── POST /advisors — add a new advisor ──────────────────────────────────
// Body: { name, email, phone?, role? }  (role defaults to 'advisor')
advisorsRouter.post("/", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const name  = String(b.name  ?? "").trim();
    const email = String(b.email ?? "").trim();
    const phone = b.phone ? String(b.phone).trim() : null;
    const role  = String(b.role ?? "advisor").trim().toLowerCase() as AdvisorRole;

    if (!name)  return res.status(400).json({ error: "name is required" });
    if (!email) return res.status(400).json({ error: "email is required" });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: "email is not a valid address" });
    }
    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of ${ALLOWED_ROLES.join(", ")}` });
    }

    const tenantId = req.tenantId!;

    // Use a dedicated pool client so provisionPartyForInternalUser can share
    // the same transaction. It sets app.tenant_id itself via SET LOCAL.
    const client = await appPool.connect();
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);

      // Refuse duplicates on email (case-insensitive).
      const dup = await client.query<{ id: string }>(
        `SELECT id FROM app_user WHERE tenant_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
        [tenantId, email],
      );
      if (dup.rows[0]) {
        return res.status(409).json({ error: "an advisor with that email already exists" });
      }

      const { partyId } = await provisionPartyForInternalUser(client, tenantId, email, name);

      const ins = await client.query<{
        id: string; party_id: string; email: string; name: string | null;
        phone: string | null; role: string; active: boolean; created_at: string;
      }>(
        `INSERT INTO app_user (tenant_id, party_id, email, name, phone, role, active)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         RETURNING id, party_id, email, name, phone, role, active, created_at`,
        [tenantId, partyId, email, name, phone, role],
      );
      const row = ins.rows[0]!;

      res.status(201).json({
        advisor: {
          id: row.id,
          partyId: row.party_id,
          email: row.email,
          name: row.name,
          phone: row.phone,
          role: row.role,
          active: row.active,
          auth0Sub: null,
          createdAt: row.created_at,
          leadCount: 0,
        },
      });
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

// ─── PATCH /advisors/:id — update ────────────────────────────────────────
// Fields: name?, phone?, role?, active?
advisorsRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "invalid id" });

    const b = req.body ?? {};
    const sets: ReturnType<typeof sql>[] = [];

    // Also mirror name changes into party.name so downstream displays match.
    let newName: string | null | undefined = undefined;
    if (b.name !== undefined) {
      const n = String(b.name).trim();
      if (!n) return res.status(400).json({ error: "name cannot be empty" });
      newName = n;
      sets.push(sql`name = ${n}`);
    }

    if (b.phone !== undefined) {
      const p = b.phone ? String(b.phone).trim() : null;
      sets.push(sql`phone = ${p}`);
    }

    if (b.role !== undefined) {
      const r = String(b.role).trim().toLowerCase();
      if (!ALLOWED_ROLES.includes(r as AdvisorRole)) {
        return res.status(400).json({ error: `role must be one of ${ALLOWED_ROLES.join(", ")}` });
      }
      sets.push(sql`role = ${r}`);
    }

    if (b.active !== undefined) {
      sets.push(sql`active = ${Boolean(b.active)}`);
    }

    if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });

    const updated = await withTenant(req.tenantId!, async (db) => {
      const setClause = sql.join(sets, sql`, `);
      const r = await db.execute(sql`
        UPDATE app_user SET ${setClause}
        WHERE id = ${id} AND role IN ('admin','advisor')
        RETURNING id, party_id AS "partyId", email, name, phone, role, active,
                  auth0_sub AS "auth0Sub", created_at AS "createdAt",
                  (SELECT COUNT(*)::int FROM lead l WHERE l.advisor_id = app_user.party_id) AS "leadCount"
      `);
      const row = r.rows[0];
      if (!row) return null;

      if (newName) {
        // Keep party.name in sync so any place that renders from party (activity
        // rows, learner sidebar, …) reflects the new label.
        await db.execute(sql`UPDATE party SET name = ${newName} WHERE id = ${(row as { partyId: string }).partyId}`);
      }

      return row;
    });

    if (!updated) return res.status(404).json({ error: "advisor not found" });
    res.json({ advisor: updated });
  } catch (err) { next(err); }
});

// No DELETE — advisors are retired via PATCH { active: false } so historical
// references keep resolving.
