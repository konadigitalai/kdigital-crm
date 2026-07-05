// Compare schema structure between two Postgres databases.
//
// Reads a normalised snapshot of tables, columns, indexes, constraints, RLS
// policies, and triggers from each DB and diffs them. Fails loudly (non-zero
// exit) if anything differs.
//
// Usage:
//   DB_A='postgres://…prod-url…' \
//   DB_B='postgres://…qa-or-dev-url…' \
//   node .diff-schemas.mjs
//
// Only reads. Never writes. Safe to run against prod as decrm_admin.

import pg from "pg";

const A_URL = process.env.DB_A;
const B_URL = process.env.DB_B;
if (!A_URL || !B_URL) {
  console.error("Set DB_A and DB_B env vars to two connection strings.");
  process.exit(2);
}

async function snapshot(label, url) {
  const p = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    // 1. Every table + column signature.
    const cols = await p.query(`
      SELECT
        table_name,
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);

    // 2. Every index (name + definition).
    const idx = await p.query(`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname
    `);

    // 3. Every constraint (checks + FKs + uniques).
    const cons = await p.query(`
      SELECT
        conrelid::regclass::text AS table_name,
        conname,
        contype,
        pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace
      ORDER BY table_name, conname
    `);

    // 4. RLS state per table.
    const rls = await p.query(`
      SELECT c.relname AS table_name,
             c.relrowsecurity  AS enabled,
             c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    `);

    // 5. Row-level policies.
    const pol = await p.query(`
      SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename, policyname
    `);

    // 6. Triggers.
    const trg = await p.query(`
      SELECT event_object_table AS table_name, trigger_name, event_manipulation, action_statement
      FROM information_schema.triggers
      WHERE trigger_schema = 'public'
      ORDER BY table_name, trigger_name
    `);

    return {
      label,
      cols: cols.rows,
      idx: idx.rows,
      cons: cons.rows,
      rls: rls.rows,
      pol: pol.rows,
      trg: trg.rows,
    };
  } finally {
    await p.end();
  }
}

function keyed(rows, keyFn) {
  const map = new Map();
  for (const r of rows) map.set(keyFn(r), r);
  return map;
}

function diffMaps(a, b, describe) {
  const onlyA = [];
  const onlyB = [];
  const changed = [];
  for (const [k, v] of a) {
    if (!b.has(k)) onlyA.push(k);
    else if (JSON.stringify(v) !== JSON.stringify(b.get(k))) changed.push({ k, a: v, b: b.get(k) });
  }
  for (const k of b.keys()) if (!a.has(k)) onlyB.push(k);
  return { section: describe, onlyA, onlyB, changed };
}

function report(section, diff, labelA, labelB) {
  const total = diff.onlyA.length + diff.onlyB.length + diff.changed.length;
  if (total === 0) {
    console.log(`  ${section.padEnd(20)} ✓ identical`);
    return true;
  }
  console.log(`\n  ${section.padEnd(20)} ✗ ${total} difference${total === 1 ? "" : "s"}`);
  for (const k of diff.onlyA) console.log(`    · only in ${labelA}: ${k}`);
  for (const k of diff.onlyB) console.log(`    · only in ${labelB}: ${k}`);
  for (const c of diff.changed) {
    console.log(`    · differs: ${c.k}`);
    console.log(`        ${labelA}: ${JSON.stringify(c.a)}`);
    console.log(`        ${labelB}: ${JSON.stringify(c.b)}`);
  }
  return false;
}

const [A, B] = await Promise.all([
  snapshot("DB_A", A_URL),
  snapshot("DB_B", B_URL),
]);

console.log(`\nDB_A: ${A.label} — ${A.cols.length} columns, ${A.idx.length} indexes, ${A.cons.length} constraints`);
console.log(`DB_B: ${B.label} — ${B.cols.length} columns, ${B.idx.length} indexes, ${B.cons.length} constraints`);
console.log("\n── Schema diff ──");

let ok = true;

ok = report("columns",
  diffMaps(
    keyed(A.cols, (r) => `${r.table_name}.${r.column_name}`),
    keyed(B.cols, (r) => `${r.table_name}.${r.column_name}`),
    "columns",
  ), "A", "B",
) && ok;

ok = report("indexes",
  diffMaps(
    keyed(A.idx, (r) => `${r.tablename}.${r.indexname}`),
    keyed(B.idx, (r) => `${r.tablename}.${r.indexname}`),
    "indexes",
  ), "A", "B",
) && ok;

ok = report("constraints",
  diffMaps(
    keyed(A.cons, (r) => `${r.table_name}.${r.conname}`),
    keyed(B.cons, (r) => `${r.table_name}.${r.conname}`),
    "constraints",
  ), "A", "B",
) && ok;

ok = report("RLS flags",
  diffMaps(
    keyed(A.rls, (r) => r.table_name),
    keyed(B.rls, (r) => r.table_name),
    "RLS flags",
  ), "A", "B",
) && ok;

ok = report("RLS policies",
  diffMaps(
    keyed(A.pol, (r) => `${r.tablename}.${r.policyname}`),
    keyed(B.pol, (r) => `${r.tablename}.${r.policyname}`),
    "RLS policies",
  ), "A", "B",
) && ok;

ok = report("triggers",
  diffMaps(
    keyed(A.trg, (r) => `${r.table_name}.${r.trigger_name}`),
    keyed(B.trg, (r) => `${r.table_name}.${r.trigger_name}`),
    "triggers",
  ), "A", "B",
) && ok;

console.log("\n" + (ok
  ? "✓ Schemas are identical."
  : "✗ Schemas differ. See above."));
process.exit(ok ? 0 : 1);
