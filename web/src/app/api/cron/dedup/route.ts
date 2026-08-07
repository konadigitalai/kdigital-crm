// Party dedup sweep.
//
// Was a 6-hour setInterval with a run-at-boot so a fresh deploy didn't wait
// 6 hours for the first candidate rows. Cron matches the 6-hour schedule
// exactly, and redeploys no longer reset the clock.

import { guardCron } from "@/server/cron";
import { runDedupSweep } from "@/server/lib/party/dedup-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handler(request: Request): Promise<Response> {
  const denied = guardCron(request);
  if (denied) return denied;

  const startedAt = Date.now();
  try {
    await runDedupSweep();
    return Response.json({ ok: true, ms: Date.now() - startedAt });
  } catch (err) {
    console.error("[cron/dedup]", err);
    return Response.json(
      { ok: false, error: (err as Error).message, ms: Date.now() - startedAt },
      { status: 500 },
    );
  }
}

export { handler as GET, handler as POST };
