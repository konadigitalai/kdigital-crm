// One-shot cleanup: hard-delete every app_user that never signed in via
// Auth0, plus the party row that shadows them. Every FK referencing those
// party ids is reassigned to a keeper admin first so PostgreSQL doesn't
// block the delete.
//
// "Real" is defined as: app_user.auth0_sub IS NOT NULL. On top of that you
// can whitelist extra emails via --keep-email a@b,c@d for accounts that are
// meant to survive even though nobody has signed in through Auth0 yet.
//
// Usage:
//   # Dry-run — prints what would happen, changes nothing:
//   npx tsx src/db/cleanup-fake-users.ts
//
//   # Actually run:
//   npx tsx src/db/cleanup-fake-users.ts --apply
//
//   # Extra emails to preserve even when auth0_sub is null:
//   npx tsx src/db/cleanup-fake-users.ts --apply \
//     --keep-email manikanta@edify.io,crmadmin@gmail.com
//
//   # Choose which admin inherits the reassigned refs (defaults to the
//   # first surviving admin):
//   npx tsx src/db/cleanup-fake-users.ts --apply \
//     --reassign-to crmadmin@gmail.com

import { pool } from "./client.js";

interface Args {
  apply: boolean;
  keepEmails: string[];
  reassignTo: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { apply: false, keepEmails: [], reassignTo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--apply") args.apply = true;
    else if (a === "--keep-email") {
      args.keepEmails = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--reassign-to") {
      args.reassignTo = String(argv[++i] ?? "").trim() || null;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

// FK columns on party.id that PostgreSQL will NOT auto-cascade or null out
// for us (see schema.ts — anything without `onDelete: 'cascade'` or
// `onDelete: 'set null'`). Each one must be reassigned to the keeper before
// the party row is dropped.
const REASSIGN_TARGETS: { table: string; column: string; label: string }[] = [
  { table: "work_item",         column: "party_id",       label: "work_item.party_id" },
  { table: "work_item",         column: "assignee_id",    label: "work_item.assignee_id" },
  { table: "lead",              column: "advisor_id",     label: "lead.advisor_id" },
  { table: "support_case",      column: "party_id",       label: "support_case.party_id" },
  { table: "support_case",      column: "created_by_id",  label: "support_case.created_by_id" },
  { table: "enrolment",         column: "party_id",       label: "enrolment.party_id" },
  { table: "course_assignment", column: "party_id",       label: "course_assignment.party_id" },
  { table: "batch_assignment",  column: "party_id",       label: "batch_assignment.party_id" },
  { table: "approval",          column: "decided_by",     label: "approval.decided_by" },
  { table: "forecast_snapshot", column: "generated_by",   label: "forecast_snapshot.generated_by" },
  { table: "attachment",        column: "party_id",       label: "attachment.party_id" },
];

async function main() {
  const args = parseArgs();

  const client = await pool.connect();
  try {
    // 1. Figure out who lives, who dies.
    console.log(`\n→ scanning app_user…`);
    const users = await client.query<{
      id: string; party_id: string; email: string; name: string | null;
      auth0_sub: string | null; role: string; active: boolean;
    }>(
      `SELECT id, party_id, email, name, auth0_sub, role, active
         FROM app_user
        ORDER BY email`,
    );

    const keepEmails = new Set(args.keepEmails.map((e) => e.toLowerCase()));
    const keep: typeof users.rows = [];
    const drop: typeof users.rows = [];
    for (const u of users.rows) {
      const hasAuth0 = !!u.auth0_sub;
      const whitelisted = keepEmails.has(u.email.toLowerCase());
      if (hasAuth0 || whitelisted) keep.push(u);
      else drop.push(u);
    }

    console.log(`  ${users.rows.length} total, ${keep.length} keep, ${drop.length} to delete`);
    console.log(`\nKEEP:`);
    for (const u of keep) {
      const flags: string[] = [u.role];
      if (u.auth0_sub) flags.push("auth0");
      if (!u.auth0_sub && keepEmails.has(u.email.toLowerCase())) flags.push("whitelist");
      if (!u.active) flags.push("inactive");
      console.log(`  ✓ ${u.email.padEnd(30)} ${u.name ?? "—"}   [${flags.join(", ")}]`);
    }
    console.log(`\nDELETE:`);
    for (const u of drop) {
      console.log(`  ✗ ${u.email.padEnd(30)} ${u.name ?? "—"}   [${u.role}${u.active ? "" : ", inactive"}]`);
    }

    if (drop.length === 0) {
      console.log(`\n✓ Nothing to do — no fake users found.`);
      return;
    }

    // 2. Sanity check — at least one admin must survive.
    const survivingAdmins = keep.filter((u) => u.role === "admin");
    if (survivingAdmins.length === 0) {
      console.error(`\n✗ Refusing to run: no admin would survive.`);
      console.error(`  Either sign into Auth0 with an admin account first, or pass`);
      console.error(`  --keep-email <admin@…> to preserve one explicitly.`);
      process.exit(1);
    }

    // 3. Pick the keeper — the party.id every reassigned FK points at.
    let keeperEmail = args.reassignTo?.toLowerCase();
    if (keeperEmail) {
      const match = keep.find((u) => u.email.toLowerCase() === keeperEmail);
      if (!match) {
        console.error(`\n✗ --reassign-to ${args.reassignTo} did not match any surviving user.`);
        process.exit(1);
      }
    }
    const keeper = keeperEmail
      ? keep.find((u) => u.email.toLowerCase() === keeperEmail)!
      : survivingAdmins[0]!;
    console.log(`\nReassign target: ${keeper.email} (${keeper.name ?? "—"})   party_id=${keeper.party_id}`);

    const dropPartyIds = drop.map((u) => u.party_id);
    const dropAppUserIds = drop.map((u) => u.id);

    // 4. Preview what each reassignment would touch (dry-run friendly).
    console.log(`\n→ counting references…`);
    for (const t of REASSIGN_TARGETS) {
      const r = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM ${t.table} WHERE ${t.column} = ANY($1::uuid[])`,
        [dropPartyIds],
      );
      const n = Number(r.rows[0]?.n ?? 0);
      if (n > 0) console.log(`  ${t.label.padEnd(30)} → ${n} row${n === 1 ? "" : "s"} to reassign`);
    }

    if (!args.apply) {
      console.log(`\n(dry-run — nothing changed. Re-run with --apply to execute.)`);
      return;
    }

    // 5. Do it, all in one transaction.
    console.log(`\n→ applying…`);
    await client.query("BEGIN");
    try {
      // Skip RLS by connecting as the admin role (this script uses
      // DATABASE_URL, i.e. decrm_admin, per client.ts).
      for (const t of REASSIGN_TARGETS) {
        const r = await client.query(
          `UPDATE ${t.table} SET ${t.column} = $1 WHERE ${t.column} = ANY($2::uuid[])`,
          [keeper.party_id, dropPartyIds],
        );
        if (r.rowCount) console.log(`  reassigned ${r.rowCount} on ${t.label}`);
      }

      // Belt-and-braces: activity/audit already have `ON DELETE SET NULL` so
      // PostgreSQL will null actor_party_id itself. Same for cohort trainer, etc.

      // Nuke the app_user rows first — the party.id CASCADE below would take
      // them anyway via `app_user_party_unique`, but doing it explicitly gives
      // clearer output.
      const uDel = await client.query(
        `DELETE FROM app_user WHERE id = ANY($1::uuid[])`,
        [dropAppUserIds],
      );
      console.log(`  deleted ${uDel.rowCount} app_user rows`);

      // Delete the party rows. CASCADE covers contact_point, party_role,
      // party_external_id, party_affiliation, party_consent,
      // edify_chat_session/message, saved_view, calendar_event/invitee,
      // leave_day, party_duplicate_candidate.
      const pDel = await client.query(
        `DELETE FROM party WHERE id = ANY($1::uuid[])`,
        [dropPartyIds],
      );
      console.log(`  deleted ${pDel.rowCount} party rows`);

      await client.query("COMMIT");
      console.log(`\n✓ cleanup complete.`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`\n✗ error:`, err.message);
  console.error(err);
  process.exit(1);
});
