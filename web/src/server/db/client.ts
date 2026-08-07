import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

// This module is only reached by the ops scripts under db/ (migrate, seed,
// check, …). The app itself goes through db/app.ts, whose env Next.js loads.
//
// Those scripts run under `tsx`, which loads no env file at all, so this has to
// do it. Two things were wrong before:
//
//   • `import "dotenv/config"` reads `.env`, but Next.js reads `.env.local`.
//     Credentials therefore had to be written twice, and running a migration
//     meant exporting DATABASE_URL by hand every session — one lost shell away
//     from migrating the wrong database.
//   • dotenv resolves relative to the cwd, so the scripts only worked when
//     invoked from web/.
//
// Now both read the SAME file, resolved from this module's location. Precedence
// is shell > .env.local > .env, because dotenv never overwrites a variable that
// is already set — so `$env:DATABASE_URL=…` still wins for a one-off run
// against a different database.
const WEB_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
dotenv.config({ path: join(WEB_ROOT, ".env.local") });
dotenv.config({ path: join(WEB_ROOT, ".env") });

const { Pool } = pg;

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Add it to web/.env.local (see web/.env.example), " +
    "or export it for a one-off run against a different database.",
  );
}

// Azure Postgres Flexible Server uses the public CA chain — Node's default trust
// store accepts it. We just enforce TLS + cert validation. No CA file needed.
const usesAzure = url.includes(".postgres.database.azure.com");
export const pool = new Pool({
  connectionString: url,
  ssl: usesAzure ? { rejectUnauthorized: true } : false,
  max: 10,
});

export const db = drizzle(pool, { schema });

export async function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  // GUC for RLS — set per-request once routes exist. Used in seed too.
  const client = await pool.connect();
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    return await fn();
  } finally {
    client.release();
  }
}
