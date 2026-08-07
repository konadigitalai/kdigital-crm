// Dev-only cleanup: delete "Unknown +…" party rows AND cascaded rows,
// created by the outbound bug where a lead-number like "LEAD-9864" was
// mis-parsed into phone "+9864".
//
// Dry-run by default. Set --yes to actually delete.
//
// Run:
//   npm run db:twilio-cleanup-junk          # preview only
//   npm run db:twilio-cleanup-junk -- --yes # actually delete
//
// Only touches parties whose name matches 'Unknown +…' AND whose phone
// has <8 digits (a real E.164 is at least 8 digits after '+'). Keeps
// any legit "Unknown +919…" contacts we auto-created from real inbound
// webhooks — those all have realistic-length numbers.

import { pool } from "./client.js";

async function main() {
  const dryRun = !process.argv.includes("--yes");
  console.log(dryRun ? "DRY-RUN — pass --yes to actually delete." : "LIVE — deleting matched rows.");
  console.log();

  const candidates = await pool.query<{ id: string; name: string; phone: string | null }>(`
    SELECT id, name, phone
    FROM party
    WHERE name LIKE 'Unknown +%'
      AND (
        phone IS NULL
        OR char_length(regexp_replace(phone, '[^0-9]', '', 'g')) < 8
      )
    ORDER BY name
  `);

  if (!candidates.rowCount) {
    console.log("No junk parties found. Nothing to do.");
    await pool.end();
    return;
  }

  console.log(`Junk party rows: ${candidates.rowCount}`);
  for (const r of candidates.rows) {
    console.log(`  • ${r.name} (phone=${r.phone ?? "—"}) — id=${r.id}`);
  }

  const ids = candidates.rows.map((r) => r.id);

  const msgCount = await pool.query<{ n: string }>(`
    SELECT COUNT(*)::text AS n
    FROM tw_message m
    WHERE m.conversation_id IN (
      SELECT id FROM tw_conversation WHERE party_id = ANY($1::uuid[])
    )
  `, [ids]);
  const convCount = await pool.query<{ n: string }>(`
    SELECT COUNT(*)::text AS n FROM tw_conversation WHERE party_id = ANY($1::uuid[])
  `, [ids]);
  const cpCount = await pool.query<{ n: string }>(`
    SELECT COUNT(*)::text AS n FROM contact_point WHERE party_id = ANY($1::uuid[])
  `, [ids]);

  console.log();
  console.log("Would cascade-delete:");
  console.log(`  tw_message      rows: ${msgCount.rows[0]!.n}`);
  console.log(`  tw_conversation rows: ${convCount.rows[0]!.n}`);
  console.log(`  contact_point   rows: ${cpCount.rows[0]!.n}`);
  console.log(`  party           rows: ${candidates.rowCount}`);

  if (dryRun) {
    console.log();
    console.log("Preview only. Re-run with --yes to actually delete.");
    await pool.end();
    return;
  }

  console.log();
  console.log("Deleting…");

  // Explicit child deletes first — party.id has ON DELETE CASCADE for most of
  // these already, but doing them explicitly gives clearer per-step output.
  await pool.query(
    `DELETE FROM tw_message WHERE conversation_id IN (
       SELECT id FROM tw_conversation WHERE party_id = ANY($1::uuid[])
     )`,
    [ids],
  );
  console.log(`  tw_message      → deleted`);
  await pool.query(
    `DELETE FROM tw_conversation WHERE party_id = ANY($1::uuid[])`,
    [ids],
  );
  console.log(`  tw_conversation → deleted`);
  await pool.query(
    `DELETE FROM contact_point WHERE party_id = ANY($1::uuid[])`,
    [ids],
  );
  console.log(`  contact_point   → deleted`);
  const pDel = await pool.query(
    `DELETE FROM party WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  console.log(`  party           → deleted ${pDel.rowCount ?? 0} rows`);

  await pool.end();
  console.log();
  console.log("Done.");
}

main().catch((err) => { console.error(err); process.exit(1); });
