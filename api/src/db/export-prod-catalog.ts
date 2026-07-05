// Export prod's programs + courses to CSV.
//
// Prod DB is still on the OLD catalog schema (pre-post-0054):
//   - program has (id, name, track, price, enabled)
//   - course  has (id, name, code, program_id, enabled)
//
// This script writes two CSVs beside the working directory:
//   programs-<timestamp>.csv
//   courses-<timestamp>.csv
//
// Course rows expose the program NAME (resolved from program_id) instead of
// the FK UUID so the file is human-readable. Excel opens either CSV directly;
// to combine them into a single .xlsx, open programs-...csv, then File →
// Import courses-...csv as a new sheet.
//
// Usage:
//   $env:DATABASE_URL = 'postgres://decrm_admin:...@.../decrm_prod?sslmode=require'
//   npx tsx src/db/export-prod-catalog.ts

import { pool } from "./client.js";
import { writeFileSync } from "node:fs";

// RFC 4180-ish quoting: wrap in quotes when the field contains a comma,
// quote, or newline; escape embedded quotes by doubling them. Passing null /
// undefined → empty cell.
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // ── Programs ───────────────────────────────────────────────────────────
  const progR = await pool.query<{
    id: string;
    name: string;
    track: string | null;
    price: string | null;
    enabled: boolean;
    course_count: string;
  }>(
    `SELECT p.id, p.name, p.track, p.price, p.enabled,
            (SELECT COUNT(*)::text FROM course c WHERE c.program_id = p.id) AS course_count
       FROM program p
      ORDER BY p.enabled DESC, p.name`,
  );

  const progHeader = ["ID", "Name", "Track", "Price (₹)", "Active", "Course count"];
  const progRows   = progR.rows.map((p) => [
    p.id,
    p.name,
    p.track,
    p.price,
    p.enabled ? "Yes" : "No",
    p.course_count,
  ]);
  const progCsv = [csvRow(progHeader), ...progRows.map(csvRow)].join("\r\n");
  const progFile = `programs-${stamp}.csv`;
  writeFileSync(progFile, progCsv, "utf8");
  console.log(`  ✓ ${progFile} — ${progR.rows.length} programs`);

  // ── Courses (with program name resolved from program_id FK) ────────────
  const courseR = await pool.query<{
    id: string;
    name: string;
    code: string | null;
    enabled: boolean;
    program_id: string | null;
    program_name: string | null;
    program_track: string | null;
    program_enabled: boolean | null;
    cohort_count: string;
  }>(
    `SELECT co.id, co.name, co.code, co.enabled,
            co.program_id,
            p.name    AS program_name,
            p.track   AS program_track,
            p.enabled AS program_enabled,
            (SELECT COUNT(*)::text FROM cohort c WHERE c.course_id = co.id) AS cohort_count
       FROM course co
       LEFT JOIN program p ON p.id = co.program_id
      ORDER BY co.enabled DESC, p.name NULLS LAST, co.name`,
  );

  const courseHeader = [
    "ID", "Course name", "Code", "Active",
    "Program", "Program track", "Program active",
    "Program ID (raw)",
    "Batches (cohort count)",
  ];
  const courseRows = courseR.rows.map((c) => [
    c.id,
    c.name,
    c.code,
    c.enabled ? "Yes" : "No",
    c.program_name ?? "(unattached)",
    c.program_track,
    c.program_enabled == null ? "" : c.program_enabled ? "Yes" : "No",
    c.program_id,
    c.cohort_count,
  ]);
  const courseCsv = [csvRow(courseHeader), ...courseRows.map(csvRow)].join("\r\n");
  const courseFile = `courses-${stamp}.csv`;
  writeFileSync(courseFile, courseCsv, "utf8");
  console.log(`  ✓ ${courseFile} — ${courseR.rows.length} courses`);

  await pool.end();
}

main().catch((err) => {
  console.error("✗ export failed:", err.message);
  console.error(err);
  process.exit(1);
});
