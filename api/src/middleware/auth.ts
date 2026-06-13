// Resolve the current request's user from the session cookie. Sets
// req.userId, req.tenantId, req.user, req.permissions. Rejects with 401
// when there's no valid active session, or when the user has been deactivated.

import type { Request, Response, NextFunction } from "express";
import { appPool } from "../db/app.js";
import { readSession } from "../lib/sessions.js";

declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      userId?: string;
      user?: {
        id: string;
        tenantId: string;
        email: string;
        name: string | null;
        role: string;
        active: boolean;
      };
      permissions?: Set<string>;
    }
  }
}

const SESSION_COOKIE = "decrm_session";

async function loadUserAndPermissions(userId: string): Promise<
  | {
      user: NonNullable<Request["user"]>;
      permissions: Set<string>;
    }
  | null
> {
  const u = await appPool.query<{
    id: string;
    tenant_id: string;
    email: string;
    name: string | null;
    role: string;
    active: boolean;
  }>(
    `SELECT id, tenant_id, email, name, role, active
     FROM app_user
     WHERE id = $1
     LIMIT 1`,
    [userId],
  );
  const row = u.rows[0];
  if (!row || !row.active) return null;
  const p = await appPool.query<{ permission: string }>(
    `SELECT DISTINCT p.permission
     FROM user_group_member m
     JOIN user_group_permission p ON p.group_id = m.group_id
     WHERE m.user_id = $1`,
    [userId],
  );
  return {
    user: {
      id: row.id,
      tenantId: row.tenant_id,
      email: row.email,
      name: row.name,
      role: row.role,
      active: row.active,
    },
    permissions: new Set(p.rows.map((r) => r.permission)),
  };
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const token = (req.cookies?.[SESSION_COOKIE] as string | undefined) ?? "";
    const session = await readSession(token);
    if (!session) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const ctx = await loadUserAndPermissions(session.userId);
    if (!ctx) {
      return res.status(401).json({ error: "User is inactive or no longer exists" });
    }
    req.userId = ctx.user.id;
    req.tenantId = ctx.user.tenantId;
    req.user = ctx.user;
    req.permissions = ctx.permissions;
    next();
  } catch (err) {
    next(err);
  }
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
