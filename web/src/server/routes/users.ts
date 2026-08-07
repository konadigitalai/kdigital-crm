// User management — read-only listing. Create / update / activate /
// deactivate / reset-password have all moved to Auth0 (manage at
// https://manage.auth0.com → User Management → Users).
//
// GET /users is preserved because in-app pickers — case assignee, inbox
// triage — still need the list of provisioned users. Rows are populated
// by JIT provisioning inside the Auth0-backed authMiddleware as people
// log in.

import { Router } from "@/server/http";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";

export const usersRouter = Router();

// GET /users — list every user in the tenant. The legacy `groups` field is
// preserved as an always-empty array so any UI that reads `.groups` on
// each row doesn't break — Auth0 owns role assignment now.
usersRouter.get("/", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          u.id, u.email, u.name, u.role, u.active, u.created_at,
          false      AS has_password,
          '[]'::json AS groups
        FROM app_user u
        ORDER BY u.created_at
      `);
      return r.rows;
    });
    res.json({ users: rows });
  } catch (err) {
    next(err);
  }
});

// All mutating endpoints (POST /, PATCH /:id, /:id/reset-password,
// /:id/activate, /:id/deactivate) have been removed. They returned 404.
// User lifecycle is owned by Auth0:
//   - Create / invite:      Auth0 Dashboard → Users → Create User
//   - Disable:              Auth0 Dashboard → Users → Block
//   - Reset password:       Auth0 Dashboard → Users → Send Password Reset
//   - Grant / revoke role:  Auth0 Dashboard → Users → {user} → Roles
