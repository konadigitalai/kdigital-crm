// Phase 4 Party Model — dedup sweep.
//
// Walks every tenant and runs scanForDuplicates. New candidate pairs land in
// party_duplicate_candidate for ops review.
//
// Was a `setInterval` started from the Express boot callback. It is now driven
// by Vercel Cron (see src/app/api/cron/dedup/route.ts), which is an exact
// match for the schedule this always wanted: every 6 hours, no long-running
// process required. The per-tick overlap guard went with the timer — cron
// invocations don't overlap at this cadence, and the sweep is idempotent.

import { appPool, withTenant } from "../../db/app";
import { scanForDuplicates } from "./dedup";

export async function runDedupSweep(): Promise<void> {
  const client = await appPool.connect();
  let tenantIds: string[];
  try {
    const r = await client.query<{ id: string }>(`SELECT id FROM tenant`);
    tenantIds = r.rows.map((row) => row.id);
  } finally {
    client.release();
  }

  let totalInserted = 0;
  for (const tenantId of tenantIds) {
    try {
      const summary = await withTenant(tenantId, (db) => scanForDuplicates(db, tenantId));
      if (summary.inserted > 0) {
        console.log(`[dedup-worker] tenant ${tenantId}: inserted ${summary.inserted} candidates`,
          summary.ruleBreakdown);
      }
      totalInserted += summary.inserted;
    } catch (err) {
      console.error(`[dedup-worker] tenant ${tenantId} error:`, (err as Error).message);
    }
  }
  if (totalInserted > 0) {
    console.log(`[dedup-worker] sweep complete — ${totalInserted} new candidates across ${tenantIds.length} tenants`);
  }
}
