// User group endpoint — stub for backward compatibility.
//
// The legacy user_group / user_group_member / user_group_permission tables
// were dropped at the Auth0 cutover (see post-0039-drop-cookie-auth.sql).
// Role + permission management lives in Auth0 now:
//   - Create role:      Auth0 Dashboard → User Management → Roles → Create
//   - Edit permissions: Auth0 Dashboard → Roles → {role} → Permissions
//   - Assign to user:   Auth0 Dashboard → Users → {user} → Roles
//
// We keep the GET /groups endpoint returning an empty groups list +
// the permission catalog so any UI that still reads the permission
// labels (chips, picker dropdowns) doesn't break.

import { Router } from "express";
import { MODULE_CATALOG, PERMISSIONS, PRESETS } from "../lib/permissions.js";

export const groupsRouter = Router();

groupsRouter.get("/", (_req, res) => {
  res.json({
    groups: [],
    catalog: PERMISSIONS,
    modules: MODULE_CATALOG,
    presets: PRESETS,
  });
});
