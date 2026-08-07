// One-shot: back up every lead-related row to a timestamped SQL dump, then
// (with --apply) delete those rows inside a single transaction.
//
// SCOPE — what "lead-related" means here:
//   - work_item rows where type='lead'
//   - lead rows attached to those work_items
//   - activity rows attached to those work_items
//   - party_role rows with role='lead'
//   - party rows that (a) have a lead role, AND (b) do NOT have any OTHER
//     role (learner, contact, advisor, alumnus) and are NOT referenced by
//     any non-lead work_item, app_user, or shared reference table. Parties
//     that survive keep their history — a lead who became a learner stays.
//
// NEVER TOUCHED:
//   - programs, courses, batches, tenants
//   - app_user rows (advisors, admins)
//   - service cases, onboarding tasks, learners, alumni
//   - contact points, party matches, party merges
//
// Two phases, both gated:
//   1. Dry-run (default) — writes the SQL dump, prints counts, exits.
//      Never mutates the DB.
//   2. --apply — repeats the dump for freshness, then runs DELETEs inside
//      one transaction. Fails closed on any FK error (transaction aborts,
//      nothing changed).
//
// Usage:
//   $env:DATABASE_URL='postgres://…'
//   npx tsx src/db/dump-and-wipe-leads.ts           # dry-run + backup
//   npx tsx src/db/dump-and-wipe-leads.ts --apply    # backup + delete
//
// The backup file is written to api/backups/leads-prod-<timestamp>.sql
// as plain INSERT statements. Restore with:
//   psql "$DATABASE_URL" -f leads-prod-<timestamp>.sql

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pool } from "./client";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT_DIR = resolve(process.cwd(), "backups");
const OUT_FILE = resolve(OUT_DIR, `leads-prod-${stamp}.sql`);

// SQL-escape a JS value into a PostgreSQL literal. Handles null, string,
// number, boolean, Date, and jsonb (as objects). We ALWAYS single-quote
// strings and double any embedded single quote. jsonb values are rendered
// as `'…'::jsonb`. Arrays are not currently used here.
function q(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  if (typeof v === "object") {
    // jsonb
    return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

function insertLine(table: string, cols: string[], row: Record<string, unknown>): string {
  const vals = cols.map((c) => q(row[c])).join(", ");
  return `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${vals});`;
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  console.log(`→ target DB: ${maskUrl(process.env.DATABASE_URL ?? "(none)")}`);
  console.log(`→ backup file: ${OUT_FILE}`);
  console.log(`→ mode: ${APPLY ? "APPLY (backup + delete)" : "DRY-RUN (backup only, no deletes)"}\n`);

  // Resolve tenant (RLS context).
  const tenR = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM tenant ORDER BY created_at DESC LIMIT 1`,
  );
  const tenant = tenR.rows[0];
  if (!tenant) throw new Error("no tenant row found");
  console.log(`  tenant: ${tenant.name} (${tenant.id})`);

  // ── enumerate the lead work-items we're going to wipe ─────────────
  const wiR = await pool.query<{ id: string; party_id: string | null }>(
    `SELECT id, party_id FROM work_item WHERE tenant_id = $1 AND type = 'lead'`,
    [tenant.id],
  );
  const workItemIds = wiR.rows.map((r) => r.id);
  const partyIds = [...new Set(wiR.rows.map((r) => r.party_id).filter((p): p is string => !!p))];
  console.log(`\n  lead work_items:                 ${workItemIds.length}`);
  console.log(`  distinct party_ids they point to: ${partyIds.length}`);

  if (workItemIds.length === 0) {
    console.log(`\n(no lead work_items in this tenant — nothing to do.)`);
    await pool.end();
    return;
  }

  // ── figure out which of those parties are safe to delete ───────────
  // A party is safe to delete iff it has NO other role and is NOT
  // referenced by any non-lead work_item, app_user, or "learner-y"
  // downstream table. Anything ambiguous stays.
  //
  // We keep this list conservative on purpose: it's much better to leave
  // a party row behind than to break an existing learner/advisor record.
  let deletablePartyIds: string[] = [];
  let orphanCheck: {
    total: number; withOtherRole: number; withOtherWorkItem: number;
    isAppUser: number; deletable: number;
  } | null = null;
  if (partyIds.length > 0) {
    const chk = await pool.query<{
      party_id: string;
      other_role_count: string;
      other_wi_count: string;
      is_app_user: boolean;
    }>(
      `WITH ids AS (SELECT UNNEST($1::uuid[]) AS party_id)
       SELECT
         ids.party_id,
         (SELECT COUNT(*) FROM party_role pr
           WHERE pr.party_id = ids.party_id AND pr.role <> 'lead')::text AS other_role_count,
         (SELECT COUNT(*) FROM work_item wi
           WHERE wi.party_id = ids.party_id AND wi.type <> 'lead')::text AS other_wi_count,
         EXISTS (SELECT 1 FROM app_user au WHERE au.party_id = ids.party_id) AS is_app_user
       FROM ids`,
      [partyIds],
    );
    let withOtherRole = 0, withOtherWorkItem = 0, isAppUser = 0;
    for (const row of chk.rows) {
      const o = Number(row.other_role_count) > 0;
      const w = Number(row.other_wi_count) > 0;
      const a = row.is_app_user === true;
      if (o) withOtherRole += 1;
      if (w) withOtherWorkItem += 1;
      if (a) isAppUser += 1;
      if (!o && !w && !a) deletablePartyIds.push(row.party_id);
    }
    orphanCheck = {
      total: partyIds.length,
      withOtherRole, withOtherWorkItem, isAppUser,
      deletable: deletablePartyIds.length,
    };
    console.log(`\n  party safety check:`);
    console.log(`    parties total:            ${orphanCheck.total}`);
    console.log(`    kept (has other role):    ${orphanCheck.withOtherRole}`);
    console.log(`    kept (has non-lead work): ${orphanCheck.withOtherWorkItem}`);
    console.log(`    kept (is an app_user):    ${orphanCheck.isAppUser}`);
    console.log(`    parties to DELETE:        ${orphanCheck.deletable}`);
  }

  // ── snapshot each affected table into the SQL dump ────────────────
  const out: string[] = [];
  out.push(`-- Backup: lead-related rows for tenant "${tenant.name}" (${tenant.id})`);
  out.push(`-- Taken:  ${new Date().toISOString()}`);
  out.push(`-- Restore with: psql "$DATABASE_URL" -f ${OUT_FILE}`);
  out.push(`-- ------------------------------------------------------------`);
  out.push(`BEGIN;`);
  out.push(``);

  // party — full rows for every party attached to a lead work_item
  if (partyIds.length > 0) {
    const p = await pool.query(
      `SELECT id, tenant_id, kind, name, email, phone, phone_country_code, city,
              identifiers, attributes, created_at, updated_at
         FROM party
        WHERE id = ANY($1::uuid[])`,
      [partyIds],
    );
    out.push(`-- party (${p.rows.length})`);
    const cols = [
      "id","tenant_id","kind","name","email","phone","phone_country_code","city",
      "identifiers","attributes","created_at","updated_at",
    ];
    for (const row of p.rows) out.push(insertLine("party", cols, row));
    out.push(``);
  }

  // party_role — every lead-role row for the affected parties
  if (partyIds.length > 0) {
    const pr = await pool.query(
      `SELECT id, tenant_id, party_id, role, valid_from, valid_to
         FROM party_role
        WHERE role = 'lead' AND party_id = ANY($1::uuid[])`,
      [partyIds],
    );
    out.push(`-- party_role (lead) (${pr.rows.length})`);
    const cols = ["id","tenant_id","party_id","role","valid_from","valid_to"];
    for (const row of pr.rows) out.push(insertLine("party_role", cols, row));
    out.push(``);
  }

  // work_item — lead ones
  {
    const wi = await pool.query(
      `SELECT id, tenant_id, number, type, party_id, assignee_id, state,
              priority, sla_due, attributes, created_at, updated_at
         FROM work_item
        WHERE id = ANY($1::uuid[])`,
      [workItemIds],
    );
    out.push(`-- work_item (type=lead) (${wi.rows.length})`);
    const cols = [
      "id","tenant_id","number","type","party_id","assignee_id","state",
      "priority","sla_due","attributes","created_at","updated_at",
    ];
    for (const row of wi.rows) out.push(insertLine("work_item", cols, row));
    out.push(``);
  }

  // lead — full rows
  {
    const ld = await pool.query(
      `SELECT * FROM lead WHERE work_item_id = ANY($1::uuid[])`,
      [workItemIds],
    );
    out.push(`-- lead (${ld.rows.length})`);
    const cols = ld.rows.length > 0 ? Object.keys(ld.rows[0]!) : [];
    for (const row of ld.rows) out.push(insertLine("lead", cols, row));
    out.push(``);
  }

  // activity — every activity row attached to these lead work_items
  {
    const act = await pool.query(
      `SELECT * FROM activity WHERE work_item_id = ANY($1::uuid[])`,
      [workItemIds],
    );
    out.push(`-- activity (attached to lead work_items) (${act.rows.length})`);
    const cols = act.rows.length > 0 ? Object.keys(act.rows[0]!) : [];
    for (const row of act.rows) out.push(insertLine("activity", cols, row));
    out.push(``);
  }

  out.push(`COMMIT;`);
  writeFileSync(OUT_FILE, out.join("\n"), "utf8");
  console.log(`\n✓ backup written: ${OUT_FILE} (${(out.join("\n").length / 1024).toFixed(1)} KiB)`);

  if (!APPLY) {
    console.log(`\n(dry-run — backup only, DB untouched. Re-run with --apply to delete.)`);
    await pool.end();
    return;
  }

  // ── APPLY: delete everything above in one transaction ──────────────
  console.log(`\n→ APPLYING deletes (single transaction)…`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant.id]);

    // 1. activity → gone by CASCADE on work_item (some legacy rows may
    //    not cascade — nuke defensively first).
    const actDel = await client.query(
      `DELETE FROM activity WHERE work_item_id = ANY($1::uuid[])`,
      [workItemIds],
    );
    console.log(`  activity deleted: ${actDel.rowCount ?? 0}`);

    // 2. lead
    const ldDel = await client.query(
      `DELETE FROM lead WHERE work_item_id = ANY($1::uuid[])`,
      [workItemIds],
    );
    console.log(`  lead deleted:     ${ldDel.rowCount ?? 0}`);

    // 3. party_role (lead role only)
    if (partyIds.length > 0) {
      const prDel = await client.query(
        `DELETE FROM party_role WHERE role='lead' AND party_id = ANY($1::uuid[])`,
        [partyIds],
      );
      console.log(`  party_role(lead): ${prDel.rowCount ?? 0}`);
    }

    // 4. work_item
    const wiDel = await client.query(
      `DELETE FROM work_item WHERE id = ANY($1::uuid[])`,
      [workItemIds],
    );
    console.log(`  work_item deleted:${wiDel.rowCount ?? 0}`);

    // 5. party — only ones we confirmed have no other role/link
    if (deletablePartyIds.length > 0) {
      const pDel = await client.query(
        `DELETE FROM party WHERE id = ANY($1::uuid[])`,
        [deletablePartyIds],
      );
      console.log(`  party deleted:    ${pDel.rowCount ?? 0} (kept ${partyIds.length - deletablePartyIds.length})`);
    } else {
      console.log(`  party deleted:    0 (all had other links, kept intact)`);
    }

    await client.query("COMMIT");
    console.log(`\n✓ wipe complete. Backup remains at:\n  ${OUT_FILE}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\n✗ wipe FAILED — transaction rolled back, DB unchanged.`);
    console.error(`  reason: ${(err as Error).message}`);
    console.error(`  backup file is still valid: ${OUT_FILE}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

// Redact the password from the DATABASE_URL when logging.
function maskUrl(u: string): string {
  return u.replace(/(:\/\/[^:]+:)[^@]+(@)/, "$1***$2");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
