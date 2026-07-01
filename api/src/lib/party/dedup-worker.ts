// Phase 4 Party Model — background dedup sweep worker.
//
// Every 6 hours, walks every tenant and runs scanForDuplicates. New
// candidate pairs land in party_duplicate_candidate for ops review.
//
// Same shape as startBroadcastWorker in lib/whatsapp/broadcasts.ts —
// setInterval + a per-tick guard so ticks never overlap.

import { appPool, withTenant } from "../../db/app.js";
import { scanForDuplicates } from "./dedup.js";

const TICK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** Start the dedup sweep worker. Idempotent — calling twice is a no-op. */
export function startDedupWorker(): void {
  if (timer) return;
  // Run once at boot so a fresh deployment doesn't have to wait 6h for
  // the first candidate rows to appear.
  tick().catch((err) =>
    console.error("[dedup-worker] boot sweep error:", (err as Error).message),
  );
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    tick()
      .catch((err) => console.error("[dedup-worker] tick error:", (err as Error).message))
      .finally(() => { ticking = false; });
  }, TICK_INTERVAL_MS);
  console.log("[dedup-worker] started (every 6h)");
}

export function stopDedupWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

async function tick(): Promise<void> {
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
