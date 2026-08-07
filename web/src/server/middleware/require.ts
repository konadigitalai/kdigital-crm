import type { Request, Response, NextFunction } from "express";
import type { Permission } from "../lib/permissions.js";

// requirePermission — guard middleware factory. Use AFTER authMiddleware.
export function requirePermission(perm: Permission) {
  return function permissionGuard(req: Request, res: Response, next: NextFunction) {
    if (!req.permissions || !req.permissions.has(perm)) {
      return res.status(403).json({ error: `Missing permission: ${perm}` });
    }
    next();
  };
}

export function requireAnyPermission(...perms: Permission[]) {
  return function permissionGuard(req: Request, res: Response, next: NextFunction) {
    const has = perms.some((p) => req.permissions?.has(p));
    if (!has) {
      return res.status(403).json({ error: `Missing permission: one of ${perms.join(", ")}` });
    }
    next();
  };
}
