// Diagnose RLS: is the policy itself broken, or is our verify code wrong?
import { pool } from "./client";

async function main() {
  // 1. Connecting role + bypass attributes
  const who = await pool.query<{ usename: string; usebypassrls: boolean; useissuper: boolean }>(`
    SELECT current_user AS usename,
           rolbypassrls AS usebypassrls,
           rolsuper     AS useissuper
    FROM pg_roles WHERE rolname = current_user
  `);
  console.log("role:", who.rows[0]);

  // 2. Is RLS forced on lead?
  const tbl = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
    SELECT relname, relrowsecurity, relforcerowsecurity
    FROM pg_class WHERE relname = 'lead'
  `);
  console.log("lead table RLS state:", tbl.rows[0]);

  // 3. Reproduce the leak — proper transaction this time
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000000'`);
    const guc = await c.query<{ x: string }>(`SELECT current_setting('app.tenant_id') AS x`);
    console.log("GUC inside txn:", guc.rows[0]);
    const ct = await c.query<{ x: string | null }>(`SELECT current_tenant()::text AS x`);
    console.log("current_tenant() inside txn:", ct.rows[0]);
    const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM lead`);
    console.log(`lead rows visible to fake tenant: ${r.rows[0]!.n}`);
    await c.query("COMMIT");
  } finally {
    c.release();
  }

  await pool.end();
}

main().catch((err) => {
  console.error("✗", err);
  process.exit(1);
});
