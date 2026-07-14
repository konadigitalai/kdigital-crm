// Export prod's programs + courses to CSV.
//
// This script auto-detects which catalog shape the DB is on:
//   OLD shape (pre-post-0054): program.track exists, course.program_id/code exist.
//   NEW shape (post-0054+):    stack, program_course junction exist; program.stack_id,
//                              program.duration_value/unit; course.description.
//
// Writes CSV files beside the working directory:
//   programs-<timestamp>.csv
//   courses-<timestamp>.csv
//   stacks-<timestamp>.csv        (only when NEW shape)
//   program_course-<timestamp>.csv (only when NEW shape — junction with names)
//
// FK values are resolved to human-readable names, not UUIDs.
//
// Usage:
//   $env:DATABASE_URL = 'postgres://decrm_admin:...@.../decrm_prod?sslmode=require'
//   npx tsx src/db/export-prod-catalog.ts

import { pool } from "./client.js";
import { writeFileSync } from "node:fs";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2
     ) AS exists`,
    [table, column],
  );
  return r.rows[0]?.exists ?? false;
}

async function tableExists(table: string): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [table],
  );
  return r.rows[0]?.exists ?? false;
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // Detect schema shape.
  const hasStack        = await tableExists("stack");
  const hasProgramCourse = await tableExists("program_course");
  const hasProgTrack    = await columnExists("program", "track");
  const hasProgStack    = await columnExists("program", "stack_id");
  const hasCourseProg   = await columnExists("course", "program_id");
  const hasCourseCode   = await columnExists("course", "code");

  const shape = hasStack && hasProgramCourse && hasProgStack ? "new" : "old";
  console.log(`  schema shape detected: ${shape}`);
  console.log(`    program.track: ${hasProgTrack}, program.stack_id: ${hasProgStack}`);
  console.log(`    course.program_id: ${hasCourseProg}, course.code: ${hasCourseCode}`);
  console.log(`    stack table: ${hasStack}, program_course: ${hasProgramCourse}`);
  console.log("");

  if (shape === "old") {
    // ── Old shape: program has track, course has program_id + code ────────
    const progR = await pool.query<{
      id: string; name: string; track: string | null; price: string | null;
      enabled: boolean; course_count: string;
    }>(
      `SELECT p.id, p.name, p.track, p.price, p.enabled,
              (SELECT COUNT(*)::text FROM course c WHERE c.program_id = p.id) AS course_count
         FROM program p
        ORDER BY p.enabled DESC, p.name`,
    );
    const progHeader = ["ID", "Name", "Track", "Price (₹)", "Active", "Course count"];
    const progRows = progR.rows.map((p) => [
      p.id, p.name, p.track, p.price, p.enabled ? "Yes" : "No", p.course_count,
    ]);
    const progFile = `programs-${stamp}.csv`;
    writeFileSync(progFile, [csvRow(progHeader), ...progRows.map(csvRow)].join("\r\n"), "utf8");
    console.log(`  ✓ ${progFile} — ${progR.rows.length} programs`);

    const courseR = await pool.query<{
      id: string; name: string; code: string | null; enabled: boolean;
      program_id: string | null; program_name: string | null;
      program_track: string | null; program_enabled: boolean | null;
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
      c.id, c.name, c.code, c.enabled ? "Yes" : "No",
      c.program_name ?? "(unattached)", c.program_track,
      c.program_enabled == null ? "" : c.program_enabled ? "Yes" : "No",
      c.program_id, c.cohort_count,
    ]);
    const courseFile = `courses-${stamp}.csv`;
    writeFileSync(courseFile, [csvRow(courseHeader), ...courseRows.map(csvRow)].join("\r\n"), "utf8");
    console.log(`  ✓ ${courseFile} — ${courseR.rows.length} courses`);
  } else {
    // ── New shape: stack + program_course junction ────────────────────────
    const stackR = await pool.query<{
      id: string; name: string; description: string | null; enabled: boolean; program_count: string;
    }>(
      `SELECT s.id, s.name, s.description, s.enabled,
              (SELECT COUNT(*)::text FROM program p WHERE p.stack_id = s.id) AS program_count
         FROM stack s
        ORDER BY s.enabled DESC, s.name`,
    );
    const stackHeader = ["ID", "Name", "Description", "Active", "Program count"];
    const stackRows = stackR.rows.map((s) => [
      s.id, s.name, s.description, s.enabled ? "Yes" : "No", s.program_count,
    ]);
    const stackFile = `stacks-${stamp}.csv`;
    writeFileSync(stackFile, [csvRow(stackHeader), ...stackRows.map(csvRow)].join("\r\n"), "utf8");
    console.log(`  ✓ ${stackFile} — ${stackR.rows.length} stacks`);

    const progR = await pool.query<{
      id: string; name: string; description: string | null; price: string | null;
      duration_value: number | null; duration_unit: string | null;
      enabled: boolean; stack_id: string | null; stack_name: string | null;
      course_count: string;
    }>(
      `SELECT p.id, p.name, p.description, p.price,
              p.duration_value, p.duration_unit,
              p.enabled, p.stack_id,
              s.name AS stack_name,
              (SELECT COUNT(*)::text FROM program_course pc WHERE pc.program_id = p.id) AS course_count
         FROM program p
         LEFT JOIN stack s ON s.id = p.stack_id
        ORDER BY p.enabled DESC, s.name NULLS LAST, p.name`,
    );
    const progHeader = [
      "ID", "Name", "Description", "Price (₹)",
      "Duration", "Unit",
      "Active", "Stack", "Stack ID (raw)", "Course count",
    ];
    const progRows = progR.rows.map((p) => [
      p.id, p.name, p.description, p.price,
      p.duration_value, p.duration_unit,
      p.enabled ? "Yes" : "No",
      p.stack_name ?? "(no stack)", p.stack_id, p.course_count,
    ]);
    const progFile = `programs-${stamp}.csv`;
    writeFileSync(progFile, [csvRow(progHeader), ...progRows.map(csvRow)].join("\r\n"), "utf8");
    console.log(`  ✓ ${progFile} — ${progR.rows.length} programs`);

    const courseR = await pool.query<{
      id: string; name: string; description: string | null; enabled: boolean;
      program_count: string; cohort_count: string;
    }>(
      `SELECT co.id, co.name, co.description, co.enabled,
              (SELECT COUNT(*)::text FROM program_course pc WHERE pc.course_id = co.id) AS program_count,
              (SELECT COUNT(*)::text FROM cohort c WHERE c.course_id = co.id) AS cohort_count
         FROM course co
        ORDER BY co.enabled DESC, co.name`,
    );
    const courseHeader = ["ID", "Course name", "Description", "Active", "Programs (via junction)", "Batches"];
    const courseRows = courseR.rows.map((c) => [
      c.id, c.name, c.description, c.enabled ? "Yes" : "No",
      c.program_count, c.cohort_count,
    ]);
    const courseFile = `courses-${stamp}.csv`;
    writeFileSync(courseFile, [csvRow(courseHeader), ...courseRows.map(csvRow)].join("\r\n"), "utf8");
    console.log(`  ✓ ${courseFile} — ${courseR.rows.length} courses`);

    // The junction itself — one row per (program, course) pair, with names.
    const pcR = await pool.query<{
      program_id: string; program_name: string;
      course_id:  string; course_name:  string;
      rank: number;
    }>(
      `SELECT pc.program_id, p.name AS program_name,
              pc.course_id,  co.name AS course_name,
              pc.rank
         FROM program_course pc
         JOIN program p  ON p.id  = pc.program_id
         JOIN course  co ON co.id = pc.course_id
        ORDER BY p.name, pc.rank, co.name`,
    );
    const pcHeader = ["Program", "Course", "Rank", "Program ID (raw)", "Course ID (raw)"];
    const pcRows = pcR.rows.map((r) => [
      r.program_name, r.course_name, r.rank, r.program_id, r.course_id,
    ]);
    const pcFile = `program_course-${stamp}.csv`;
    writeFileSync(pcFile, [csvRow(pcHeader), ...pcRows.map(csvRow)].join("\r\n"), "utf8");
    console.log(`  ✓ ${pcFile} — ${pcR.rows.length} program↔course links`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("✗ export failed:", err.message);
  console.error(err);
  process.exit(1);
});
