// Apply all pending migrations from ./drizzle. Run: npm run db:migrate
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool } from "./client.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

async function main() {
  // 0. Extensions must exist BEFORE Drizzle runs CREATE TABLE (embedding uses vector).
  console.log("→ ensuring extensions…");
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);

  // 1. Run Drizzle-generated migrations (DDL for tables/indexes/checks).
  console.log("→ applying drizzle migrations…");
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./drizzle" });

  // 2. Run hand-written post-migration SQL (extensions, sequences, RLS, GRANTs).
  //    Files matching post-*.sql in ./drizzle, alphabetical order.
  const here = new URL("../../drizzle/", import.meta.url).pathname.replace(/^\//, "");
  const dir = process.platform === "win32" ? here : "./drizzle";
  const files = readdirSync(dir).filter((f) => f.startsWith("post-") && f.endsWith(".sql")).sort();

  for (const f of files) {
    console.log(`→ applying ${f}…`);
    const sql = readFileSync(join(dir, f), "utf8");
    await pool.query(sql);
  }

  // App role password — only set if DECRM_APP_PASSWORD env var provided.
  // Keeps the password out of SQL files committed to git.
  if (process.env.DECRM_APP_PASSWORD) {
    console.log("→ setting decrm_app password…");
    const pw = process.env.DECRM_APP_PASSWORD.replace(/'/g, "''");
    await pool.query(`ALTER ROLE decrm_app WITH PASSWORD '${pw}'`);
  } else {
    console.log("ℹ DECRM_APP_PASSWORD not set — app role exists but has placeholder password");
  }

  console.log("✓ migrations complete");
  await pool.end();
}

main().catch((err) => {
  console.error("✗ migration failed:", err.message);
  process.exit(1);
});
