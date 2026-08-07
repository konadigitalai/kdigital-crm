// Parse every SQL query in the routers against the real schema.
//
//   npm run db:verify-queries
//
// Exists because of a production outage. post-0094 removed a join but left
// `ORDER BY s.name` behind, and GET /catalog 500'd with "missing FROM-clause
// entry for table s" — taking out the New Lead dialog and every dropdown that
// endpoint feeds. It compiled, typechecked and deployed clean, because
// TypeScript cannot see inside a sql`` template. Nothing in the pipeline was
// looking at the SQL itself.
//
// This looks. Each query is sent to Postgres wrapped in EXPLAIN, which runs
// the parser and the planner but NOT the query — so a missing table, a
// missing column or a dangling alias is caught, and no row is ever read or
// written.
//
// Read-only and safe against any database, including production.
//
// It cannot catch everything. Queries assembled from several sql`` fragments
// are skipped, because a fragment on its own is not valid SQL — those are
// listed at the end so the gap is visible rather than silently assumed away.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pool } from "./client";
import { fileURLToPath } from "node:url";

interface Found { file: string; line: number; sql: string }

// Sibling directories of db/ — web/src/server/{routes,lib}. The non-Windows
// branch this replaced was cwd-relative (`./src/routes`) and pointed at the
// wrong place after the move; resolving from import.meta.url is correct on
// both platforms and independent of cwd.
function sourceDir(sub: string): string {
  return fileURLToPath(new URL(`../${sub}/`, import.meta.url));
}

function collect(dir: string, prefix: string): Found[] {
  const out: Found[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...collect(join(dir, entry.name), `${prefix}${entry.name}/`));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const src = readFileSync(join(dir, entry.name), "utf8");

    // sql`...` with no nested backtick. Good enough: a template containing
    // another template is a composed fragment, which we skip anyway.
    for (const m of src.matchAll(/\bsql`([^`]*)`/g)) {
      out.push({
        file: `${prefix}${entry.name}`,
        line: src.slice(0, m.index).split("\n").length,
        sql: m[1] ?? "",
      });
    }
  }
  return out;
}

// ${...} placeholders become NULL. The planner only needs the SHAPE — it is
// checking that tables, columns and aliases resolve, not what the values are.
function substitute(q: string): string {
  return q.replace(/\$\{[^}]*\}/g, "NULL");
}

function isStandalone(q: string): boolean {
  const s = q.trim().toUpperCase();
  if (!s) return false;
  // Only statements the planner accepts, and only complete ones. A bare
  // fragment ("WHERE x = NULL", a column list) is not checkable in isolation.
  if (!/^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/.test(s)) return false;
  // A composed fragment leaves a NULL where a whole clause belonged.
  if (/\bFROM\s+NULL\b/.test(s) || /\bJOIN\s+NULL\b/.test(s)) return false;
  if (/^\s*SELECT\b/.test(s) && !/\bFROM\b/.test(s) && !/\bNULL\b/.test(s)) return false;
  return true;
}

async function main() {
  const db = (await pool.query<{ d: string }>("SELECT current_database() AS d")).rows[0]!.d;
  const found = [
    ...collect(sourceDir("routes"), "routes/"),
    ...collect(sourceDir("lib"), "lib/"),
  ];

  console.log(`\ndatabase : ${db}`);
  console.log(`found    : ${found.length} sql\`\` blocks`);
  console.log(`mode     : EXPLAIN only — parses and plans, executes nothing\n`);

  const failures: Array<Found & { error: string }> = [];
  let checked = 0;
  const skipped: Found[] = [];
  const uncheckable: Found[] = [];

  for (const f of found) {
    const q = substitute(f.sql);
    if (!isStandalone(q)) { skipped.push(f); continue; }

    // Every statement is planned inside a transaction that is rolled back.
    // EXPLAIN without ANALYZE does not execute, but the rollback means even a
    // mistake in this script cannot write.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`EXPLAIN ${q}`);
      checked++;
    } catch (err) {
      const e = err as Error & { code?: string };
      // Only two error classes are the QUERY's fault. Everything else is
      // this script's: replacing ${...} with NULL breaks any query whose
      // placeholder held a clause rather than a value (a dynamic SET list,
      // a composed WHERE), and that shows up as a syntax or type error.
      //
      //   42P01  undefined_table   — missing table OR a dangling alias,
      //                              which is exactly the catalog bug
      //   42703  undefined_column  — column renamed or removed
      //
      // Narrow on purpose. A checker that cries wolf gets ignored, and an
      // ignored checker is worse than none.
      if (e.code === "42P01" || e.code === "42703") failures.push({ ...f, error: e.message });
      else uncheckable.push(f);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  if (failures.length) {
    console.log("FAILED TO PLAN:\n");
    for (const f of failures) {
      console.log(`  ${f.file}:${f.line}`);
      console.log(`    ${f.error.split("\n")[0]}`);
      console.log(`    ${f.sql.trim().replace(/\s+/g, " ").slice(0, 150)}`);
      console.log("");
    }
  }

  console.log(`${checked} planned OK, ${failures.length} REAL failure(s), ` +
              `${skipped.length + uncheckable.length} not checkable in isolation`);
  if (skipped.length) {
    console.log(`\n${skipped.length} skipped as composed fragments — not checkable alone:`);
    const byFile = new Map<string, number>();
    for (const s of skipped) byFile.set(s.file, (byFile.get(s.file) ?? 0) + 1);
    for (const [file, n] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`  ${String(n).padStart(3)}  ${file}`);
    }
  }

  await pool.end();
  if (failures.length) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error("verify-queries failed:", (err as Error).message);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
