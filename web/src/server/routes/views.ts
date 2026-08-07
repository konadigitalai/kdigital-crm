// Saved views — per-user (or tenant-shared) snapshots of filter rules +
// column choices for a list surface. The table is generic (`scope` column
// names the surface). Currently only the pipeline list uses it.
//
// Permission model:
//   - Anyone authenticated can list, create personal, and edit/delete their
//     own personal views.
//   - Promoting a view to `visibility='shared'` (or editing/deleting an
//     already-shared one) requires the same write perm as the surface
//     itself. For pipeline_list that's `pipeline.write`. We resolve it
//     by scope so future surfaces can declare their own gate.
//
// Body shape used by POST/PATCH:
//   { name: string,
//     visibility: 'personal' | 'shared',
//     filter:  { rules: Array<...> }  // opaque JSONB; the client validates shape
//     columns: string[] | null,        // visible column keys, in display order
//   }

import { Router } from "@/server/http";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";
import type { Permission } from "../lib/permissions";
import { partyIdFromAppUserId } from "../lib/party/resolve";

export const viewsRouter = Router();

const SUPPORTED_SCOPES = ["pipeline_list", "enrollments_list", "learners_list", "batches_list", "cases_list"] as const;
type Scope = (typeof SUPPORTED_SCOPES)[number];
function isScope(s: string): s is Scope {
  return (SUPPORTED_SCOPES as readonly string[]).includes(s);
}

// What permission gates "create/edit/delete a SHARED view" for each scope.
// The surface's own write perm is reused — anyone who can mutate leads in
// the pipeline can also publish a shared view there. Enrollments reuses the
// learners write perm, matching how the /enrollments routes are mounted.
const SHARED_WRITE_PERM: Record<Scope, Permission> = {
  pipeline_list: "pipeline.write",
  enrollments_list: "learners.write",
  learners_list: "learners.write",
  batches_list: "admin.batches.manage",
  cases_list: "cases.write",
};

// Reading a scope's views requires that surface's read perm. The mount only
// checks the caller can read *some* surface, so the GET handler re-checks the
// specific scope here — otherwise a learners-only user could read pipeline
// views (and vice-versa).
const READ_PERM: Record<Scope, Permission> = {
  pipeline_list: "pipeline.read",
  enrollments_list: "learners.read",
  learners_list: "learners.read",
  batches_list: "admin.batches.manage",
  cases_list: "cases.read",
};

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s);

// Drizzle binds JS arrays as record tuples in INSERT/UPDATE, which Postgres
// then chokes on with a syntax error like `syntax error at or near ")"`.
// Render the array element-by-element so each value is still parameter-bound
// individually, then cast to text[]. Mirrors the same trick in cohorts.ts.
function columnsSqlValue(cols: string[] | null) {
  if (!cols || cols.length === 0) return sql`NULL::text[]`;
  const parts = cols.map((c) => sql`${c}`);
  return sql`ARRAY[${sql.join(parts, sql`, `)}]::text[]`;
}

// ─── GET /views?scope=... — list my personal + tenant-shared views ────────

viewsRouter.get("/", async (req, res, next) => {
  try {
    const scope = String(req.query.scope ?? "");
    if (!isScope(scope)) return res.status(400).json({ error: "unsupported scope" });
    if (!req.permissions?.has(READ_PERM[scope])) {
      return res.status(403).json({ error: `Missing permission: ${READ_PERM[scope]}` });
    }

    const rows = await withTenant(req.tenantId!, async (db) => {
      // Phase 2: saved_view.owner_id stores party.id. Return app_user.id in
      // the API response (wire compat).
      const userPartyId = await partyIdFromAppUserId(db, req.userId!);
      if (!userPartyId) return [];
      const r = await db.execute(sql`
        SELECT
          id, tenant_id AS "tenantId",
          (SELECT au.id FROM app_user au WHERE au.party_id = saved_view.owner_id LIMIT 1) AS "ownerId",
          scope, name, visibility, filter, columns,
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM saved_view
        WHERE scope = ${scope}
          AND (owner_id = ${userPartyId} OR visibility = 'shared')
        ORDER BY visibility DESC, lower(name)
      `);
      return r.rows;
    });

    res.json({ views: rows });
  } catch (err) {
    next(err);
  }
});

// ─── POST /views — create ─────────────────────────────────────────────────

viewsRouter.post("/", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const scope = String(b.scope ?? "");
    const name = String(b.name ?? "").trim();
    const visibility = String(b.visibility ?? "personal");
    const filter = b.filter && typeof b.filter === "object" ? b.filter : {};
    const columns = Array.isArray(b.columns) ? b.columns.filter((s: unknown) => typeof s === "string") : null;

    if (!isScope(scope))                            return res.status(400).json({ error: "unsupported scope" });
    if (!name)                                      return res.status(400).json({ error: "name is required" });
    if (name.length > 80)                           return res.status(400).json({ error: "name too long (max 80 chars)" });
    if (!["personal", "shared"].includes(visibility)) return res.status(400).json({ error: "visibility must be personal|shared" });

    // Promoting to shared requires the surface write perm.
    if (visibility === "shared") {
      const need = SHARED_WRITE_PERM[scope];
      if (!req.permissions?.has(need)) {
        return res.status(403).json({ error: `creating a shared view requires the ${need} permission` });
      }
    }

    const created = await withTenant(req.tenantId!, async (db) => {
      const userPartyId = await partyIdFromAppUserId(db, req.userId!);
      if (!userPartyId) throw new Error("saved view: user has no party record");
      const r = await db.execute(sql`
        INSERT INTO saved_view (tenant_id, owner_id, scope, name, visibility, filter, columns)
        VALUES (current_tenant(), ${userPartyId}, ${scope}, ${name}, ${visibility},
                ${JSON.stringify(filter)}::jsonb,
                ${columnsSqlValue(columns)})
        RETURNING
          id, tenant_id AS "tenantId",
          (SELECT au.id FROM app_user au WHERE au.party_id = saved_view.owner_id LIMIT 1) AS "ownerId",
          scope, name, visibility, filter, columns,
          created_at AS "createdAt", updated_at AS "updatedAt"
      `);
      return r.rows[0];
    });

    res.status(201).json({ view: created });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /views/:id — rename / overwrite filter or columns / change scope visibility

viewsRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isUuid(id)) return res.status(400).json({ error: "invalid id" });

    const b = req.body ?? {};
    const newName    = b.name !== undefined ? String(b.name).trim() : undefined;
    const newFilter  = b.filter && typeof b.filter === "object" ? b.filter : undefined;
    const newColumns = b.columns !== undefined
      ? (Array.isArray(b.columns) ? b.columns.filter((s: unknown) => typeof s === "string") : null)
      : undefined;
    // visibility on the request body is silently ignored (locked at create).

    if (newName !== undefined && (!newName || newName.length > 80)) {
      return res.status(400).json({ error: "name must be 1..80 chars" });
    }

    const result = await withTenant(req.tenantId!, async (db) => {
      // Fetch current row to authorize. Phase 2: owner_id stores party.id;
      // resolve it back to app_user.id for the comparison against req.userId.
      const r = await db.execute(sql`
        SELECT id,
               (SELECT au.id FROM app_user au WHERE au.party_id = saved_view.owner_id LIMIT 1) AS "ownerId",
               scope, visibility
        FROM saved_view WHERE id = ${id}
      `);
      const row = r.rows[0] as { ownerId: string | null; scope: string; visibility: string } | undefined;
      if (!row) return { kind: "not-found" as const };
      if (!isScope(row.scope)) return { kind: "bad-scope" as const };

      // Authorization:
      //   - Owners can always edit personal views they own.
      //   - Editing a shared view (or promoting/demoting) requires the
      //     surface's write perm.
      const isOwner = row.ownerId === req.userId;
      const wasShared = row.visibility === "shared";
      const need = SHARED_WRITE_PERM[row.scope];
      const hasPerm = req.permissions?.has(need) === true;

      if (!isOwner && !(wasShared && hasPerm)) return { kind: "forbidden" as const };
      if (wasShared && !hasPerm) return { kind: "forbidden-shared" as const, need };

      // Visibility is LOCKED on create — the frontend no longer sends
      // visibility on PATCH. If a legacy client or curl does send it,
      // we silently drop it rather than 400-ing (forgiving to old
      // clients; the field is a no-op on edit). Flipping personal↔shared
      // has team-wide consequences and is a create-time decision only.
      // To move a view between scopes, delete it and recreate.

      // Build dynamic UPDATE.
      const sets: ReturnType<typeof sql>[] = [];
      if (newName       !== undefined) sets.push(sql`name = ${newName}`);
      if (newFilter     !== undefined) sets.push(sql`filter = ${JSON.stringify(newFilter)}::jsonb`);
      if (newColumns    !== undefined) sets.push(sql`columns = ${columnsSqlValue(newColumns)}`);
      if (sets.length === 0) return { kind: "no-op" as const };

      const set = sql.join(sets, sql`, `);
      const u = await db.execute(sql`
        UPDATE saved_view SET ${set} WHERE id = ${id}
        RETURNING
          id, tenant_id AS "tenantId",
          (SELECT au.id FROM app_user au WHERE au.party_id = saved_view.owner_id LIMIT 1) AS "ownerId",
          scope, name, visibility, filter, columns,
          created_at AS "createdAt", updated_at AS "updatedAt"
      `);
      return { kind: "ok" as const, view: u.rows[0] };
    });

    if (result.kind === "not-found")        return res.status(404).json({ error: "view not found" });
    if (result.kind === "bad-scope")        return res.status(409).json({ error: "view has an unsupported scope" });
    if (result.kind === "forbidden")        return res.status(403).json({ error: "you can only edit your own views" });
    if (result.kind === "forbidden-shared") return res.status(403).json({ error: `editing a shared view requires the ${result.need} permission` });
    if (result.kind === "no-op")            return res.json({ ok: true, noop: true });
    res.json({ view: result.view });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /views/:id ────────────────────────────────────────────────────

viewsRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isUuid(id)) return res.status(400).json({ error: "invalid id" });

    const result = await withTenant(req.tenantId!, async (db) => {
      // Phase 2: owner_id stores party.id; resolve to app_user.id for the
      // ownership check against req.userId.
      const r = await db.execute(sql`
        SELECT (SELECT au.id FROM app_user au WHERE au.party_id = saved_view.owner_id LIMIT 1) AS "ownerId",
               scope, visibility FROM saved_view WHERE id = ${id}
      `);
      const row = r.rows[0] as { ownerId: string | null; scope: string; visibility: string } | undefined;
      if (!row) return { kind: "not-found" as const };
      if (!isScope(row.scope)) return { kind: "bad-scope" as const };

      const isOwner = row.ownerId === req.userId;
      const need = SHARED_WRITE_PERM[row.scope];
      const hasPerm = req.permissions?.has(need) === true;

      if (row.visibility === "shared" && !hasPerm) {
        return { kind: "forbidden-shared" as const, need };
      }
      if (!isOwner && row.visibility === "personal") {
        return { kind: "forbidden" as const };
      }

      await db.execute(sql`DELETE FROM saved_view WHERE id = ${id}`);
      return { kind: "ok" as const };
    });

    if (result.kind === "not-found")        return res.status(404).json({ error: "view not found" });
    if (result.kind === "bad-scope")        return res.status(409).json({ error: "view has an unsupported scope" });
    if (result.kind === "forbidden")        return res.status(403).json({ error: "you can only delete your own views" });
    if (result.kind === "forbidden-shared") return res.status(403).json({ error: `deleting a shared view requires the ${result.need} permission` });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
