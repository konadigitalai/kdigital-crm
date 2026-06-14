// Server-side page guards. Use at the top of an `app/(app)/.../page.tsx` to
// redirect users who are missing a permission. The Next middleware already
// handles "no session at all" → /login; this layer handles "logged in, but
// not allowed to see this page" → home with a small toast hint via query.
//
//   await requirePagePermission("admin.batches.manage");
//
// If the user lacks the permission, throws a redirect to "/" so they land on
// the agent home (which they can always see). The redirect carries
// ?denied=<perm> so the home page can flash a "you don't have access" toast
// if it wants to. Today nothing reads it; we add when needed.

import { redirect } from "next/navigation";
import { getCurrentUser } from "./api";

export async function requirePagePermission(permission: string): Promise<void> {
  const me = await getCurrentUser();
  if (!me) {
    // No session — middleware will redirect, but be defensive in case this
    // ever runs in a context where middleware didn't.
    redirect("/login");
  }
  if (!me.permissions.includes(permission)) {
    redirect(`/?denied=${encodeURIComponent(permission)}`);
  }
}

export async function requireAnyPagePermission(...perms: string[]): Promise<void> {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!perms.some((p) => me.permissions.includes(p))) {
    redirect(`/?denied=${encodeURIComponent(perms.join(","))}`);
  }
}
