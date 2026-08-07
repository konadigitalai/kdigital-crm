// Read-only diagnostic: what DB am I actually connected to, and do
// the Slack tables exist there?
import { pool } from "./client";

async function main() {
  const info = await pool.query<{ current_database: string; server_version: string }>(
    `SELECT current_database(), version() AS server_version`,
  );
  console.log("connected to database:", info.rows[0].current_database);

  const tables = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE 'slack%'
      ORDER BY tablename`,
  );
  console.log("slack tables here:", tables.rows.map((r) => r.tablename).join(", ") || "(none)");

  // Does slack_user_link exist? If so, count rows.
  try {
    const c = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM slack_user_link`);
    console.log("slack_user_link row count:", c.rows[0].n);
  } catch (err) {
    console.log("slack_user_link:", (err as Error).message);
  }

  await pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
