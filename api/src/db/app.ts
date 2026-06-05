// App-role pool: connects as decrm_app (NOBYPASSRLS).
// All HTTP handlers go through this pool, not the admin pool.
import "dotenv/config";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

const url = process.env.APP_DATABASE_URL;
if (!url) {
  throw new Error("APP_DATABASE_URL is not set. The API must connect as decrm_app, not admin.");
}

const usesAzure = url.includes(".postgres.database.azure.com");
export const appPool = new pg.Pool({
  connectionString: url,
  ssl: usesAzure ? { rejectUnauthorized: true } : false,
  max: 10,
});

// withTenant: BEGIN, SET LOCAL app.tenant_id, run callback, COMMIT.
// All RLS-protected reads go through this. tenantId comes from req.tenantId
// (currently hard-coded by middleware until Auth0 is wired in).
export async function withTenant<T>(tenantId: string, fn: (db: ReturnType<typeof drizzle<typeof schema>>) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    // tenantId must be a valid UUID — we don't string-interpolate user input directly,
    // but a defensive UUID regex helps if upstream ever lets a bad value through.
    if (!/^[0-9a-fA-F-]{36}$/.test(tenantId)) {
      throw new Error("withTenant: invalid tenantId");
    }
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
  }
}
