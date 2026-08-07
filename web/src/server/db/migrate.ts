// Apply all pending migrations from ./drizzle. Run: npm run db:migrate
//
// Two-tier execution:
//
//   1. Drizzle-generated DDL migrations (0000_*.sql, 0001_*.sql, …). Drizzle
//      tracks its own ledger in `drizzle.__drizzle_migrations` and only
//      applies unseen ones. We just delegate.
//
//   2. Hand-written post-*.sql migrations. We track OUR ledger in a
//      dedicated table `_decrm_post_migrations` so already-applied files
//      never re-run on the same DB.
//
//      On first-ever run against a DB that predates this ledger, the
//      runner is bootstrapped via env var:
//         --bootstrap=post-0057-…sql
//      (or DECRM_MIGRATIONS_BASELINE=post-0057-…sql)
//      That marks EVERY post-*.sql up to and including the given file as
//      "already applied" without executing them. Only files newer than the
//      baseline actually run.
//
//      Without a bootstrap arg, the first run against an unmigrated DB will
//      execute EVERY post-*.sql from scratch (correct behaviour for a fresh
//      DB); subsequent runs only execute newly-added files.

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool } from "./client";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// The migrations directory, resolved from this file's own location rather than
// the cwd, so the script behaves the same however it's invoked.
//
// Depth is `../../../` because this file sits at web/src/server/db/ — it was
// `../../` at api/src/db/, and moving one level deeper during the Express →
// Next migration is what broke it.
//
// fileURLToPath rather than `.pathname.replace(/^\//, "")`: on Windows a file:
// URL's pathname is `/C:/…`, which readdirSync rejects. Handling that is
// exactly fileURLToPath's job, and using it removes the platform branch this
// code used to carry.
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../drizzle/", import.meta.url));

async function main() {
  // 0. Extensions must exist BEFORE Drizzle runs CREATE TABLE (embedding uses vector).
  console.log("→ ensuring extensions…");
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);

  // 1. Run Drizzle-generated migrations (DDL for tables/indexes/checks).
  console.log("→ applying drizzle migrations…");
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  // 2. Ensure our post-migration ledger exists.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "_decrm_post_migrations" (
      "filename"   text PRIMARY KEY,
      "applied_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);

  // 3. Discover all post-*.sql files.
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("post-") && f.endsWith(".sql")).sort();

  // 4. Optional bootstrap: mark every file up to and including
  //    <baseline> as applied WITHOUT running its SQL. Useful on DBs where
  //    older migrations have already been applied historically (e.g. dev/qa/prod
  //    that predate this ledger).
  const flagBootstrap = process.argv.find((a) => a.startsWith("--bootstrap="));
  const baseline = flagBootstrap
    ? flagBootstrap.slice("--bootstrap=".length).trim()
    : (process.env.DECRM_MIGRATIONS_BASELINE?.trim() || "");

  if (baseline) {
    if (!files.includes(baseline)) {
      throw new Error(`--bootstrap value '${baseline}' is not one of the post-*.sql files on disk.`);
    }
    console.log(`→ bootstrapping ledger up to and including ${baseline} (no SQL will be executed for those)…`);
    for (const f of files) {
      await pool.query(
        `INSERT INTO "_decrm_post_migrations" (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
        [f],
      );
      if (f === baseline) break;
    }
  }

  // 5. Load the ledger and skip anything already applied.
  const applied = new Set(
    (await pool.query<{ filename: string }>(
      `SELECT filename FROM "_decrm_post_migrations"`,
    )).rows.map((r) => r.filename),
  );

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log("✓ no new post-*.sql migrations to apply.");
  }

  for (const f of pending) {
    console.log(`→ applying ${f}…`);
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    await pool.query(sql);
    await pool.query(
      `INSERT INTO "_decrm_post_migrations" (filename) VALUES ($1)`,
      [f],
    );
  }

  // 6. App role password — only set if DECRM_APP_PASSWORD env var provided.
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
