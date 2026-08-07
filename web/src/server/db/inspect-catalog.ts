// Diagnostic: report the DB state of the catalog tables so we can tell
// what post-*.sql migrations have and haven't run.
//
// Usage: npx tsx src/db/inspect-catalog.ts

import { pool } from "./client";

async function main() {
  const q = await pool.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('program','course','program_course','cohort','enrolment','party')
      ORDER BY table_name, ordinal_position`,
  );

  const byTable = new Map<string, string[]>();
  for (const r of q.rows) {
    const arr = byTable.get(r.table_name) ?? [];
    arr.push(`${r.column_name}: ${r.data_type}${r.is_nullable === "NO" ? " NOT NULL" : ""}`);
    byTable.set(r.table_name, arr);
  }

  for (const t of ["program","course","program_course","cohort","enrolment"]) {
    const cols = byTable.get(t);
    if (!cols) console.log(`${t.padEnd(16)} — TABLE DOES NOT EXIST`);
    else {
      console.log(`\n${t}:`);
      for (const c of cols) console.log(`  ${c}`);
    }
  }

  // Party ledger columns
  const partyCols = byTable.get("party") ?? [];
  console.log("\nparty (fee ledger columns only):");
  for (const c of partyCols.filter((s) => /fee_|due_date|payment_/.test(s))) {
    console.log(`  ${c}`);
  }
  if (!partyCols.some((s) => /fee_quoted/.test(s))) console.log("  (post-0055 not applied yet)");

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
