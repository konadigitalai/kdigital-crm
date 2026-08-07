import { pool } from "./client.js";

async function main() {
  const counts = await pool.query<{ tbl: string; n: string }>(`
    SELECT 'program' AS tbl, count(*)::text AS n FROM program
    UNION ALL SELECT 'course',           count(*)::text FROM course
    UNION ALL SELECT 'cohort (batch)',   count(*)::text FROM cohort
    UNION ALL SELECT 'enrolment',        count(*)::text FROM enrolment
    UNION ALL SELECT 'batch_assignment', count(*)::text FROM batch_assignment
    ORDER BY tbl
  `);
  console.log("\n── Counts ──");
  for (const r of counts.rows) console.log(`  ${r.tbl.padEnd(20)} ${r.n}`);

  console.log("\n── Course coverage ──");
  const c = await pool.query(`
    SELECT p.name AS program, COALESCE(string_agg(co.name, ', ' ORDER BY pc.rank), '—') AS courses
    FROM program p
    LEFT JOIN program_course pc ON pc.program_id = p.id
    LEFT JOIN course co ON co.id = pc.course_id
    GROUP BY p.id, p.name
    ORDER BY p.name
  `);
  for (const r of c.rows as Array<{ program: string; courses: string }>) {
    console.log(`  ${r.program.padEnd(35)} -> ${r.courses}`);
  }

  console.log("\n── Cohort (batch) wiring ──");
  const k = await pool.query(`
    SELECT co.name AS course, c.name AS batch, c.status, c.slot
    FROM cohort c
    LEFT JOIN course co ON co.id = c.course_id
    ORDER BY co.name, c.start_date NULLS LAST
    LIMIT 8
  `);
  for (const r of k.rows as Array<{ course: string|null; batch: string; status: string; slot: string|null }>) {
    console.log(`  ${(r.course ?? '?').padEnd(10)} / ${r.batch.padEnd(40)} ${r.status} ${r.slot ?? ''}`);
  }

  console.log("\n── Enrolments + batch_assignments ──");
  const e = await pool.query(`
    SELECT party.name, p.name AS program, e.status, count(b.id)::int AS batches
    FROM enrolment e
    JOIN party ON party.id = e.party_id
    LEFT JOIN program p ON p.id = e.program_id
    LEFT JOIN batch_assignment b ON b.enrolment_id = e.id
    GROUP BY party.name, p.name, e.status
    ORDER BY party.name
  `);
  for (const r of e.rows as Array<{ name: string; program: string|null; status: string; batches: number }>) {
    console.log(`  ${r.name.padEnd(20)} program=${(r.program ?? '?').padEnd(25)} status=${r.status} batches=${r.batches}`);
  }

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
