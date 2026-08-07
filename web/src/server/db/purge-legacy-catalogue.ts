// Delete every catalogue row that did not come from the KDigital registry.
//
//   npm run db:purge-legacy            # dry run — prints the plan, writes nothing
//   npm run db:purge-legacy -- --apply # commit
//
// After this, `program` and `course` contain exactly what the v1.2 workbook
// contains: 9 programmes and 52 courses, every one carrying a registry_id.
//
// DESTRUCTIVE. Approved as such — the pre-registry catalogue was seed and
// test data. It is a script rather than a migration on purpose: a migration
// would re-run against any future database and delete its catalogue too,
// which would be wrong. This is a one-off cleanup of two known databases.
//
// WHAT GOES
//   The legacy programmes and courses, plus everything that exists only to
//   connect them to somebody: program_course links, cohorts of a dead course,
//   the batch/course assignments and sessions under those cohorts, their LMS
//   modules and coursework, and the enrolments against a dead programme.
//
// WHAT STAYS
//   People. Parties, leads, learner profiles and party roles all survive. A
//   lead that pointed at a dead programme keeps its row with program_id set
//   to NULL — somebody enquired, and that is true whether or not the
//   programme still exists. Deleting the enquiry to tidy the catalogue would
//   be destroying the wrong thing.
//
// Runs as decrm_admin in one transaction. Nothing is deleted unless every
// step succeeds.

import { pool } from "./client.js";

const APPLY = process.argv.includes("--apply");

interface Step { label: string; sql: string }

// Order matters: children before parents. Several of these would cascade
// anyway, but naming each one means the report can say exactly what went,
// rather than a single number that hides the interesting part.
const STEPS: Step[] = [
  // ── under cohorts of a legacy course ─────────────────────────────────
  { label: "attendance",
    sql: `DELETE FROM attendance WHERE batch_session_id IN (
            SELECT s.id FROM batch_session s WHERE s.cohort_id IN (SELECT id FROM dead_cohort))` },
  { label: "batch sessions",
    sql: `DELETE FROM batch_session WHERE cohort_id IN (SELECT id FROM dead_cohort)` },
  // coursework hangs off module, which hangs off cohort — not off cohort
  // directly.
  { label: "submissions",
    sql: `DELETE FROM submission WHERE coursework_id IN (
            SELECT cw.id FROM coursework cw WHERE cw.module_id IN (
              SELECT m.id FROM module m WHERE m.cohort_id IN (SELECT id FROM dead_cohort)))` },
  { label: "coursework",
    sql: `DELETE FROM coursework WHERE module_id IN (
            SELECT m.id FROM module m WHERE m.cohort_id IN (SELECT id FROM dead_cohort))` },
  { label: "resource progress",
    sql: `DELETE FROM resource_progress WHERE resource_id IN (
            SELECT r.id FROM module_resource r WHERE r.module_id IN (
              SELECT m.id FROM module m WHERE m.cohort_id IN (SELECT id FROM dead_cohort)))` },
  { label: "learner notes",
    sql: `DELETE FROM learner_note WHERE resource_id IN (
            SELECT r.id FROM module_resource r WHERE r.module_id IN (
              SELECT m.id FROM module m WHERE m.cohort_id IN (SELECT id FROM dead_cohort)))` },
  { label: "module resources",
    sql: `DELETE FROM module_resource WHERE module_id IN (
            SELECT m.id FROM module m WHERE m.cohort_id IN (SELECT id FROM dead_cohort))` },
  { label: "LMS modules",
    sql: `DELETE FROM module WHERE cohort_id IN (SELECT id FROM dead_cohort)` },
  { label: "batch assignments",
    sql: `DELETE FROM batch_assignment WHERE cohort_id IN (SELECT id FROM dead_cohort)` },
  { label: "cohorts (batches)",
    sql: `DELETE FROM cohort WHERE id IN (SELECT id FROM dead_cohort)` },

  // ── attached to a legacy course or programme ─────────────────────────
  { label: "course assignments",
    sql: `DELETE FROM course_assignment WHERE course_id IN (SELECT id FROM dead_course)
             OR enrolment_id IN (SELECT id FROM dead_enrolment)` },
  { label: "programme components",
    sql: `DELETE FROM program_course
           WHERE program_id IN (SELECT id FROM dead_program)
              OR child_program_id IN (SELECT id FROM dead_program)
              OR course_id IN (SELECT id FROM dead_course)` },

  // ── enrolments against a legacy programme ────────────────────────────
  { label: "certificates",
    sql: `DELETE FROM certificate WHERE enrolment_id IN (SELECT id FROM dead_enrolment)` },
  { label: "onboarding tasks",
    sql: `DELETE FROM onboarding_task WHERE enrolment_id IN (SELECT id FROM dead_enrolment)` },
  { label: "remaining batch assignments",
    sql: `DELETE FROM batch_assignment WHERE enrolment_id IN (SELECT id FROM dead_enrolment)` },
  { label: "enrolments",
    sql: `DELETE FROM enrolment WHERE id IN (SELECT id FROM dead_enrolment)` },

  // ── leads keep their row; only the dangling pointer is cleared ───────
  { label: "leads unlinked (kept)",
    sql: `UPDATE lead SET program_id = NULL, program = NULL
           WHERE program_id IN (SELECT id FROM dead_program)` },

  // ── finally the catalogue itself ─────────────────────────────────────
  { label: "courses",
    sql: `DELETE FROM course WHERE id IN (SELECT id FROM dead_course)` },
  { label: "programmes",
    sql: `DELETE FROM program WHERE id IN (SELECT id FROM dead_program)` },
];

// The three sets every step above is phrased against, materialised once so a
// step cannot accidentally widen its own definition of "legacy".
const SETUP = `
  CREATE TEMP TABLE dead_program ON COMMIT DROP AS
    SELECT id FROM program WHERE registry_id IS NULL;
  CREATE TEMP TABLE dead_course ON COMMIT DROP AS
    SELECT id FROM course WHERE registry_id IS NULL;
  CREATE TEMP TABLE dead_cohort ON COMMIT DROP AS
    SELECT id FROM cohort WHERE course_id IN (SELECT id FROM dead_course);
  CREATE TEMP TABLE dead_enrolment ON COMMIT DROP AS
    SELECT id FROM enrolment WHERE program_id IN (SELECT id FROM dead_program);
`;

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const db = (await client.query<{ d: string }>(`SELECT current_database() AS d`)).rows[0]!.d;
    console.log(`\ndatabase : ${db}`);
    console.log(`mode     : ${APPLY ? "APPLY (writing)" : "DRY RUN (rolled back)"}\n`);

    await client.query(SETUP);

    const targets = await client.query<{ kind: string; name: string }>(`
      SELECT 'programme' AS kind, name FROM program WHERE registry_id IS NULL
      UNION ALL
      SELECT 'course', name FROM course WHERE registry_id IS NULL
      ORDER BY 1, 2`);

    if (targets.rows.length === 0) {
      console.log("Nothing to purge — every catalogue row already carries a registry_id.\n");
      await client.query("ROLLBACK");
      return;
    }

    console.log("to delete:");
    for (const t of targets.rows) console.log(`  ${t.kind.padEnd(10)} ${t.name}`);
    console.log("");

    let total = 0;
    for (const step of STEPS) {
      const r = await client.query(step.sql);
      const n = r.rowCount ?? 0;
      total += n;
      if (n > 0) console.log(`  ${String(n).padStart(4)}  ${step.label}`);
    }
    console.log(`\n  ${String(total).padStart(4)}  rows affected in total`);

    // Prove the end state inside the same transaction, so a dry run reports
    // what WOULD be true rather than what is.
    const after = (await client.query<{
      programmes: string; courses: string; orphan_programmes: string; orphan_courses: string;
      links: string; refs: string;
    }>(`
      SELECT (SELECT count(*) FROM program)::text  AS programmes,
             (SELECT count(*) FROM course)::text   AS courses,
             (SELECT count(*) FROM program WHERE registry_id IS NULL)::text AS orphan_programmes,
             (SELECT count(*) FROM course  WHERE registry_id IS NULL)::text AS orphan_courses,
             (SELECT count(*) FROM program_course WHERE component_type='course')::text    AS links,
             (SELECT count(*) FROM program_course WHERE component_type='programme')::text AS refs
    `)).rows[0]!;

    console.log("\nresulting catalogue:");
    console.log(`  programmes ${after.programmes}  (non-registry: ${after.orphan_programmes})`);
    console.log(`  courses    ${after.courses}  (non-registry: ${after.orphan_courses})`);
    console.log(`  course links ${after.links}   pathway refs ${after.refs}`);

    const survivors = (await client.query<{ leads: string; parties: string; learners: string }>(`
      SELECT (SELECT count(*) FROM lead)::text   AS leads,
             (SELECT count(*) FROM party)::text  AS parties,
             (SELECT count(*) FROM learner_profile)::text AS learners
    `)).rows[0]!;
    console.log(`\npeople kept: ${survivors.parties} parties, ${survivors.leads} leads, ${survivors.learners} learner profiles`);

    if (Number(after.orphan_programmes) > 0 || Number(after.orphan_courses) > 0) {
      throw new Error("purge incomplete — non-registry rows remain; rolling back");
    }

    if (APPLY) {
      await client.query("COMMIT");
      console.log("\n committed\n");
    } else {
      await client.query("ROLLBACK");
      console.log("\n dry run rolled back — re-run with --apply to commit\n");
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(" purge failed:", (err as Error).message);
  process.exit(1);
});
