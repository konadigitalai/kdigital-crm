// One-shot: delete the app_user row created against the Google-oauth2 sub
// that got provisioned when Google login was still enabled. Run against
// whatever DB you connected via — should be decrm_prod for this cleanup.
//
// Read + delete. Dry-run by default: shows what would be deleted. Add
// --apply to actually delete.

import { pool } from "./client";

const APPLY = process.argv.includes("--apply");
const TARGET_EMAIL = "eswar@digitaledify.ai";

async function main() {
  const dbinfo = await pool.query<{ current_database: string }>(`SELECT current_database()`);
  console.log(`connected to: ${dbinfo.rows[0].current_database}`);
  console.log(`mode: ${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  const rows = await pool.query<{
    id: string; email: string; auth0_sub: string | null;
    party_id: string | null; role: string; created_at: string;
  }>(
    `SELECT id, email, auth0_sub, party_id, role, created_at::text AS created_at
       FROM app_user
      WHERE LOWER(email) = LOWER($1)
      ORDER BY created_at`,
    [TARGET_EMAIL],
  );
  console.log(`app_user rows matching ${TARGET_EMAIL}: ${rows.rows.length}`);
  for (const r of rows.rows) {
    console.log(`  id=${r.id}  sub=${r.auth0_sub ?? "(null)"}  role=${r.role}  created=${r.created_at}`);
  }

  // The row we want to zap: the one whose auth0_sub starts with "google-oauth2|".
  const gRows = rows.rows.filter((r) => (r.auth0_sub ?? "").startsWith("google-oauth2|"));
  console.log(`\ncandidates for deletion (google-oauth2 sub): ${gRows.length}`);
  for (const r of gRows) console.log(`  id=${r.id}  sub=${r.auth0_sub}`);

  if (gRows.length === 0) {
    console.log("(nothing to delete.)");
    await pool.end();
    return;
  }

  if (!APPLY) {
    console.log("\n(dry-run — nothing changed. Re-run with --apply to delete.)");
    await pool.end();
    return;
  }

  // Delete inside a transaction. We drop the app_user row only. The party
  // row + party_role stays — the same person still exists as an Auth0
  // username/password user, and that account's app_user row references
  // the SAME party (see auth.ts provisionUser Step 4 rebinding).
  // If it turns out the Google user got a distinct party, we can clean
  // that up in a follow-up; for now the app_user delete unblocks login.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const del = await client.query(
      `DELETE FROM app_user WHERE id = ANY($1::uuid[]) RETURNING id`,
      [gRows.map((r) => r.id)],
    );
    console.log(`\ndeleted ${del.rowCount} app_user row(s).`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("failed, rolled back:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
