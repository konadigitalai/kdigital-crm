// Read-only diagnostic: show every tw_conversation + tw_message across all
// tenants. Handy for debugging Twilio send/receive flows in dev.
//
// Run:  npm run db:twilio-peek
//
// Also lists any "Unknown +…" party rows created by the outbound bug —
// those are the ones you probably want to drop with _twilio-cleanup-junk.ts.

import { pool } from "./client";

async function main() {
  const info = await pool.query<{ current_database: string }>(
    `SELECT current_database()`,
  );
  console.log("Connected to:", info.rows[0]!.current_database);
  console.log();

  const convs = await pool.query<{
    id: string; channel: string; status: string;
    is_unlinked: boolean; unread_count: number;
    party_id: string; party_name: string; party_phone: string | null;
    last_message_text: string | null; last_message_at: string | null;
    lead_number: string | null;
  }>(`
    SELECT c.id, c.channel, c.status, c.is_unlinked, c.unread_count,
           c.party_id, p.name AS party_name, p.phone AS party_phone,
           c.last_message_text, c.last_message_at,
           (
             SELECT number FROM work_item
             WHERE party_id = p.id AND type = 'lead'
             ORDER BY created_at DESC LIMIT 1
           ) AS lead_number
    FROM tw_conversation c
    JOIN party p ON p.id = c.party_id
    ORDER BY c.last_message_at DESC NULLS LAST, c.updated_at DESC
  `);
  console.log(`tw_conversation rows: ${convs.rowCount}`);
  for (const r of convs.rows) {
    const flag = r.is_unlinked ? " [UNLINKED]" : "";
    const lead = r.lead_number ? ` (${r.lead_number})` : "";
    console.log(
      `  • ${r.channel.padEnd(8)} · ${r.party_name.padEnd(28)} · ${r.party_phone ?? "—"}` +
      `${lead}${flag}`,
    );
    console.log(`      convo: ${r.id}`);
    if (r.last_message_text) {
      const preview = r.last_message_text.replace(/\s+/g, " ").slice(0, 80);
      console.log(`      last:  "${preview}" @ ${r.last_message_at ?? "?"}`);
    }
  }
  console.log();

  const msgs = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM tw_message`,
  );
  console.log(`tw_message row count: ${msgs.rows[0]!.n}`);

  const failed = await pool.query<{ id: string; status: string; error_code: string | null; error_message: string | null; body: string | null; to_number: string }>(
    `SELECT id, status, error_code, error_message, body, to_number
     FROM tw_message
     WHERE status = 'failed'
     ORDER BY sent_at DESC
     LIMIT 20`,
  );
  if (failed.rowCount) {
    console.log();
    console.log(`Recent failed sends (${failed.rowCount}):`);
    for (const r of failed.rows) {
      console.log(`  • to ${r.to_number} · err ${r.error_code ?? "?"} · ${r.error_message?.slice(0, 100) ?? ""}`);
      console.log(`      body: "${(r.body ?? "").slice(0, 80)}"`);
    }
  }
  console.log();

  const junk = await pool.query<{ id: string; name: string; phone: string | null }>(
    `SELECT id, name, phone FROM party WHERE name LIKE 'Unknown +%' ORDER BY name`,
  );
  console.log(`"Unknown +…" parties: ${junk.rowCount}`);
  for (const r of junk.rows) {
    console.log(`  • ${r.name.padEnd(30)} · phone=${r.phone ?? "—"} · id=${r.id}`);
  }

  await pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
