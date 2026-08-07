// Campaign dispatch — the safety net.
//
// The primary trigger is now the write path: starting or resuming a campaign
// kicks a drain immediately (routes/campaigns.ts), which is faster than the
// 5-second poll this replaced. This cron exists for the cases that has no
// write to hang off:
//
//   • a `scheduled` campaign whose scheduled_at has arrived
//   • a drain that was cut short by the function timeout mid-campaign
//   • recipients stranded in `sending` by an invocation that died
//
// One minute is Vercel Cron's floor. That only sets how long a SCHEDULED
// campaign waits to start, which is well inside the minute-level granularity
// scheduling already has.

import { guardCron } from "@/server/cron";
import { runCampaignDispatch } from "@/server/lib/campaigns/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Bulk sends are the longest-running job here; give it the full window.
export const maxDuration = 300;

async function handler(request: Request): Promise<Response> {
  const denied = guardCron(request);
  if (denied) return denied;

  const startedAt = Date.now();
  try {
    await runCampaignDispatch();
    return Response.json({ ok: true, ms: Date.now() - startedAt });
  } catch (err) {
    console.error("[cron/campaigns]", err);
    return Response.json(
      { ok: false, error: (err as Error).message, ms: Date.now() - startedAt },
      { status: 500 },
    );
  }
}

export { handler as GET, handler as POST };
