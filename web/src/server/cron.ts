// Shared guard for the cron endpoints.
//
// These routes do real work — dispatching paid WhatsApp/SMS sends, polling
// Gmail, sweeping for duplicate parties — and they sit outside the Auth0 fence
// because Vercel Cron has no user to authenticate as. So the secret IS the
// authentication.
//
// Vercel Cron sends `Authorization: Bearer $CRON_SECRET` on every invocation
// when CRON_SECRET is set in the project's environment. Nothing else about the
// request is trustworthy: the path is public and anyone can POST to it.

import { timingSafeEqual } from "node:crypto";

const CRON_SECRET = (process.env.CRON_SECRET ?? "").trim();

function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

/**
 * Returns a 401/503 Response when the caller isn't Vercel Cron, or null when
 * the request may proceed.
 *
 * Fails CLOSED. An unset CRON_SECRET refuses every request rather than running
 * the job — the alternative is a public, unauthenticated endpoint that spends
 * money on messaging, which is not something to leave open by omission.
 */
export function guardCron(request: Request): Response | null {
  if (!CRON_SECRET) {
    console.error("[cron] CRON_SECRET is not set — refusing to run scheduled work");
    return Response.json({ error: "Cron is not configured" }, { status: 503 });
  }
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !safeEqual(match[1]!.trim(), CRON_SECRET)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
