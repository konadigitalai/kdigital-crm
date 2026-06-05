// Connect as decrm_app (NOBYPASSRLS) and prove RLS works:
//  - no GUC set → escape hatch lets us see everything (intentional for system jobs)
//  - GUC set to fake tenant → 0 rows
//  - GUC set to real tenant → 12 leads
import "dotenv/config";
import pg from "pg";

const url = process.env.APP_DATABASE_URL;
if (!url) throw new Error("APP_DATABASE_URL not set in .env");

const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: true },
});

async function main() {
  const who = await pool.query<{ usename: string; usebypassrls: boolean }>(`
    SELECT current_user AS usename, rolbypassrls AS usebypassrls
    FROM pg_roles WHERE rolname = current_user
  `);
  console.log("connecting role:", who.rows[0]);

  // Real tenant id
  const t = await pool.query<{ id: string }>(`SELECT id FROM tenant LIMIT 1`);
  const realTenant = t.rows[0]!.id;
  console.log("real tenant:", realTenant);

  // 1. Fake tenant — should see 0 leads
  const c1 = await pool.connect();
  try {
    await c1.query("BEGIN");
    await c1.query(`SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000000'`);
    const r = await c1.query<{ n: string }>(`SELECT count(*)::text AS n FROM lead`);
    const ok = r.rows[0]!.n === "0";
    console.log(`fake tenant → ${r.rows[0]!.n} leads ${ok ? "✓" : "✗ LEAK"}`);
    await c1.query("COMMIT");
  } finally {
    c1.release();
  }

  // 2. Real tenant — should see 12 leads
  const c2 = await pool.connect();
  try {
    await c2.query("BEGIN");
    await c2.query(`SET LOCAL app.tenant_id = '${realTenant}'`);
    const r = await c2.query<{ n: string }>(`SELECT count(*)::text AS n FROM lead`);
    const ok = r.rows[0]!.n === "12";
    console.log(`real tenant → ${r.rows[0]!.n} leads ${ok ? "✓" : "✗"}`);
    await c2.query("COMMIT");
  } finally {
    c2.release();
  }

  // 3. Audit log immutability — granted INSERT only. UPDATE/DELETE refused at privilege layer.
  const c3 = await pool.connect();
  try {
    await c3.query("BEGIN");
    await c3.query(`SET LOCAL app.tenant_id = '${realTenant}'`);
    await c3.query(`INSERT INTO audit_log(tenant_id, actor_type, action) VALUES ('${realTenant}', 'system', 'rls_test')`);
    try {
      await c3.query(`UPDATE audit_log SET action = 'tampered' WHERE action = 'rls_test'`);
      console.log("✗ audit_log UPDATE allowed (should be blocked)");
    } catch (err) {
      console.log("audit_log UPDATE blocked ✓ (" + (err as Error).message + ")");
    }
    await c3.query("ROLLBACK");
  } finally {
    c3.release();
  }

  await pool.end();
}

main().catch((err) => {
  console.error("✗", err);
  process.exit(1);
});
