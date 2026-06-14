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

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import type { Permission } from "../lib/permissions.js";

export const viewsRouter = Router();

const SUPPORTED_SCOPES = ["pipeline_list"] as const;
type Scope = (typeof SUPPORTED_SCOPES)[number];
function isScope(s: string): s is Scope {
  return (SUPPORTED_SCOPES as readonly string[]).includes(s);
}

// What permission gates "create/edit/delete a SHARED view" for each scope.
// The surface's own write perm is reused — anyone who can mutate leads in
// the pipeline can also publish a shared view there.
const SHARED_WRITE_PERM: Record<Scope, Permission> = {
  pipeline_list: "pipeline.write",
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

    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          id, tenant_id AS "tenantId", owner_id AS "ownerId",
          scope, name, visibility, filter, columns,
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM saved_view
        WHERE scope = ${scope}
          AND (owner_id = ${req.userId} OR visibility = 'shared')
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
      const r = await db.execute(sql`
        INSERT INTO saved_view (tenant_id, owner_id, scope, name, visibility, filter, columns)
        VALUES (current_tenant(), ${req.userId}, ${scope}, ${name}, ${visibility},
                ${JSON.stringify(filter)}::jsonb,
                ${columnsSqlValue(columns)})
        RETURNING
          id, tenant_id AS "tenantId", owner_id AS "ownerId",
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
    const newName       = b.name !== undefined ? String(b.name).trim() : undefined;
    const newVisibility = b.visibility !== undefined ? String(b.visibility) : undefined;
    const newFilter     = b.filter && typeof b.filter === "object" ? b.filter : undefined;
    const newColumns    = b.columns !== undefined
      ? (Array.isArray(b.columns) ? b.columns.filter((s: unknown) => typeof s === "string") : null)
      : undefined;

    if (newName !== undefined && (!newName || newName.length > 80)) {
      return res.status(400).json({ error: "name must be 1..80 chars" });
    }
    if (newVisibility !== undefined && !["personal", "shared"].includes(newVisibility)) {
      return res.status(400).json({ error: "visibility must be personal|shared" });
    }

    const result = await withTenant(req.tenantId!, async (db) => {
      // Fetch current row to authorize.
      const r = await db.execute(sql`
        SELECT id, owner_id AS "ownerId", scope, visibility
        FROM saved_view WHERE id = ${id}
      `);
      const row = r.rows[0] as { ownerId: string; scope: string; visibility: string } | undefined;
      if (!row) return { kind: "not-found" as const };
      if (!isScope(row.scope)) return { kind: "bad-scope" as const };

      // Authorization:
      //   - Owners can always edit personal views they own.
      //   - Editing a shared view (or promoting/demoting) requires the
      //     surface's write perm.
      const isOwner = row.ownerId === req.userId;
      const willBeShared = newVisibility === "shared" || (newVisibility === undefined && row.visibility === "shared");
      const wasShared = row.visibility === "shared";
      const need = SHARED_WRITE_PERM[row.scope];
      const hasPerm = req.permissions?.has(need) === true;

      if (!isOwner && !(wasShared && hasPerm)) return { kind: "forbidden" as const };
      if ((willBeShared || wasShared) && !hasPerm) return { kind: "forbidden-shared" as const, need };

      // Build dynamic UPDATE.
      const sets: ReturnType<typeof sql>[] = [];
      if (newName       !== undefined) sets.push(sql`name = ${newName}`);
      if (newVisibility !== undefined) sets.push(sql`visibility = ${newVisibility}`);
      if (newFilter     !== undefined) sets.push(sql`filter = ${JSON.stringify(newFilter)}::jsonb`);
      if (newColumns    !== undefined) sets.push(sql`columns = ${columnsSqlValue(newColumns)}`);
      if (sets.length === 0) return { kind: "no-op" as const };

      const set = sql.join(sets, sql`, `);
      const u = await db.execute(sql`
        UPDATE saved_view SET ${set} WHERE id = ${id}
        RETURNING
          id, tenant_id AS "tenantId", owner_id AS "ownerId",
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
      const r = await db.execute(sql`
        SELECT owner_id AS "ownerId", scope, visibility FROM saved_view WHERE id = ${id}
      `);
      const row = r.rows[0] as { ownerId: string; scope: string; visibility: string } | undefined;
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
