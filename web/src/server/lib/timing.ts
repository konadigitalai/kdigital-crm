// Per-request timing, split into "time in Postgres" vs "everything else".
//
// The point is to answer one question when the app feels slow: is a given
// endpoint slow because the queries are slow, or because of everything around
// them (network hops, external APIs, waiting for a pool slot)? Total latency
// alone can't distinguish those, and they have completely different fixes.
//
// Mechanism: an AsyncLocalStorage store is opened per request; withTenant and
// tenantExec (db/app.ts) add to its dbMs counter as they go. Nothing has to be
// threaded through handler signatures.
//
// Two outputs:
//   1. A `Server-Timing` response header, which browser devtools renders inline
//      next to the request in the Network panel.
//   2. A log line for anything slower than SLOW_REQUEST_MS, so slow endpoints
//      surface in Render's logs without anyone watching a browser.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response, NextFunction } from "express";

interface RequestTiming {
  startedAt: number;
  dbMs: number;
  dbQueries: number;
  /** ms spent waiting for a pool slot — a direct signal of pool exhaustion. */
  poolWaitMs: number;
}

const store = new AsyncLocalStorage<RequestTiming>();

const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS ?? 1000);

/** Record a completed database round trip against the in-flight request. */
export function recordDbTime(ms: number): void {
  const t = store.getStore();
  if (!t) return; // background worker or boot-time query — nothing to attribute to
  t.dbMs += ms;
  t.dbQueries += 1;
}

/** Record time spent blocked waiting for a connection from the pool. */
export function recordPoolWait(ms: number): void {
  const t = store.getStore();
  if (!t) return;
  t.poolWaitMs += ms;
}

/**
 * Mount early — before the routers, after the body parsers — so the store
 * covers every handler. Cheap: one AsyncLocalStorage frame and one Date.now()
 * per request.
 */
export function timingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const timing: RequestTiming = {
    startedAt: Date.now(),
    dbMs: 0,
    dbQueries: 0,
    poolWaitMs: 0,
  };

  store.run(timing, () => {
    res.on("finish", () => {
      const total = Date.now() - timing.startedAt;
      // Everything that isn't Postgres: external APIs, JSON serialisation, and
      // — importantly — the network distance between this process and whatever
      // called it.
      const other = Math.max(0, total - timing.dbMs);

      if (total >= SLOW_REQUEST_MS) {
        console.warn(
          `[slow] ${req.method} ${req.originalUrl} ${res.statusCode} ` +
          `total=${total}ms db=${timing.dbMs}ms(${timing.dbQueries}q) ` +
          `other=${other}ms poolWait=${timing.poolWaitMs}ms`,
        );
      }
    });

    // Set the header before handlers run — once a handler calls res.json()
    // the headers are already flushed and a later set is silently dropped.
    // The values are read at flush time via a getter-ish trick: we can't know
    // the final numbers this early, so instead we hook writeHead.
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = function patchedWriteHead(this: Response, ...args: unknown[]) {
      const total = Date.now() - timing.startedAt;
      const other = Math.max(0, total - timing.dbMs);
      try {
        res.setHeader(
          "Server-Timing",
          [
            `db;desc="Postgres (${timing.dbQueries} queries)";dur=${timing.dbMs}`,
            `pool;desc="Waiting for a connection";dur=${timing.poolWaitMs}`,
            `other;desc="App + external APIs";dur=${other}`,
            `total;dur=${total}`,
          ].join(", "),
        );
      } catch {
        // Headers already sent (streamed response) — timing is best-effort.
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalWriteHead(...(args as [any]));
    } as Response["writeHead"];

    next();
  });
}
