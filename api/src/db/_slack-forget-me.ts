// Read/write: delete the current user's Slack link so they can
// reconnect and re-consent to the current USER_SCOPES set. Useful
// after we add a scope to slack-oauth.ts (e.g. added im:write on
// 2026-07-07).
//
// Nukes every row in slack_user_link — safe on local dev where you
// are the only tester. If you're on a shared DB, prefer:
//   DELETE FROM slack_user_link WHERE app_user_id = '<your uuid>'
import { pool } from "./client.js";

async function main() {
  const info = await pool.query<{ current_database: string }>(`SELECT current_database()`);
  console.log(`connected to: ${info.rows[0].current_database}`);

  const r = await pool.query(`DELETE FROM slack_user_link`);
  console.log(`deleted ${r.rowCount ?? 0} row(s) from slack_user_link.`);
  console.log("Reconnect: go to CRM → Share to Slack → Connect Slack again.");

  await pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
