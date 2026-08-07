// User-facing Slack read-only endpoints. Mounted BEHIND authMiddleware
// but WITHOUT the integrations.read admin gate — so any advisor who
// can view a lead can also check whether Slack is set up and see their
// own connection status, without needing admin-tier permissions.
//
// Everything here is either (a) a boolean/tiny object about workspace
// state, or (b) scoped to the caller's own app_user_id. No admin
// surface leaks through.
//
// Admin-only writes (save bot token, refresh directory, rule CRUD)
// stay in integrations.ts behind integrations.manage. This router only
// exposes the reads a share-dialog needs.

import { Router } from "@/server/http";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";
import { loadBotToken, loadUserToken } from "./integrations";

export const shareSlackUserRouter = Router();

// GET /share-slack/workspace-status — tenant-level: is there a bot token?
//
// Returns only { hasBotToken: boolean }. Team name / installed date etc.
// stay behind the admin surface. This is intentional — non-admin users
// don't need to see workspace metadata.
shareSlackUserRouter.get("/workspace-status", async (req, res, next) => {
  try {
    const token = await loadBotToken(req.tenantId!);
    res.json({ hasBotToken: !!token });
  } catch (err) { next(err); }
});

// GET /share-slack/my-status — per-user: has THIS user connected their
// Slack? Returns { connected, link? } where link has only the ids +
// connected_at — no token, no scopes list (scopes are irrelevant to
// the UI and were a minor leak in the old endpoint).
shareSlackUserRouter.get("/my-status", async (req, res, next) => {
  try {
    if (!req.userId) return res.status(401).json({ error: "not authenticated" });
    const link = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT slack_user_id AS "slackUserId",
               slack_team_id AS "slackTeamId",
               connected_at  AS "connectedAt"
        FROM slack_user_link
        WHERE app_user_id = ${req.userId} AND revoked_at IS NULL
        LIMIT 1
      `);
      return r.rows[0] ?? null;
    });
    if (!link) return res.json({ connected: false });
    res.json({ connected: true, link });
  } catch (err) { next(err); }
});

// GET /share-slack/directory?kind=channel|user
//
// Serves the Slack picker directly. Behaviour depends on kind + user
// connection state:
//
//   channel + user is Connected  → live from Slack via their xoxp token,
//                                  filtered to channels they are in
//   channel + user NOT connected → cached bot channels (workspace-wide)
//   user                          → cached bot user directory
//                                   (Slack workspace member list)
//
// The bot cache is only readable if the tenant has a bot token — if
// not, we return an empty list rather than an error (the dialog will
// show "no channels — ask your admin").
shareSlackUserRouter.get("/directory", async (req, res, next) => {
  try {
    if (!req.userId) return res.status(401).json({ error: "not authenticated" });
    const kind = String(req.query.kind ?? "channel");
    if (kind !== "channel" && kind !== "user") {
      return res.status(400).json({ error: "kind must be channel or user" });
    }

    // People picker — always the bot-cached list.
    if (kind === "user") {
      const rows = await withTenant(req.tenantId!, async (db) => {
        const r = await db.execute(sql`
          SELECT slack_id AS id, name,
                 COALESCE(display_name, real_name, name) AS "label",
                 real_name AS "realName", email, image_url AS "imageUrl"
          FROM slack_user_cache
          WHERE is_deleted = false AND is_bot = false
          ORDER BY COALESCE(display_name, real_name, name)
        `);
        return r.rows;
      });
      return res.json({ kind, items: rows });
    }

    // Channel picker — prefer user's own token when they've connected.
    const userLink = await loadUserToken(req.tenantId!, req.userId);
    if (userLink) {
      const { listAllChannels } = await import("../lib/slack-api");
      let channels;
      try { channels = await listAllChannels(userLink.token); }
      catch (err) {
        return res.status(502).json({ error: `Slack list_channels failed: ${(err as Error).message}` });
      }
      const items = channels
        .filter((c) => c.is_member && !c.is_archived)
        .map((c) => ({
          id: c.id, name: c.name,
          isPrivate: !!c.is_private,
          isMember: true,
          topic: c.topic?.value ?? null,
        }));
      return res.json({ kind, items });
    }

    // Fall back to bot cache — channels the bot is in.
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT slack_id AS id, name, is_private AS "isPrivate",
               is_member AS "isMember", topic
        FROM slack_channel_cache
        WHERE is_archived = false
        ORDER BY is_member DESC, name
      `);
      return r.rows;
    });
    res.json({ kind, items: rows });
  } catch (err) { next(err); }
});
