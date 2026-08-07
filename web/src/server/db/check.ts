// Connection sanity check. Run: npm run db:check
import { pool } from "./client";

const required = ["pgcrypto", "pg_trgm", "vector"];

async function main() {
  console.log("Connecting…");
  const res = await pool.query<{ version: string }>("SELECT version()");
  console.log("✓ connected:", res.rows[0]?.version?.split(",")[0]);

  const ext = await pool.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname = ANY($1::text[])`,
    [required],
  );
  const installed = new Set(ext.rows.map((r) => r.extname));
  for (const r of required) {
    console.log(installed.has(r) ? `✓ extension ${r}` : `✗ extension ${r} MISSING`);
  }

  const dbName = await pool.query<{ current_database: string }>("SELECT current_database()");
  console.log("✓ database:", dbName.rows[0]?.current_database);

  await pool.end();
}

main().catch((err) => {
  console.error("✗", err.message);
  process.exit(1);
});
