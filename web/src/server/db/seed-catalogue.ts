// Load the KDigital v1.2 Final Programme and Course Registry into a database.
//
//   npm run db:seed-catalogue              # dry run — prints the plan, writes nothing
//   npm run db:seed-catalogue -- --apply   # commit
//
// Idempotent and re-runnable. Everything keys off `registry_id` (CAT-001,
// CAT-002: resolve by ID, never by name), so re-running after a registry
// refresh updates names, families and effective dates in place while leaving
// every uuid — and therefore every enrolment, cohort, assignment and
// certificate hanging off it — exactly where it was.
//
// What it does NOT do:
//   - invent a price or a duration. The registry carries neither. New
//     programmes land with price NULL and the seeder says so; an advisor sets
//     them in the CRM. A re-run never overwrites a price someone has set.
//   - delete anything. Courses and programmes that disappear from a future
//     registry are reported and left alone; retiring one is a decision with
//     enrolments attached, not a side effect of an import.
//   - touch the pre-existing non-registry catalogue rows (those with a NULL
//     registry_id). They are matched by name first, and adopted into the
//     registry if the name matches exactly — otherwise left untouched.
//
// Runs as decrm_admin (DATABASE_URL) in one transaction.

import {
  REGISTRY_PROGRAMMES,
  REGISTRY_COURSES,
  REGISTRY_COMPONENTS,
  REGISTRY_CATALOGUE_VERSION,
} from "./catalogue-registry.data.js";
import { pool } from "./client.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");

const tenantArg = args.find((a) => a.startsWith("--tenant="));

// Pre-registry course names that mean the same thing as a registry course.
//
// The adoption pass matches on an exact name. These four rows predate the
// registry and are worded differently, so without a mapping the seeder would
// create "Python Programming" beside the existing "Python" and leave the
// cohorts, enrolments and assignments hanging off the old uuid — two courses
// where there is one.
//
// Adoption is an UPDATE of registry_id only. The uuid never moves, so nothing
// detaches. That is also why this list is explicit rather than fuzzy-matched:
// merging two courses that are NOT the same thing is not recoverable by
// re-running anything.
//
// Left deliberately unmapped, because no registry course means the same:
//   course  "Data Science"            — the registry has no Data Science course
//   course  "Applied AI Engineering"  — nearest is a PROGRAMME (K-P007-AAIE)
//   program "Data Science"            — no registry pathway matches
// Those keep working as local, non-registry catalogue entries and the seeder
// reports them on every run.
const LEGACY_COURSE_ALIASES: Record<string, string> = {
  "python": "K-C008-PYTH",   // → Python Programming
  "sql":    "K-C007-SQLDB",  // → SQL and Relational Database Foundations
};

type Counts = { inserted: number; updated: number };
const zero = (): Counts => ({ inserted: 0, updated: 0 });

// Postgres reports a fresh tuple from INSERT … ON CONFLICT with xmax = 0, so
// this is how a row that was created is told apart from one that was updated.
function tally<T extends { op: string }>(counts: Counts, rows: T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${what}: upsert returned no row`);
  if (row.op === "true") counts.inserted++;
  else counts.updated++;
  return row;
}

async function main() {
  const client = await pool.connect();
  const notes: string[] = [];

  try {
    await client.query("BEGIN");

    // ─── Tenant ───────────────────────────────────────────────────────────
    const tenantId = tenantArg
      ? tenantArg.slice("--tenant=".length)
      : (await client.query<{ id: string }>(
          `SELECT id FROM tenant ORDER BY created_at NULLS FIRST, id LIMIT 1`,
        )).rows[0]?.id;
    if (!tenantId) throw new Error("no tenant found — run db:seed first, or pass --tenant=<uuid>");

    const tenantName = (await client.query<{ name: string }>(
      `SELECT name FROM tenant WHERE id = $1`, [tenantId],
    )).rows[0]?.name;
    if (!tenantName) throw new Error(`tenant ${tenantId} does not exist`);

    const dbName = (await client.query<{ d: string }>(`SELECT current_database() AS d`)).rows[0]?.d;
    console.log(`database : ${dbName}`);
    console.log(`tenant   : ${tenantName} (${tenantId})`);
    console.log(`registry : catalogue version ${REGISTRY_CATALOGUE_VERSION}`);
    console.log(`mode     : ${APPLY ? "APPLY (writing)" : "DRY RUN (rolled back)"}\n`);

    // ─── Courses ──────────────────────────────────────────────────────────
    // Adoption pass first: an existing course whose name matches the registry
    // exactly is the SAME course, so give it its registry_id rather than
    // creating a duplicate beside it. Anything already carrying a registry_id
    // is skipped — it is matched by that instead.
    const courseIdByRegistry = new Map<string, string>();
    const courseCounts = zero();

    for (const c of REGISTRY_COURSES) {
      // Names this registry course is known by locally: its own, plus any
      // pre-registry wording mapped above.
      const aliases = [c.name];
      for (const [legacy, registryId] of Object.entries(LEGACY_COURSE_ALIASES)) {
        if (registryId === c.registryId) aliases.push(legacy);
      }
      const lowerAliases = aliases.map((a) => a.toLowerCase());

      // A previous run may already have created this registry course as a NEW
      // row, before the alias above existed — so now there are two: the legacy
      // one carrying the cohorts and assignments, and a fresh empty one
      // holding the registry_id.
      //
      // The legacy uuid has to win. Everything hanging off it (cohorts,
      // course assignments, LMS content) is real; the registry row's only
      // links are program_course rows, which the components pass below
      // recreates from scratch every run. So: strip the registry row, then
      // adopt the legacy one.
      const legacy = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM course
          WHERE tenant_id = $1 AND registry_id IS NULL AND lower(name) = ANY($2::text[])
          LIMIT 1`,
        [tenantId, lowerAliases],
      );
      const legacyRow = legacy.rows[0];

      if (legacyRow) {
        const holder = await client.query<{ id: string; cohorts: number; assignments: number }>(
          `SELECT c.id,
                  (SELECT count(*)::int FROM cohort x            WHERE x.course_id = c.id) AS cohorts,
                  (SELECT count(*)::int FROM course_assignment x WHERE x.course_id = c.id) AS assignments
             FROM course c
            WHERE c.tenant_id = $1 AND c.registry_id = $2 AND c.id <> $3`,
          [tenantId, c.registryId, legacyRow.id],
        );
        const holderRow = holder.rows[0];

        if (holderRow) {
          // Refuse to merge if the registry row has picked up real dependents
          // of its own — that is a genuine two-course situation and resolving
          // it is a decision with learners attached, not an import step.
          if (holderRow.cohorts > 0 || holderRow.assignments > 0) {
            throw new Error(
              `cannot merge "${legacyRow.name}" into ${c.registryId}: the registry course already has ` +
              `${holderRow.cohorts} batch(es) and ${holderRow.assignments} assignment(s). Resolve by hand.`,
            );
          }
          await client.query(`DELETE FROM program_course WHERE course_id = $1`, [holderRow.id]);
          await client.query(`DELETE FROM course WHERE id = $1`, [holderRow.id]);
          notes.push(
            `merged duplicate ${c.registryId}: kept legacy "${legacyRow.name}" (has batches/assignments), ` +
            `dropped the empty registry row`,
          );
        }

        await client.query(
          `UPDATE course SET registry_id = $1 WHERE id = $2`,
          [c.registryId, legacyRow.id],
        );
        notes.push(
          legacyRow.name.toLowerCase() === c.name.toLowerCase()
            ? `adopted existing course "${c.name}" as ${c.registryId}`
            : `adopted legacy course "${legacyRow.name}" as ${c.registryId} — renamed to "${c.name}", uuid preserved`,
        );
      }

      const r = await client.query<{ id: string; op: string }>(
        `INSERT INTO course (
           tenant_id, registry_id, short_code, catalogue_sequence, name, search_alias,
           family, description, credential_type, curriculum_version_pattern,
           reusable_across_programmes, independently_deliverable,
           catalogue_version, catalogue_status, effective_from, effective_to, source_registry
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (tenant_id, registry_id) WHERE registry_id IS NOT NULL
         DO UPDATE SET
           short_code                 = EXCLUDED.short_code,
           catalogue_sequence         = EXCLUDED.catalogue_sequence,
           name                       = EXCLUDED.name,
           search_alias               = EXCLUDED.search_alias,
           family                     = EXCLUDED.family,
           description                = EXCLUDED.description,
           credential_type            = EXCLUDED.credential_type,
           curriculum_version_pattern = EXCLUDED.curriculum_version_pattern,
           reusable_across_programmes = EXCLUDED.reusable_across_programmes,
           independently_deliverable  = EXCLUDED.independently_deliverable,
           catalogue_version          = EXCLUDED.catalogue_version,
           catalogue_status           = EXCLUDED.catalogue_status,
           effective_from             = EXCLUDED.effective_from,
           effective_to               = EXCLUDED.effective_to,
           source_registry            = EXCLUDED.source_registry
         RETURNING id, (xmax = 0)::text AS op`,
        [
          tenantId, c.registryId, c.shortCode, c.sequence, c.name, c.searchAlias,
          c.family, c.description, c.credentialType, c.curriculumVersionPattern,
          c.reusableAcrossProgrammes, c.independentlyDeliverable,
          c.catalogueVersion, c.catalogueStatus, c.effectiveFrom, c.effectiveTo,
          `KDigital registry ${c.catalogueVersion}`,
        ],
      );
      courseIdByRegistry.set(c.registryId, tally(courseCounts, r.rows, c.registryId).id);
    }

    // ─── Programmes ───────────────────────────────────────────────────────
    const programIdByRegistry = new Map<string, string>();
    const programCounts = zero();
    const missingPrice: string[] = [];

    for (const p of REGISTRY_PROGRAMMES) {
      const adopted = await client.query<{ id: string }>(
        `UPDATE program SET registry_id = $1
          WHERE tenant_id = $2 AND registry_id IS NULL AND lower(name) = lower($3)
          RETURNING id`,
        [p.registryId, tenantId, p.name],
      );
      if (adopted.rows[0]) notes.push(`adopted existing programme "${p.name}" as ${p.registryId}`);

      // price is set on INSERT only. A re-run must not clear a price an
      // advisor has since entered — the registry has no opinion on pricing.
      const r = await client.query<{ id: string; op: string; price: string | null }>(
        `INSERT INTO program (
           tenant_id, registry_id, short_code, catalogue_sequence,
           name, full_name, search_alias, programme_type, family, description,
           credential_type, delivery_modes, catalogue_version, catalogue_status,
           effective_from, effective_to, source_registry
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (tenant_id, registry_id) WHERE registry_id IS NOT NULL
         DO UPDATE SET
           short_code         = EXCLUDED.short_code,
           catalogue_sequence = EXCLUDED.catalogue_sequence,
           name               = EXCLUDED.name,
           full_name          = EXCLUDED.full_name,
           search_alias       = EXCLUDED.search_alias,
           programme_type     = EXCLUDED.programme_type,
           family             = EXCLUDED.family,
           description        = EXCLUDED.description,
           credential_type    = EXCLUDED.credential_type,
           delivery_modes     = EXCLUDED.delivery_modes,
           catalogue_version  = EXCLUDED.catalogue_version,
           catalogue_status   = EXCLUDED.catalogue_status,
           effective_from     = EXCLUDED.effective_from,
           effective_to       = EXCLUDED.effective_to,
           source_registry    = EXCLUDED.source_registry
         RETURNING id, (xmax = 0)::text AS op, price`,
        [
          tenantId, p.registryId, p.shortCode, p.sequence,
          p.name, p.fullName, p.searchAlias, p.programmeType, p.family, p.description,
          p.credentialType, p.deliveryModes, p.catalogueVersion, p.catalogueStatus,
          p.effectiveFrom, p.effectiveTo, `KDigital registry ${p.catalogueVersion}`,
        ],
      );
      const row = tally(programCounts, r.rows, p.registryId);
      programIdByRegistry.set(p.registryId, row.id);
      if (row.price === null) missingPrice.push(`${p.registryId}  ${p.name}`);
    }

    // ─── Components ───────────────────────────────────────────────────────
    // Two shapes into one table: a course component and a referenced-programme
    // component (CAT-007). The table's CHECK guarantees a row is exactly one
    // of them, so the two INSERTs differ only in which column is populated.
    const componentCounts = zero();

    for (const k of REGISTRY_COMPONENTS) {
      const programId = programIdByRegistry.get(k.programmeId);
      if (!programId) throw new Error(`component references unknown programme ${k.programmeId}`);

      // The registry numbers components from 1; `rank` is 0-based everywhere
      // else in this table, so shift rather than mix two conventions.
      const rank = k.sequenceNumber - 1;
      const common = [
        k.componentRole, k.specialisationGroup, k.required, k.creditReuseAllowed,
        k.catalogueStatus, k.effectiveFrom, k.effectiveTo, rank,
      ];

      let r;
      if (k.componentType === "Course") {
        const courseId = courseIdByRegistry.get(k.componentReferenceId);
        if (!courseId) throw new Error(`component references unknown course ${k.componentReferenceId}`);
        r = await client.query<{ op: string }>(
          `INSERT INTO program_course (
             tenant_id, program_id, component_type, course_id,
             component_role, specialisation_group, required, credit_reuse_allowed,
             catalogue_status, effective_from, effective_to, rank
           ) VALUES ($1,$2,'course',$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (program_id, course_id)
           DO UPDATE SET
             component_role       = EXCLUDED.component_role,
             specialisation_group = EXCLUDED.specialisation_group,
             required             = EXCLUDED.required,
             credit_reuse_allowed = EXCLUDED.credit_reuse_allowed,
             catalogue_status     = EXCLUDED.catalogue_status,
             effective_from       = EXCLUDED.effective_from,
             effective_to         = EXCLUDED.effective_to,
             rank                 = EXCLUDED.rank
           RETURNING (xmax = 0)::text AS op`,
          [tenantId, programId, courseId, ...common],
        );
      } else {
        const childId = programIdByRegistry.get(k.componentReferenceId);
        if (!childId) throw new Error(`component references unknown programme ${k.componentReferenceId}`);
        r = await client.query<{ op: string }>(
          `INSERT INTO program_course (
             tenant_id, program_id, component_type, child_program_id,
             component_role, specialisation_group, required, credit_reuse_allowed,
             catalogue_status, effective_from, effective_to, rank
           ) VALUES ($1,$2,'programme',$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (program_id, child_program_id) WHERE child_program_id IS NOT NULL
           DO UPDATE SET
             component_role       = EXCLUDED.component_role,
             specialisation_group = EXCLUDED.specialisation_group,
             required             = EXCLUDED.required,
             credit_reuse_allowed = EXCLUDED.credit_reuse_allowed,
             catalogue_status     = EXCLUDED.catalogue_status,
             effective_from       = EXCLUDED.effective_from,
             effective_to         = EXCLUDED.effective_to,
             rank                 = EXCLUDED.rank
           RETURNING (xmax = 0)::text AS op`,
          [tenantId, programId, childId, ...common],
        );
      }
      tally(componentCounts, r.rows, `${k.programmeId}#${k.sequenceNumber}`);
    }

    // ─── Report ───────────────────────────────────────────────────────────
    const line = (label: string, c: Counts, total: number) =>
      console.log(`${label.padEnd(12)} ${String(total).padStart(3)} in registry — ` +
                  `${c.inserted} inserted, ${c.updated} updated`);

    line("courses",    courseCounts,    REGISTRY_COURSES.length);
    line("programmes", programCounts,   REGISTRY_PROGRAMMES.length);
    line("components", componentCounts, REGISTRY_COMPONENTS.length);

    // Catalogue rows that predate the registry and did not match a name.
    const orphans = await client.query<{ kind: string; name: string }>(
      `SELECT 'course'  AS kind, name FROM course  WHERE tenant_id = $1 AND registry_id IS NULL
       UNION ALL
       SELECT 'program' AS kind, name FROM program WHERE tenant_id = $1 AND registry_id IS NULL
       ORDER BY 1, 2`,
      [tenantId],
    );

    if (notes.length) {
      console.log("\nadopted (name matched an existing row, uuid preserved):");
      for (const n of notes) console.log(`  • ${n}`);
    }
    if (orphans.rows.length) {
      console.log("\nnot in the registry — left untouched, retire by hand if they are dead:");
      for (const o of orphans.rows) console.log(`  • ${o.kind.padEnd(7)} ${o.name}`);
    }
    if (missingPrice.length) {
      console.log("\nno price set — the registry carries none, an advisor must:");
      for (const m of missingPrice) console.log(`  • ${m}`);
    }

    if (APPLY) {
      await client.query("COMMIT");
      console.log("\n✓ committed");
    } else {
      await client.query("ROLLBACK");
      console.log("\n✓ dry run rolled back — re-run with --apply to commit");
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
  console.error("✗ catalogue seed failed:", err.message);
  process.exit(1);
});
