// Dump the most recent tw_message row's raw Twilio payload, so we can see
// exactly what fields the webhook sent us. Handy for debugging why a message
// got classified wrong (inbound-vs-status heuristics).
//
// Run: npm run db:twilio-raw-peek

import { pool } from "./client.js";

async function main() {
  const r = await pool.query<{
    id: string;
    direction: string;
    status: string;
    from_number: string;
    to_number: string;
    body: string | null;
    provider_message_id: string | null;
    sent_at: string;
    raw_payload: unknown;
  }>(`
    SELECT id, direction, status, from_number, to_number, body,
           provider_message_id, sent_at, raw_payload
    FROM tw_message
    ORDER BY sent_at DESC
    LIMIT 5
  `);
  for (const row of r.rows) {
    console.log("─".repeat(70));
    console.log(`direction=${row.direction} status=${row.status}`);
    console.log(`from=${row.from_number} → to=${row.to_number}`);
    console.log(`body=${JSON.stringify(row.body)}`);
    console.log(`provider_message_id=${row.provider_message_id}`);
    console.log(`sent_at=${row.sent_at}`);
    console.log(`raw_payload:`);
    console.log(JSON.stringify(row.raw_payload, null, 2));
  }
  await pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
