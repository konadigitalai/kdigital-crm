import type { Request, Response, NextFunction } from "express";
import { appPool } from "../db/app.js";

declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
    }
  }
}

// Tenant id with a short TTL — long enough to skip the lookup on every request,
// short enough that re-seed (which mints a new tenant.id) doesn't break dev mode.
let cachedTenantId: string | null = null;
let cachedAt = 0;
const TTL_MS = 60_000;

async function resolveTenantId(): Promise<string> {
  if (cachedTenantId && Date.now() - cachedAt < TTL_MS) return cachedTenantId;
  const r = await appPool.query<{ id: string }>(`SELECT id FROM tenant ORDER BY created_at LIMIT 1`);
  if (!r.rows[0]) {
    throw new Error("No tenant rows found — run `npm run db:seed`.");
  }
  cachedTenantId = r.rows[0].id;
  cachedAt = Date.now();
  return cachedTenantId;
}

export async function tenantMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    req.tenantId = await resolveTenantId();
    next();
  } catch (err) {
    next(err);
  }
}
