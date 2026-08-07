// Preflight check: is this DB ready to receive Twilio webhooks?
//
// Read-only. Runs a series of green/red diagnostics against whichever DB
// DATABASE_URL points to. Handy for verifying dev/qa/prod after a fresh
// migration.
//
// Run:  DATABASE_URL=<target-db-url> npm run db:twilio-preflight
//   or just: npm run db:twilio-preflight  (uses api/.env's DATABASE_URL)

import { pool } from "./client";

type CheckResult = { name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];

function pass(name: string, detail: string) {
  results.push({ name, ok: true, detail });
}
function fail(name: string, detail: string) {
  results.push({ name, ok: false, detail });
}

async function main() {
  // 0. Which DB are we hitting?
  try {
    const r = await pool.query<{ db: string; user: string }>(
      `SELECT current_database() AS db, current_user AS user`,
    );
    pass("Connection", `db=${r.rows[0]!.db} user=${r.rows[0]!.user}`);
  } catch (err) {
    fail("Connection", (err as Error).message);
    return report();   // Nothing else runs if we can't connect.
  }

  // 1. Twilio tables exist?
  await checkTableExists("tw_conversation");
  await checkTableExists("tw_message");

  // 2. Partial unique index for ON CONFLICT?
  try {
    const r = await pool.query(`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'tw_message' AND indexname = 'tw_message_provider_message_id_key'
    `);
    if (r.rowCount) {
      const idx = (r.rows[0] as { indexdef: string }).indexdef;
      const hasWhere = idx.toLowerCase().includes("where");
      if (hasWhere) pass("Partial unique index on tw_message.provider_message_id", "present");
      else fail("Partial unique index on tw_message.provider_message_id",
        "index exists but WHERE clause missing — ON CONFLICT will 42P10");
    } else {
      fail("Partial unique index on tw_message.provider_message_id", "not found — migration didn't run");
    }
  } catch (err) {
    fail("Partial unique index check", (err as Error).message);
  }

  // 3. current_tenant() function exists?
  try {
    await pool.query(`SELECT current_tenant()`);
    pass("current_tenant() function", "callable");
  } catch (err) {
    fail("current_tenant() function",
      `not callable — RLS/party-tenant migrations may be missing: ${(err as Error).message.slice(0, 100)}`);
  }

  // 4. At least one tenant row?
  try {
    const r = await pool.query<{ n: string; latest_id: string; latest_name: string }>(`
      SELECT COUNT(*)::text AS n,
             (SELECT id::text FROM tenant ORDER BY created_at DESC LIMIT 1) AS latest_id,
             (SELECT name FROM tenant ORDER BY created_at DESC LIMIT 1) AS latest_name
      FROM tenant
    `);
    const n = Number(r.rows[0]!.n);
    if (n > 0) {
      pass("Tenant rows",
        `${n} row(s); newest = ${r.rows[0]!.latest_name} (${r.rows[0]!.latest_id})`);
    } else {
      fail("Tenant rows",
        "0 tenants in the DB — inbound webhook will 200 silently with no work done");
    }
  } catch (err) {
    fail("Tenant rows", (err as Error).message);
  }

  // 5. Sentinel party per tenant?
  try {
    const r = await pool.query<{ n: string; tid: string; tname: string }>(`
      SELECT COUNT(*)::text AS n,
             (SELECT tenant_id::text FROM party WHERE is_system=true ORDER BY created_at DESC LIMIT 1) AS tid,
             (SELECT t.name FROM party p JOIN tenant t ON t.id = p.tenant_id
              WHERE p.is_system=true ORDER BY p.created_at DESC LIMIT 1) AS tname
      FROM party WHERE is_system = true
    `);
    const n = Number(r.rows[0]!.n);
    if (n > 0) {
      pass("Sentinel party (system actor)",
        `${n} row(s); newest is in tenant "${r.rows[0]!.tname ?? "?"}"`);
    } else {
      fail("Sentinel party (system actor)",
        "no is_system=true party — inbound webhook activity insert will throw. " +
        "Run `npm run db:seed` or manually INSERT one.");
    }
  } catch (err) {
    fail("Sentinel party check", (err as Error).message);
  }

  // 6. Table grants for decrm_app?
  try {
    const r = await pool.query<{ privilege_type: string; table_name: string }>(`
      SELECT privilege_type, table_name
      FROM information_schema.role_table_grants
      WHERE grantee = 'decrm_app'
        AND table_name IN ('tw_conversation','tw_message')
    `);
    const wanted = new Set(["SELECT","INSERT","UPDATE","DELETE"]);
    const gotByTable: Record<string, Set<string>> = {};
    for (const row of r.rows) {
      (gotByTable[row.table_name] ??= new Set()).add(row.privilege_type);
    }
    for (const tbl of ["tw_conversation","tw_message"]) {
      const got = gotByTable[tbl] ?? new Set();
      const missing = [...wanted].filter((p) => !got.has(p));
      if (missing.length === 0) {
        pass(`Grants on ${tbl}`, "SELECT/INSERT/UPDATE/DELETE all present for decrm_app");
      } else {
        fail(`Grants on ${tbl}`, `decrm_app missing: ${missing.join(",")}`);
      }
    }
  } catch (err) {
    fail("Grants check", (err as Error).message);
  }

  // 7. RLS enabled + policy present?
  try {
    const r = await pool.query<{ table_name: string; rls_on: boolean; policy_count: string }>(`
      SELECT c.relname AS table_name,
             c.relrowsecurity AS rls_on,
             (SELECT COUNT(*)::text FROM pg_policies WHERE tablename = c.relname) AS policy_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('tw_conversation','tw_message')
    `);
    for (const row of r.rows) {
      if (row.rls_on && Number(row.policy_count) > 0) {
        pass(`RLS on ${row.table_name}`, `enabled, ${row.policy_count} policy/policies`);
      } else if (!row.rls_on) {
        fail(`RLS on ${row.table_name}`,
          "not enabled — cross-tenant leak risk (should be ENABLE + FORCE)");
      } else {
        fail(`RLS on ${row.table_name}`, "enabled but no policies — every query will return 0 rows");
      }
    }
  } catch (err) {
    fail("RLS check", (err as Error).message);
  }

  // 8. Any leftover wa_* tables? (leftover from pre-Twilio schema)
  try {
    const r = await pool.query<{ n: string; names: string }>(`
      SELECT COUNT(*)::text AS n,
             string_agg(table_name, ', ' ORDER BY table_name) AS names
      FROM information_schema.tables
      WHERE table_schema='public' AND table_name LIKE 'wa_%'
    `);
    const n = Number(r.rows[0]!.n);
    if (n === 0) pass("Legacy wa_* tables cleaned up", "none present");
    else {
      // Not a failure — old data might still be around — but flag it.
      pass("Legacy wa_* tables",
        `${n} still present: ${r.rows[0]!.names} (post-0065 removes these; harmless if unused)`);
    }
  } catch (err) {
    fail("Legacy wa_* check", (err as Error).message);
  }

  report();
}

function report() {
  console.log();
  console.log("═".repeat(70));
  console.log(" Twilio DB preflight");
  console.log("═".repeat(70));
  for (const r of results) {
    const glyph = r.ok ? "✓" : "✗";
    console.log(`${glyph} ${r.name.padEnd(48)} ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log("─".repeat(70));
  if (failed.length === 0) {
    console.log(`${results.length}/${results.length} checks passed. DB is ready.`);
  } else {
    console.log(`${results.length - failed.length}/${results.length} passed; ${failed.length} failed.`);
    console.log();
    console.log("Failures block Twilio inbound from working end-to-end.");
    process.exitCode = 1;
  }
  return pool.end();
}

async function checkTableExists(name: string) {
  try {
    const r = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema='public' AND table_name=$1
       ) AS exists`,
      [name],
    );
    if (r.rows[0]!.exists) pass(`Table ${name}`, "exists");
    else fail(`Table ${name}`, "MISSING — migration didn't run");
  } catch (err) {
    fail(`Table ${name}`, (err as Error).message);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
