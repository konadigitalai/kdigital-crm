// Read-only: dump the cached Slack directory to stdout. No writes.
// Prints channels + humans-only users so you can eyeball what the
// refresh pulled in.

import { pool } from "./client";

async function main() {
  const t = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM tenant ORDER BY created_at DESC LIMIT 1`,
  );
  const tenant = t.rows[0];
  if (!tenant) throw new Error("no tenant found");
  console.log(`tenant: ${tenant.name} (${tenant.id})\n`);

  const ch = await pool.query<{
    slack_id: string; name: string;
    is_private: boolean; is_member: boolean; is_archived: boolean;
    topic: string | null;
  }>(
    `SELECT slack_id, name, is_private, is_member, is_archived, topic
       FROM slack_channel_cache
      WHERE tenant_id = $1
      ORDER BY name`,
    [tenant.id],
  );
  console.log(`=== channels (${ch.rows.length}) ===`);
  console.log(`ID           NAME                            PRIV  MEMBER  ARCH  TOPIC`);
  for (const r of ch.rows) {
    console.log(
      `${r.slack_id.padEnd(12)} ${(r.name ?? "").padEnd(31)} ` +
      `${(r.is_private ? "yes" : "no ").padEnd(5)} ` +
      `${(r.is_member ? "yes" : "no ").padEnd(7)} ` +
      `${(r.is_archived ? "yes" : "no ").padEnd(5)} ` +
      `${r.topic ?? ""}`,
    );
  }

  const us = await pool.query<{
    slack_id: string; name: string;
    real_name: string | null; display_name: string | null;
    email: string | null;
  }>(
    `SELECT slack_id, name, real_name, display_name, email
       FROM slack_user_cache
      WHERE tenant_id = $1 AND is_bot = false AND is_deleted = false
      ORDER BY COALESCE(display_name, real_name, name)`,
    [tenant.id],
  );
  console.log(`\n=== users (${us.rows.length}, non-bot non-deleted) ===`);
  console.log(`ID           HANDLE                REAL / DISPLAY NAME               EMAIL`);
  for (const r of us.rows) {
    const label = r.display_name || r.real_name || r.name;
    console.log(
      `${r.slack_id.padEnd(12)} @${(r.name ?? "").padEnd(20)} ` +
      `${(label ?? "").padEnd(33)} ` +
      `${r.email ?? ""}`,
    );
  }

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
