// Read-only diagnostic. Show what scopes the current user's Slack link
// actually has, and hit Slack's conversations.list live to see how many
// channels each type returns.
import { pool } from "./client.js";

const SLACK_API = "https://slack.com/api";

async function callSlack(token: string, path: string): Promise<any> {
  const r = await fetch(`${SLACK_API}/${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  return r.json();
}

async function main() {
  const info = await pool.query<{ current_database: string }>(`SELECT current_database()`);
  console.log("connected to:", info.rows[0].current_database);

  const rows = await pool.query<{
    id: string;
    app_user_id: string;
    slack_user_id: string;
    slack_team_id: string | null;
    scopes: string | null;
    connected_at: string;
    user_token: string;
  }>(`SELECT id, app_user_id, slack_user_id, slack_team_id, scopes, connected_at::text AS connected_at, user_token FROM slack_user_link`);

  if (rows.rows.length === 0) {
    console.log("no rows in slack_user_link — you haven't connected in this DB yet.");
    await pool.end();
    return;
  }

  for (const r of rows.rows) {
    console.log(`\n--- slack_user_link row ${r.id} ---`);
    console.log(`  app_user_id  : ${r.app_user_id}`);
    console.log(`  slack_user_id: ${r.slack_user_id}`);
    console.log(`  slack_team_id: ${r.slack_team_id}`);
    console.log(`  connected_at : ${r.connected_at}`);
    console.log(`  scopes       : ${r.scopes}`);
    console.log(`  token prefix : ${r.user_token.slice(0, 12)}…`);

    // auth.test to confirm the token still works and see who it thinks we are.
    const at = await callSlack(r.user_token, "auth.test");
    console.log(`  auth.test    : ${JSON.stringify(at)}`);

    // conversations.list — public
    const pub = await callSlack(r.user_token, "conversations.list?types=public_channel&limit=1000&exclude_archived=true");
    console.log(`  public channels: ${(pub.channels ?? []).length} total, ${(pub.channels ?? []).filter((c: any) => c.is_member).length} where I'm a member`);

    // conversations.list — private (requires groups:read on user token)
    const priv = await callSlack(r.user_token, "conversations.list?types=private_channel&limit=1000&exclude_archived=true");
    if (priv.ok) {
      console.log(`  private channels: ${(priv.channels ?? []).length} total, ${(priv.channels ?? []).filter((c: any) => c.is_member).length} where I'm a member`);
    } else {
      console.log(`  private channels: ERROR ${priv.error} (needs groups:read on the user token)`);
    }
  }

  await pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
