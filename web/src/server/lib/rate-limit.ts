// Shared rate limiter, backed by Postgres.
//
// WHY THIS EXISTS
// Four routes (intake, exotel, exotel-webhook, twilio-webhook) each kept their
// own `Map<string, number[]>` sliding window in module scope. That worked on a
// single always-on Express process. It does not work here: every serverless
// invocation may get a fresh module instance, so an in-memory counter is empty
// on most requests and the limit silently never fires.
//
// "Silently" is the problem. The intake limiter is the only thing standing in
// front of a PUBLIC, unauthenticated endpoint that writes leads — a no-op there
// is an open door for anyone who finds the URL, with no error and nothing in
// the logs to notice. Postgres is already a hard dependency of every one of
// these paths, so it is the state store with the fewest new moving parts.
//
// Fixed window rather than the previous sliding window: one round trip instead
// of a read-modify-write race, and the difference only shows up as a burst
// allowance at a window boundary, which none of these limits care about.

import { appPool } from "../db/app";

/**
 * Count this hit and report whether it is within the limit.
 *
 * Fails OPEN. If Postgres is unreachable the caller is allowed through — a
 * limiter outage must not take down lead intake or start bouncing Twilio's
 * webhook retries. The error is logged so the failure is visible.
 */
export async function rateLimit(
  key: string,
  max: number,
  windowMs: number,
): Promise<boolean> {
  const windowInterval = `${Math.max(1, Math.round(windowMs / 1000))} seconds`;
  try {
    const r = await appPool.query<{ hits: number }>(
      `INSERT INTO rate_limit_window (key, window_start, hits)
       VALUES ($1, now(), 1)
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE
           WHEN rate_limit_window.window_start < now() - $2::interval THEN 1
           ELSE rate_limit_window.hits + 1
         END,
         window_start = CASE
           WHEN rate_limit_window.window_start < now() - $2::interval THEN now()
           ELSE rate_limit_window.window_start
         END
       RETURNING hits`,
      [key, windowInterval],
    );
    const hits = r.rows[0]?.hits ?? 1;
    return hits <= max;
  } catch (err) {
    console.error(`[rate-limit] check failed for ${key}, allowing:`, (err as Error).message);
    return true;
  }
}

/**
 * Client IP as seen through Vercel's proxy. There is no socket to fall back
 * to in a serverless function, so x-forwarded-for is the only source — its
 * first entry is the original client.
 */
export function clientIp(headers: Record<string, string | undefined>): string {
  const xf = String(headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  return xf || "unknown";
}
