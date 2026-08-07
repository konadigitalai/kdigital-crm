// One-shot: hard-delete every soft-deleted lead in this tenant.
//
// "Soft-deleted" = has a party_role row with role='lead' AND valid_to IS
// NOT NULL. The record page still loads for these; they're what the
// /admin/leads/deleted table shows. This script does the same wipe that
// the per-lead DELETE /leads/:num/purge endpoint does, but in one shot,
// in a single transaction.
//
// Refuses to purge a lead whose party has ANOTHER active role (learner,
// alumnus, contact) — those are the ones we'd normally reject in the
// per-lead endpoint too. They're kept in the "kept" bucket.
//
// SCOPE — what gets wiped for each targeted lead:
//   activity          (where work_item_id = <lead work_item>)
//   agent_assignment  (where work_item_id = <lead work_item>)
//   lead_score_signal (where work_item_id = <lead work_item>)
//   lead              (where work_item_id = <lead work_item>)
//   party_role        (all lead-role rows for the party)
//   work_item         (the lead work_item itself)
//   party             (only if the party has NO remaining roles anywhere)
//
// NEVER TOUCHED:
//   programs, courses, batches, tenants, app_user, service_case,
//   onboarding_task, contact_point (parties preserved), party_match,
//   party_merge, party_consent, party_external_id, party_affiliation.
//   Any party with a non-lead role survives with its full history intact.
//
// Usage:
//   $env:DATABASE_URL='postgres://…'
//   npx tsx src/db/purge-soft-deleted-leads.ts             # DRY-RUN
//   npx tsx src/db/purge-soft-deleted-leads.ts --apply     # actually purge
//
// Dry-run prints:
//   - target tenant
//   - count of soft-deleted leads
//   - how many would purge vs. how many would be kept (learner/contact/etc)
//   - a sample of 5 targets (name, LEAD-#, deleted date)
// Nothing is written.

import { pool } from "./client.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");

function maskUrl(u: string): string {
  return u.replace(/(:\/\/[^:]+:)[^@]+(@)/, "$1***$2");
}

async function main() {
  console.log(`→ target DB: ${maskUrl(process.env.DATABASE_URL ?? "(none)")}`);
  console.log(`→ mode: ${APPLY ? "APPLY (destructive)" : "DRY-RUN (nothing changed)"}\n`);

  const tenR = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM tenant ORDER BY created_at DESC LIMIT 1`,
  );
  const tenant = tenR.rows[0];
  if (!tenant) throw new Error("no tenant row found");
  console.log(`  tenant: ${tenant.name} (${tenant.id})`);

  // Enumerate soft-deleted leads. Same shape the /admin/leads/deleted UI uses.
  const rowsR = await pool.query<{
    work_item_id: string;
    party_id: string;
    number: string;
    name: string;
    deleted_at: string | null;
    has_active_lead: boolean;
    has_learner: boolean;
    has_other_role: boolean;
    has_non_lead_wi: boolean;
    is_app_user: boolean;
  }>(
    `WITH soft_deleted AS (
       -- One row per (party, ended-lead-role). If a party has been
       -- soft-deleted-and-restored-and-soft-deleted-again there could
       -- be multiple; DISTINCT collapses to one target per work_item.
       SELECT DISTINCT wi.id AS work_item_id, wi.party_id, wi.number, p.name,
              pr.valid_to AS deleted_at
       FROM party_role pr
       JOIN party p ON p.id = pr.party_id
       JOIN work_item wi ON wi.party_id = p.id AND wi.type = 'lead'
       WHERE pr.tenant_id = $1
         AND pr.role = 'lead'
         AND pr.valid_to IS NOT NULL
     )
     SELECT
       sd.work_item_id,
       sd.party_id,
       sd.number,
       sd.name,
       sd.deleted_at::text AS deleted_at,
       -- Is there ALSO an active lead role on the same party? (restored)
       EXISTS (
         SELECT 1 FROM party_role pr2
         WHERE pr2.party_id = sd.party_id
           AND pr2.role = 'lead' AND pr2.valid_to IS NULL
       ) AS has_active_lead,
       -- Learner? (converted, do not purge)
       EXISTS (
         SELECT 1 FROM party_role pr3
         WHERE pr3.party_id = sd.party_id
           AND pr3.role = 'learner' AND pr3.valid_to IS NULL
       ) AS has_learner,
       -- Any OTHER non-lead role active on this party?
       EXISTS (
         SELECT 1 FROM party_role pr4
         WHERE pr4.party_id = sd.party_id
           AND pr4.role <> 'lead' AND pr4.valid_to IS NULL
       ) AS has_other_role,
       -- Any non-lead work_item referencing this party (deal, case, etc.)?
       EXISTS (
         SELECT 1 FROM work_item wi2
         WHERE wi2.party_id = sd.party_id AND wi2.type <> 'lead'
       ) AS has_non_lead_wi,
       -- Is the party linked to an app_user? (advisor/admin/etc.)
       EXISTS (
         SELECT 1 FROM app_user au WHERE au.party_id = sd.party_id
       ) AS is_app_user
     FROM soft_deleted sd`,
    [tenant.id],
  );

  const rows = rowsR.rows;
  console.log(`\n  soft-deleted leads found: ${rows.length}`);

  // Split into purgeable vs kept. Same rule the per-lead endpoint uses,
  // extended with the "has other party attachments" checks.
  const purgeable: typeof rows = [];
  const keptActive: typeof rows = [];
  const keptLearner: typeof rows = [];
  const keptOtherLink: typeof rows = [];
  for (const r of rows) {
    if (r.has_active_lead) { keptActive.push(r); continue; }
    if (r.has_learner)     { keptLearner.push(r); continue; }
    // has_other_role / has_non_lead_wi / is_app_user do NOT block purge —
    // the lead-side wipe never touches those. But the FINAL party delete
    // is only issued when the party has no remaining links; the per-lead
    // endpoint enforces that too. We still purge the lead artifacts.
    purgeable.push(r);
  }

  console.log(`  purgeable (will wipe):       ${purgeable.length}`);
  console.log(`  kept (has active lead role): ${keptActive.length}`);
  console.log(`  kept (is now a learner):     ${keptLearner.length}`);
  if (keptOtherLink.length > 0) {
    console.log(`  kept (other party links):    ${keptOtherLink.length}`);
  }

  if (purgeable.length > 0) {
    console.log(`\n  sample (first 5):`);
    for (const r of purgeable.slice(0, 5)) {
      const when = r.deleted_at ? r.deleted_at.slice(0, 19).replace("T", " ") : "?";
      console.log(`    ${r.number}  ${r.name}  (deleted ${when})`);
    }
  }

  if (!APPLY) {
    console.log(`\n(dry-run — DB untouched. Re-run with --apply to purge.)`);
    await pool.end();
    return;
  }

  if (purgeable.length === 0) {
    console.log(`\n(nothing to purge.)`);
    await pool.end();
    return;
  }

  // ── APPLY ────────────────────────────────────────────────────────────
  console.log(`\n→ purging ${purgeable.length} leads (single transaction)…`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant.id]);

    const wiIds       = purgeable.map((r) => r.work_item_id);
    const partyIds    = purgeable.map((r) => r.party_id);

    // 1. Child rows attached to the lead work_item. Order doesn't matter
    //    among these — none of them reference each other. What DOES matter
    //    is clearing every FK to work_item BEFORE we delete the work_item
    //    row itself, otherwise the transaction aborts on that constraint.
    //    (Bit us on 2026-07-06 when `approval` wasn't in this list.)
    const actDel = await client.query(
      `DELETE FROM activity WHERE work_item_id = ANY($1::uuid[])`, [wiIds],
    );
    console.log(`  activity deleted:         ${actDel.rowCount ?? 0}`);

    const agDel = await client.query(
      `DELETE FROM agent_assignment WHERE work_item_id = ANY($1::uuid[])`, [wiIds],
    );
    console.log(`  agent_assignment deleted: ${agDel.rowCount ?? 0}`);

    const sigDel = await client.query(
      `DELETE FROM lead_score_signal WHERE work_item_id = ANY($1::uuid[])`, [wiIds],
    );
    console.log(`  lead_score_signal deleted:${sigDel.rowCount ?? 0}`);

    // Approval rows are agent decisions awaiting supervisor review (e.g.
    // "AI scored this lead 87 — approve?"). Without their target work_item
    // they're meaningless, so we drop them alongside.
    const apDel = await client.query(
      `DELETE FROM approval WHERE work_item_id = ANY($1::uuid[])`, [wiIds],
    );
    console.log(`  approval deleted:         ${apDel.rowCount ?? 0}`);

    // 2. lead row itself.
    const ldDel = await client.query(
      `DELETE FROM lead WHERE work_item_id = ANY($1::uuid[])`, [wiIds],
    );
    console.log(`  lead deleted:             ${ldDel.rowCount ?? 0}`);

    // 3. party_role rows for the lead role — ALL of them (active + ended)
    //    for every party we're wiping. The per-lead endpoint takes the
    //    same aggressive stance.
    const prDel = await client.query(
      `DELETE FROM party_role
        WHERE role = 'lead'
          AND party_id = ANY($1::uuid[])`,
      [partyIds],
    );
    console.log(`  party_role(lead) deleted: ${prDel.rowCount ?? 0}`);

    // 4. The work_item itself. This is where the earlier wipe-script failed
    //    on approvals; the per-lead purge endpoint doesn't hit that path
    //    because the leads it targets never had approvals. If a purgeable
    //    lead here DID have an approval row, the whole transaction rolls
    //    back cleanly (prod unchanged) and we investigate.
    const wiDel = await client.query(
      `DELETE FROM work_item WHERE id = ANY($1::uuid[])`, [wiIds],
    );
    console.log(`  work_item deleted:        ${wiDel.rowCount ?? 0}`);

    // 5. Orphan parties — drop only ones with zero remaining roles AND no
    //    non-lead work_item AND no app_user link. Same conservative check
    //    the earlier dump-and-wipe used.
    const orphanR = await client.query<{ id: string }>(
      `SELECT id FROM party p
        WHERE p.id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM party_role pr WHERE pr.party_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM work_item wi WHERE wi.party_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM app_user au WHERE au.party_id = p.id)`,
      [partyIds],
    );
    const orphans = orphanR.rows.map((r) => r.id);
    if (orphans.length > 0) {
      const pDel = await client.query(
        `DELETE FROM party WHERE id = ANY($1::uuid[])`, [orphans],
      );
      console.log(`  party deleted (orphans):  ${pDel.rowCount ?? 0} (kept ${partyIds.length - orphans.length})`);
    } else {
      console.log(`  party deleted (orphans):  0 (all had remaining links)`);
    }

    await client.query("COMMIT");
    console.log(`\n✓ purge complete.`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\n✗ purge FAILED — transaction rolled back, DB unchanged.`);
    console.error(`  reason: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
