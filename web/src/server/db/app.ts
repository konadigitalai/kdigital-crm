// App-role pool: connects as decrm_app (NOBYPASSRLS).
// All HTTP handlers go through this pool, not the admin pool.
//
// No `dotenv/config` import: Next.js loads .env / .env.local itself before any
// module here evaluates. The ops scripts under db/ still import it, because
// they run standalone under tsx with no framework to do it for them.
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { recordDbTime, recordPoolWait } from "../lib/timing";

// Pool size — PER INVOCATION, which is the whole point of this comment.
//
// This was 10, then raised to 20 during the performance work because a single
// always-on Express process served every request and 10 starved it. That
// reasoning INVERTS under serverless. There is no longer one process with one
// pool: every concurrent invocation is its own process with its own pool, so
// the real number of connections reaching Postgres is
//
//     concurrent invocations × DB_POOL_MAX
//
// Leaving it at 20 would mean ten concurrent requests asking for 200
// connections from a server whose smaller Azure SKUs cap out around 50 — the
// failure mode being "too many connections" errors under exactly the load you
// least want them.
//
// So: keep this small and let a POOLER do the multiplexing. Point
// APP_DATABASE_URL at PgBouncer — Azure Flexible Server has it built in on
// port 6432 (General Purpose / Memory Optimized tiers; NOT Burstable, so check
// your SKU). Transaction mode is correct and safe here: `withTenant` scopes
// its tenant with `SET LOCAL`, which is transaction-scoped and therefore
// survives transaction-mode pooling unchanged.
//
// The default is deliberately 2, sized for THIS deployment: de-crm-pg is a
// Burstable B1ms, which caps near 35 connections and — because Azure only
// offers built-in PgBouncer on General Purpose and Memory Optimized — has no
// pooler available to it. Raise this once one is in front of Postgres.
const POOL_MAX = Number(process.env.DB_POOL_MAX ?? 2);

// Surface pool exhaustion instead of letting it read as "the app is slow".
// A connect() that waits longer than this is almost always a handler holding a
// transaction open across something it shouldn't.
const POOL_WAIT_WARN_MS = Number(process.env.DB_POOL_WAIT_WARN_MS ?? 250);

// The pool is built on first use, not at import.
//
// Under Express this module was only ever loaded by a booting server that had
// its env, so validating at module scope was fine. Next imports route modules
// during `next build` to collect page data, where runtime secrets are not
// necessarily present — a module-scope throw turns a missing variable into a
// failed BUILD rather than a clear error on the first request. Deferring also
// means a cold invocation that never touches Postgres never opens a connection.
let _pool: pg.Pool | null = null;

function initPool(): pg.Pool {
  if (_pool) return _pool;

  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    throw new Error("APP_DATABASE_URL is not set. The API must connect as decrm_app, not admin.");
  }
  const usesAzure = url.includes(".postgres.database.azure.com");

  _pool = new pg.Pool({
    connectionString: url,
    ssl: usesAzure ? { rejectUnauthorized: true } : false,
    max: POOL_MAX,
    // Don't let a wedged socket hold a pool slot forever.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  _pool.on("error", (err) => {
    console.error("[db] idle client error:", err.message);
  });

  return _pool;
}

/**
 * The app pool, as a lazy stand-in for the real one.
 *
 * A Proxy rather than a `getAppPool()` function purely so the ~40 existing call
 * sites (`appPool.query`, `appPool.connect`, `appPool.idleCount`, …) keep
 * working untouched. Every property access initialises the pool on demand.
 */
export const appPool: pg.Pool = new Proxy({} as pg.Pool, {
  get(_target, prop) {
    const pool = initPool();
    const value = Reflect.get(pool, prop, pool);
    return typeof value === "function" ? value.bind(pool) : value;
  },
  set(_target, prop, value) {
    return Reflect.set(initPool(), prop, value);
  },
  has(_target, prop) {
    return Reflect.has(initPool(), prop);
  },
});

async function connectWithWaitWarning(label: string) {
  const t0 = Date.now();
  const client = await appPool.connect();
  const waited = Date.now() - t0;
  recordPoolWait(waited);
  if (waited > POOL_WAIT_WARN_MS) {
    console.warn(
      `[db] ${label}: waited ${waited}ms for a pool slot ` +
      `(size ${POOL_MAX}, ${appPool.idleCount} idle, ${appPool.waitingCount} queued). ` +
      `Something is holding a connection too long.`,
    );
  }
  return client;
}

/**
 * withTenant: BEGIN, SET LOCAL app.tenant_id, run callback, COMMIT.
 * All RLS-protected reads and writes go through this. tenantId comes from
 * req.tenantId, which authMiddleware derives from the verified Auth0 JWT.
 *
 * CONTRACT — do not do network I/O inside the callback.
 *
 * The callback runs inside an open transaction holding one of POOL_MAX
 * connections. An `await` on Twilio, Anthropic, Slack or Gmail in here pins
 * that connection for the duration of the call, and once POOL_MAX handlers do
 * it simultaneously every other request in the process blocks on connect().
 * That failure mode presents as "the entire app got slow", with no single slow
 * endpoint to point at, which makes it genuinely hard to diagnose.
 *
 * The shape to use instead is read → commit → call → write:
 *
 *   const ctx  = await withTenant(t, db => loadWhatTheCallNeeds(db));  // txn 1
 *   const resp = await someExternalApi(ctx);                           // no txn held
 *   await withTenant(t, db => recordTheResult(db, resp));              // txn 2
 *
 * This does mean the two writes are no longer atomic with each other. That is
 * the correct trade for an external side effect anyway: the remote call has
 * already happened and cannot be rolled back, so a transaction spanning it was
 * never really giving you atomicity — only contention.
 */
export async function withTenant<T>(tenantId: string, fn: (db: ReturnType<typeof drizzle<typeof schema>>) => Promise<T>): Promise<T> {
  // Validate BEFORE taking a pool slot — a bad tenantId shouldn't cost a
  // connection or an aborted transaction.
  //
  // tenantId must be a valid UUID. We don't string-interpolate user input
  // directly, but a defensive regex helps if upstream ever lets a bad value
  // through into the SET LOCAL below.
  if (!/^[0-9a-fA-F-]{36}$/.test(tenantId)) {
    throw new Error("withTenant: invalid tenantId");
  }
  const client = await connectWithWaitWarning("withTenant");
  const t0 = Date.now();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const tx = drizzle(client as unknown as pg.Pool, { schema });
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
    // Attributed to "db" for Server-Timing. This is transaction wall-clock, so
    // it includes BEGIN/COMMIT and any in-callback compute — which is what we
    // want, since the connection is genuinely held for all of it.
    recordDbTime(Date.now() - t0);
  }
}

/**
 * A tenant-scoped `db` whose every statement is its own short transaction.
 *
 * The escape hatch for code that must interleave queries with slow external
 * calls and therefore cannot sit inside a single `withTenant` — long-running
 * agent graphs, OAuth token refresh paths. Each `execute` opens
 * BEGIN / SET LOCAL app.tenant_id / COMMIT around one statement, so RLS scopes
 * the query exactly as `withTenant` does, but the connection returns to the
 * pool immediately instead of being pinned for the caller's whole lifetime.
 *
 * Trade-off: statements are NOT atomic with one another. Reach for this only
 * where there is no multi-statement invariant to protect. When you do need
 * atomicity, use `withTenant` around that specific unit of work.
 */
export type TenantExec = Pick<ReturnType<typeof drizzle<typeof schema>>, "execute">;

export function tenantExec(tenantId: string): TenantExec {
  return {
    execute: ((query: unknown) =>
      withTenant(tenantId, (db) => db.execute(query as never))) as TenantExec["execute"],
  };
}
