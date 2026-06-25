"use client";

// Sign-in entry point. Auth lives in Auth0 — we just kick the user to the
// SDK-mounted /auth/login route, which then redirects to Auth0 Universal
// Login. The `returnTo` query string is preserved so the user lands back
// where they were (or on Agent Home for a fresh login).

import Link from "next/link";
import { Icon } from "@/components/ui/Icon";

export function LoginForm({ next }: { next: string }) {
  // /auth/login is auto-mounted by @auth0/nextjs-auth0's middleware.
  // returnTo is the path the SDK redirects to after a successful
  // callback. Default to "/" so a stale "?next=" doesn't bounce us
  // somewhere bad.
  const safeNext = next && next.startsWith("/") ? next : "/";
  const href = `/auth/login?returnTo=${encodeURIComponent(safeNext)}`;

  return (
    <div className="space-y-4">
      <Link
        href={href}
        className="btn-grad mt-2 flex w-full items-center justify-center gap-2 py-3 text-[14px]"
      >
        Sign in with Auth0
        <Icon name="arrow-right" size={14} strokeWidth={2.2} />
      </Link>
      <p className="text-center text-[11.5px] text-mute">
        Auth0 handles passwords, MFA, and session security. You'll be redirected and brought back here once signed in.
      </p>
    </div>
  );
}
