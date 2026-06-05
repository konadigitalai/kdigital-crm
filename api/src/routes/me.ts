import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

export const meRouter = Router();

// Resolve "current user" — until Auth0 lands, use the first admin in the tenant.
meRouter.get("/", async (req, res, next) => {
  try {
    const me = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          id,
          name,
          email,
          role,
          UPPER(
            CASE
              WHEN POSITION(' ' IN name) > 0
                THEN LEFT(name, 1) || LEFT(SPLIT_PART(name, ' ', 2), 1)
              ELSE LEFT(name, 2)
            END
          ) AS "initials"
        FROM app_user
        WHERE role = 'admin' AND active = true
        ORDER BY created_at
        LIMIT 1
      `);
      return r.rows[0] ?? null;
    });
    res.json({ me });
  } catch (err) {
    next(err);
  }
});
