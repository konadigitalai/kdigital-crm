// Purge parties that exist ONLY because the Gmail sync invented them.
//
// The first Gmail backfill ran before the bulk filters existed and created a
// stub party for every automated sender it saw (Slack, Vimeo, OpenAI, …). This
// removes them. It is deliberately conservative — a party is only a candidate
// when ALL of these hold:
//
//   - it owns an email conversation, AND
//   - it has NO work_item (so it is not a lead / case / anything), AND
//   - it has NO non-email conversation (no WhatsApp or voice history), AND
//   - it has NO party_role rows, AND
//   - it is not referenced as an app_user's party, AND
//   - it has no activity rows on any work_item.
//
// A real person you happen to have emailed will normally fail one of those
// (they're a lead, or you've WhatsApped them). Anything that passes is, by
// construction, a row nothing else in the CRM points at.
//
// DRY RUN BY DEFAULT. Prints what it would delete and exits.
//   npx tsx src/db/purge-gmail-junk-parties.ts            # show candidates
//   npx tsx src/db/purge-gmail-junk-parties.ts --apply    # actually delete
//
// Deletion cascades: tw_message + tw_message_media go via tw_conversation's
// ON DELETE CASCADE; contact_point and party_consent cascade off party.

import "dotenv/config";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const APPLY = process.argv.includes("--apply");

const pool = new pg.Pool({
  connectionString: url,
  ssl: url.includes(".postgres.database.azure.com") ? { rejectUnauthorized: true } : false,
});

// One source of truth for "which parties are junk", used by both the preview
// and the delete so they can never disagree.
const CANDIDATES = `
  SELECT p.id, p.name, p.email,
         (SELECT count(*)::int FROM tw_message m
          JOIN tw_conversation c2 ON c2.id = m.conversation_id
          WHERE c2.party_id = p.id) AS msg_count
  FROM party p
  WHERE EXISTS (
          SELECT 1 FROM tw_conversation c
          WHERE c.party_id = p.id AND c.channel = 'email'
        )
    AND NOT EXISTS (SELECT 1 FROM work_item w       WHERE w.party_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM tw_conversation c WHERE c.party_id = p.id AND c.channel <> 'email')
    AND NOT EXISTS (SELECT 1 FROM party_role r      WHERE r.party_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM app_user u        WHERE u.party_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM activity a        WHERE a.party_id = p.id AND a.work_item_id IS NOT NULL)
  ORDER BY p.name
`;

async function main() {
  const { rows } = await pool.query<{
    id: string; name: string; email: string | null; msg_count: number;
  }>(CANDIDATES);

  if (rows.length === 0) {
    console.log("Nothing to purge — no sync-only parties found.");
    await pool.end();
    return;
  }

  console.log(`${rows.length} sync-only ${rows.length === 1 ? "party" : "parties"}:\n`);
  let totalMsgs = 0;
  for (const r of rows) {
    totalMsgs += r.msg_count;
    console.log(`  ${(r.name ?? "").padEnd(38)} ${(r.email ?? "").padEnd(44)} ${r.msg_count} msg`);
  }
  console.log(`\n  → ${rows.length} parties, ${totalMsgs} email messages, plus their`);
  console.log("    contact_point / party_consent / tw_conversation rows.");

  // Show what is deliberately being SPARED, so the blast radius is legible.
  const spared = await pool.query<{ name: string; email: string; why: string }>(`
    SELECT p.name, p.email,
           CASE
             WHEN EXISTS (SELECT 1 FROM work_item w WHERE w.party_id = p.id) THEN 'has a lead/work_item'
             WHEN EXISTS (SELECT 1 FROM tw_conversation c WHERE c.party_id = p.id AND c.channel <> 'email') THEN 'has WhatsApp/voice history'
             WHEN EXISTS (SELECT 1 FROM app_user u WHERE u.party_id = p.id) THEN 'is a CRM user'
             WHEN EXISTS (SELECT 1 FROM party_role r WHERE r.party_id = p.id) THEN 'has a party_role'
             ELSE 'has timeline activity'
           END AS why
    FROM party p
    WHERE EXISTS (SELECT 1 FROM tw_conversation c WHERE c.party_id = p.id AND c.channel = 'email')
      AND p.id NOT IN (SELECT id FROM (${CANDIDATES}) q)
  `);
  if (spared.rows.length) {
    console.log(`\n  SPARED (${spared.rows.length}) — email parties that are real:`);
    for (const s of spared.rows) {
      console.log(`    ${(s.name ?? "").padEnd(28)} ${(s.email ?? "").padEnd(34)} ${s.why}`);
    }
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing deleted. Re-run with --apply to delete.");
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids = rows.map((r) => r.id);
    // tw_conversation cascades to tw_message → tw_message_media.
    const conv = await client.query(
      `DELETE FROM tw_conversation WHERE party_id = ANY($1::uuid[]) RETURNING id`, [ids],
    );
    const cp = await client.query(
      `DELETE FROM contact_point WHERE party_id = ANY($1::uuid[]) RETURNING id`, [ids],
    );
    const pc = await client.query(
      `DELETE FROM party_consent WHERE party_id = ANY($1::uuid[]) RETURNING id`, [ids],
    );
    const act = await client.query(
      `DELETE FROM activity WHERE party_id = ANY($1::uuid[]) RETURNING id`, [ids],
    );
    const par = await client.query(
      `DELETE FROM party WHERE id = ANY($1::uuid[]) RETURNING id`, [ids],
    );
    await client.query("COMMIT");
    console.log("\nDeleted:");
    console.log(`  tw_conversation : ${conv.rowCount}  (messages + media cascaded)`);
    console.log(`  contact_point   : ${cp.rowCount}`);
    console.log(`  party_consent   : ${pc.rowCount}`);
    console.log(`  activity        : ${act.rowCount}`);
    console.log(`  party           : ${par.rowCount}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch((err) => {
  console.error("purge failed:", (err as Error).message);
  process.exit(1);
});
