// Start draining a campaign the moment it is launched or resumed.
//
// This is what replaces the 5-second poll. Under Express a background timer was
// always awake, so "start a campaign" only had to write a row and the worker
// noticed within 5 seconds. There is no always-awake process now, so the write
// path itself has to start the work.
//
// The result is FASTER than what it replaces: dispatch begins on the same
// request rather than up to 5 seconds later. The one-minute cron is a safety
// net for the cases with no write to hang off — scheduled campaigns reaching
// their time, and drains cut short by the function timeout.

import { after } from "next/server";
import { runCampaignDispatch } from "./worker";

/**
 * Schedule a dispatch to run after the current response is sent.
 *
 * `after()` is what keeps the function alive past the response on Vercel —
 * without it the runtime may freeze the invocation the moment the response
 * flushes, and a bare floating promise would be silently cut off mid-send.
 *
 * Never throws and never blocks the caller: campaign start must still succeed
 * even if dispatch can't be scheduled, because the cron will pick the work up
 * within the minute either way.
 */
export function kickCampaignDispatch(reason: string): void {
  try {
    after(async () => {
      try {
        await runCampaignDispatch();
      } catch (err) {
        console.error(`[campaign-kick] dispatch after ${reason} failed:`, (err as Error).message);
      }
    });
  } catch (err) {
    // Outside a Next request scope (or `after` unavailable). Not fatal — the
    // cron sweep is the backstop.
    console.warn(`[campaign-kick] could not schedule dispatch after ${reason}:`, (err as Error).message);
  }
}
