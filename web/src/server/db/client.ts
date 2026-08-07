import "dotenv/config";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

const { Pool } = pg;

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
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
