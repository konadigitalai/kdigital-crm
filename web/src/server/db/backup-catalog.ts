// One-shot backup for the catalog v2 migration (post-0054-catalog-stacks.sql).
//
// Copies program, course, cohort, enrolment, course_assignment, batch_assignment
// into a dated schema so we have a per-row rollback if the migration goes wrong.
//
// Usage:
//   DATABASE_URL='postgres://decrm_admin:...@.../postgres?sslmode=require' \
//     npx tsx src/db/backup-catalog.ts
//
// Requires the admin role (decrm_app can't CREATE SCHEMA). Idempotent per-day:
// if the schema already exists from an earlier attempt today, the run fails fast
// so we don't silently overwrite an existing backup — pass a suffix to force a
// new one, e.g. `npx tsx src/db/backup-catalog.ts retry2`.

import { pool } from "./client";

const TABLES = [
  "program",
  "course",
  "cohort",
  "enrolment",
  "course_assignment",
  "batch_assignment",
];

async function main() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const suffix = process.argv[2]?.trim();
  const schema = `backup_catalog_${stamp}${suffix ? `_${suffix}` : ""}`;

  console.log(`→ target schema: ${schema}`);

  const client = await pool.connect();
  try {
    // Refuse if the schema is already there — user should explicitly pick a
    // suffix rather than silently clobber a prior backup.
    const exists = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS exists`,
      [schema],
    );
    if (exists.rows[0]?.exists) {
      console.error(`✗ schema ${schema} already exists. Pass a suffix arg to create a new one, e.g.:`);
      console.error(`  npx tsx src/db/backup-catalog.ts retry2`);
      process.exit(1);
    }

    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    for (const t of TABLES) {
      // AS TABLE copies both structure and rows. Constraints/indexes are NOT
      // copied — that's fine for a rollback source, we only need the data.
      await client.query(`CREATE TABLE ${schema}.${t} AS TABLE ${t}`);
      const c = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${schema}.${t}`);
      console.log(`  ${t.padEnd(20)} → ${c.rows[0]?.n} rows`);
    }
    await client.query("COMMIT");
    console.log(`✓ backup complete in schema ${schema}`);
    console.log(``);
    console.log(`  To roll back after the migration (data only — schema DDL from post-0054 is NOT undone):`);
    console.log(`    TRUNCATE program_course, program, course, cohort, enrolment, course_assignment, batch_assignment CASCADE;`);
    for (const t of TABLES) {
      console.log(`    INSERT INTO ${t} SELECT * FROM ${schema}.${t};`);
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("✗ backup failed:", (err as Error).message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("✗ unexpected error:", err);
  process.exit(1);
});
