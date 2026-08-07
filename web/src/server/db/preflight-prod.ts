// Read-only pre-flight before migrating a POPULATED database (prod, QA).
//
//   $env:DATABASE_URL='postgres://decrm_admin:...@.../decrm_prod?sslmode=require'
//   npm run db:preflight
//
// Writes NOTHING. Every statement is a SELECT. Run it, read the verdict, and
// only then decide whether to migrate.
//
// It exists because `db:migrate` has one genuinely dangerous default. From
// migrate.ts:
//
//     "Without a bootstrap arg, the first run against an unmigrated DB will
//      execute EVERY post-*.sql from scratch"
//
// …and post-0054-catalog-stacks.sql begins with:
//
//     TRUNCATE batch_assignment, course_assignment, enrolment,
//              cohort, course, program CASCADE;
//
// So on a database whose ledger table is missing or incomplete, a plain
// `npm run db:migrate` deletes every enrolment and cohort in the business.
// The ledger check below is the whole reason this file exists.

import { pool } from "./client";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";

// Resolved from this file's own location so the script works from any cwd.
// Depth is `../../../` because this file sits at web/src/server/db/.
function migrationsDir(): string {
  return fileURLToPath(new URL("../../../drizzle/", import.meta.url));
}

type Verdict = "ok" | "warn" | "stop";
let worst: Verdict = "ok";

const ICON: Record<Verdict, string> = { ok: "  OK  ", warn: " WARN ", stop: " STOP " };

function say(v: Verdict, title: string, detail?: string) {
  if (v === "stop" || (v === "warn" && worst === "ok")) worst = v;
  console.log(`[${ICON[v]}] ${title}`);
  if (detail) for (const line of detail.split("\n")) console.log(`          ${line}`);
}

async function main() {
  const meta = (await pool.query<{ db: string; usr: string }>(
    `SELECT current_database() AS db, current_user AS usr`,
  )).rows[0]!;

  console.log(`\ndatabase : ${meta.db}`);
  console.log(`user     : ${meta.usr}`);
  console.log(`mode     : READ ONLY — this script writes nothing\n`);

  // KDigital's two databases share the Azure server `de-crm-pg` with Digital
  // Edify's own `postgres` (DE dev) and `decrm_prod` (DE prod). Connecting to
  // the wrong one is a cross-product accident, so name the target explicitly.
  const KNOWN: Record<string, string> = {
    kdcrm_dev:  "KDigital dev + qa",
    kdcrm_prod: "KDigital PRODUCTION",
  };
  const FOREIGN: Record<string, string> = {
    decrm_prod: "Digital Edify PRODUCTION — a different product",
    postgres:   "Digital Edify dev — a different product",
  };

  if (FOREIGN[meta.db]) {
    say("stop", `This is ${FOREIGN[meta.db]}.`,
      "These migrations belong to KDigital. Do not run them here.");
  } else if (meta.db === "kdcrm_dev") {
    say("warn", "This is the dev database, not prod.",
      "Point DATABASE_URL at kdcrm_prod if prod is what you meant.");
  } else if (KNOWN[meta.db]) {
    say("ok", `Target confirmed: ${KNOWN[meta.db]}.`);
  } else {
    say("warn", `Unrecognised database '${meta.db}'.`,
      "Expected kdcrm_dev or kdcrm_prod. Check the connection string.");
  }

  // The single most destructive footgun on this server, and it is not in the
  // SQL at all — it is in migrate.ts:
  //
  //     if (process.env.DECRM_APP_PASSWORD) ALTER ROLE decrm_app WITH PASSWORD …
  //
  // `decrm_app` is a SERVER-level role shared with Digital Edify. Setting that
  // variable to run a KDigital migration silently rewrites the password for
  // DE production's runtime role and takes their API down. There is never a
  // reason to set it — the role already has the right password.
  if (process.env.DECRM_APP_PASSWORD) {
    say("stop", "DECRM_APP_PASSWORD is set in this environment.",
      [
        "migrate.ts would run ALTER ROLE decrm_app WITH PASSWORD. That role is",
        "server-level and SHARED with Digital Edify, so this would change the",
        "password for DE production's runtime role and break their API.",
        "",
        "Unset it before migrating:   Remove-Item Env:DECRM_APP_PASSWORD",
      ].join("\n"));
  } else {
    say("ok", "DECRM_APP_PASSWORD is unset — decrm_app's password is safe.");
  }

  // ── 1. The ledger. Everything else is secondary to this. ───────────────
  const ledgerExists = (await pool.query<{ ok: boolean }>(
    `SELECT to_regclass('public._decrm_post_migrations') IS NOT NULL AS ok`,
  )).rows[0]!.ok;

  if (!ledgerExists) {
    say("stop", "No _decrm_post_migrations ledger on this database.",
      [
        "A plain `npm run db:migrate` would replay EVERY post-*.sql from the",
        "beginning — including post-0054, which TRUNCATEs enrolment, cohort,",
        "course, program and both assignment tables.",
        "",
        "If this database already has the pre-0087 schema, migrate with:",
        "",
        "    npm run db:migrate -- --bootstrap=post-0086-program-code.sql",
        "",
        "which marks everything up to 0086 as applied WITHOUT running it, so",
        "only 0087-0093 actually execute.",
      ].join("\n"));
  } else {
    const applied = (await pool.query<{ filename: string }>(
      `SELECT filename FROM _decrm_post_migrations ORDER BY filename`,
    )).rows.map((r) => r.filename);
    const last = applied[applied.length - 1] ?? "(none)";
    say("ok", `Ledger present — ${applied.length} migrations recorded, latest ${last}.`);

    // Diff the ledger against what is actually on disk, the same way
    // migrate.ts does, rather than against a list baked in here that would
    // drift the moment someone adds a migration.
    const set = new Set(applied);
    const onDisk = readdirSync(migrationsDir())
      .filter((f) => f.startsWith("post-") && f.endsWith(".sql"))
      .sort();
    const todo = onDisk.filter((f) => !set.has(f));

    // A ledger entry for something not on disk means this checkout is BEHIND
    // the database — migrating from here could reintroduce an older schema.
    const unknown = applied.filter((f) => !onDisk.includes(f));
    if (unknown.length) {
      say("stop", `The database has ${unknown.length} migration(s) this checkout does not.`,
        [
          "This working copy is older than the target database. Pull before",
          "migrating, or you risk writing against a schema you cannot see:",
          "",
          ...unknown.slice(0, 8).map((f) => `    ${f}`),
        ].join("\n"));
    }

    if (todo.length === 0) {
      say("ok", "Nothing pending — the database is already at this checkout's schema.");
    } else {
      say("ok", `${todo.length} migration(s) would run:`,
        todo.map((f) => `    ${f}`).join("\n"));
    }
  }

  // ── 2. The one constraint in 0087-0093 that reads existing data ────────
  //
  // post-0090 fences party_affiliation.role_at_org, which is a pre-existing
  // table. Every other constraint in the set lands on a column the same
  // migration just created, so it cannot contradict data that is already
  // there. This one can.
  const affiliationExists = (await pool.query<{ ok: boolean }>(
    `SELECT to_regclass('public.party_affiliation') IS NOT NULL AS ok`,
  )).rows[0]!.ok;

  if (affiliationExists) {
    const bad = (await pool.query<{ role_at_org: string; n: string }>(
      `SELECT role_at_org, count(*)::text AS n
         FROM party_affiliation
        WHERE role_at_org IS NOT NULL
          AND role_at_org NOT IN ('decision_maker','evaluator','sponsor','influencer',
                                  'user','gatekeeper','employee','contractor','alumnus')
        GROUP BY 1 ORDER BY 2 DESC`,
    )).rows;

    if (bad.length === 0) {
      say("ok", "party_affiliation.role_at_org — every value fits the new CHECK.");
    } else {
      say("stop", "party_affiliation.role_at_org holds values the new CHECK rejects.",
        [
          "post-0090 would abort partway through. Either widen the CHECK in",
          "that migration to include these, or correct the rows first:",
          "",
          ...bad.map((r) => `    ${r.n.padStart(6)} x  ${r.role_at_org}`),
        ].join("\n"));
    }
  }

  // ── 3. What 0089/0090/0092 will WRITE, so it is not a surprise ─────────
  const counts = (await pool.query<Record<string, string>>(`
    SELECT
      (SELECT count(*) FROM app_user WHERE party_id IS NOT NULL AND role <> 'learner') AS staff,
      (SELECT count(*) FROM deal)                                                      AS deals,
      (SELECT count(*) FROM enrolment)                                                 AS enrolments,
      (SELECT count(*) FROM cohort)                                                    AS cohorts,
      (SELECT count(*) FROM course)                                                    AS courses,
      (SELECT count(*) FROM program)                                                   AS programs
  `)).rows[0]!;

  say("ok", "Backfills these migrations perform (all additive, none destructive):",
    [
      `post-0089  creates ~${counts.staff} worker rows from existing staff app_users`,
      `post-0092  gives those same people a 'worker' party_role`,
      `post-0090  stamps a close date on any already-closed deal (${counts.deals} deals total)`,
    ].join("\n"));

  say("ok", "Live data these migrations must NOT disturb:",
    [
      `enrolments ${counts.enrolments}   cohorts ${counts.cohorts}`,
      `courses    ${counts.courses}   programs ${counts.programs}`,
      "",
      "Re-run this script after migrating — these six numbers must be unchanged.",
      "If enrolments or cohorts dropped, post-0054 replayed. Restore immediately.",
    ].join("\n"));

  // ── 4. Grants on the tables this change set adds ───────────────────────
  //
  // KD_SETUP_STATE gotcha 9: both KD databases were restored from a pg_dump
  // whose ledger listed every migration as applied, while --no-privileges had
  // stripped the GRANTs those migrations carried. 54 tables ended up with no
  // decrm_app privileges at all — invisible when testing as decrm_admin, and
  // a total outage for the API, which connects as decrm_app.
  //
  // The six tables below are NEW, so their migrations will genuinely run and
  // their GRANTs with them. This check exists to prove that after the fact,
  // because the failure is silent from the admin role.
  const NEW_TABLES = ["worker", "account", "contact", "requisition", "candidate", "application"];
  const NEW_VIEWS  = ["catalogue_effective_course", "candidate_eligible"];

  const present = (await pool.query<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.tables
      WHERE table_schema='public' AND table_name = ANY($1)`, [NEW_TABLES],
  )).rows.map((r) => r.t);

  if (present.length === 0) {
    say("ok", "None of the new tables exist yet — as expected before migrating.");
  } else {
    const ungranted = (await pool.query<{ t: string }>(
      `SELECT t.table_name AS t
         FROM information_schema.tables t
        WHERE t.table_schema='public' AND t.table_name = ANY($1)
          AND NOT EXISTS (
            SELECT 1 FROM information_schema.role_table_grants g
             WHERE g.table_schema='public' AND g.table_name = t.table_name
               AND g.grantee='decrm_app' AND g.privilege_type='SELECT')`,
      [[...NEW_TABLES, ...NEW_VIEWS]],
    )).rows.map((r) => r.t);

    if (ungranted.length === 0) {
      say("ok", `decrm_app can read all ${present.length} new table(s) and the new views.`);
    } else {
      say("stop", "New objects exist but decrm_app has NO privileges on them.",
        [
          "The API connects as decrm_app, so every request touching these",
          "returns a permission error. Re-run the migration that creates them,",
          "or grant by hand:",
          "",
          ...ungranted.map((t) => `    GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO decrm_app;`),
        ].join("\n"));
    }
  }

  // ── 5. Catalogue collision check for the seeder (separate step) ────────
  if ((await pool.query<{ ok: boolean }>(
    `SELECT to_regclass('public.course') IS NOT NULL AS ok`)).rows[0]!.ok) {
    const named = (await pool.query<{ name: string }>(
      `SELECT name FROM course WHERE lower(name) IN ('python','sql') ORDER BY name`,
    )).rows.map((r) => r.name);
    if (named.length) {
      say("warn", `db:seed-catalogue would adopt existing course(s): ${named.join(", ")}`,
        [
          "They keep their uuid (so batches and assignments stay attached) and",
          "are RENAMED to the registry's wording. Run the seeder without",
          "--apply first and read the dry run.",
        ].join("\n"));
    }
  }

  console.log("");
  if (worst === "stop") {
    console.log("VERDICT: STOP — resolve the items above before migrating.\n");
    process.exitCode = 2;
  } else if (worst === "warn") {
    console.log("VERDICT: PROCEED WITH CARE — read the warnings above.\n");
  } else {
    console.log("VERDICT: SAFE TO MIGRATE.\n");
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error("preflight failed:", (err as Error).message);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
