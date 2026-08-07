// Gmail inbound poll.
//
// Was a 60-second setInterval. Vercel Cron's one-minute floor is exactly that
// cadence, so this schedule is unchanged from the Express deployment. No-ops
// when the Gmail env vars aren't configured.

import { guardCron } from "@/server/cron";
import { runGmailSync } from "@/server/lib/gmail/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handler(request: Request): Promise<Response> {
  const denied = guardCron(request);
  if (denied) return denied;

  const startedAt = Date.now();
  try {
    await runGmailSync();
    return Response.json({ ok: true, ms: Date.now() - startedAt });
  } catch (err) {
    console.error("[cron/gmail]", err);
    return Response.json(
      { ok: false, error: (err as Error).message, ms: Date.now() - startedAt },
      { status: 500 },
    );
  }
}

export { handler as GET, handler as POST };
