// Gmail sync worker.
//
// Polls every connected mailbox on a fixed tick and pulls in anything new.
// Same shape as lib/campaigns/worker.ts and lib/party/dedup-worker.ts —
// setInterval + a per-tick guard so ticks never overlap, all cursor state in
// the DB so a Render restart resumes cleanly.
//
// Why polling and not Gmail's Pub/Sub push:
//   - The API has no queue/Pub/Sub infrastructure, and push would need a GCP
//     topic + IAM + a watch() renewal loop (watches expire every 7 days).
//   - Render sleeps the free tier after 15 min idle, so a push arriving at a
//     cold instance can time out — the same reason the Exotel recording
//     backfill retries on a timer rather than trusting one callback.
//   - Cost is trivial: history.list is 2 quota units against a 1.2M/day budget,
//     so one mailbox polled every 60s spends ~2,880 units/day.
// Push can be layered on later as an accelerator without changing ingest.
//
// Cursor semantics: gmail_account.history_id is Gmail's watermark. We ask for
// everything after it, ingest, then advance. NULL means "never synced" — the
// first tick seeds it from the profile and (optionally) backfills recent mail
// rather than dragging in the mailbox's entire history.

import { sql } from "drizzle-orm";
import { appPool, withTenant } from "../../db/app.js";
import {
  readGoogleConfig, isGmailConfigured, GoogleNotConfigured,
  accessTokenFor, getProfile, listHistory, listMessages,
  httpStatusOf, isInvalidGrant,
  type GmailAccountRow,
} from "./client.js";
import { ingestGmailMessage } from "./ingest.js";
import type { DbExec } from "../twilio/inbox.js";

const WORKER_TICK_MS = 60_000;   // 1 minute
// How much mail to pull in when an account first connects. Enough that a lead's
// existing thread shows up immediately on connect; not so much that we spend
// ten minutes importing a two-year-old mailbox on the very first tick.
const BACKFILL_QUERY = "newer_than:30d";
const BACKFILL_MAX   = 100;
// After this many consecutive failures we stop polling the account, so one dead
// token doesn't burn a Gmail API call every 60s forever.
const MAX_SYNC_ERRORS = 10;

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startGmailWorker(): void {
  if (timer) return;
  if (!isGmailConfigured()) {
    console.log("[gmail-worker] not started — Gmail env not configured");
    return;
  }
  tick().catch((err) =>
    console.error("[gmail-worker] boot tick error:", (err as Error).message),
  );
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    tick()
      .catch((err) => console.error("[gmail-worker] tick error:", (err as Error).message))
      .finally(() => { ticking = false; });
  }, WORKER_TICK_MS);
  console.log(`[gmail-worker] started (every ${WORKER_TICK_MS}ms)`);
}

export function stopGmailWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

async function tick(): Promise<void> {
  let cfg;
  try { cfg = readGoogleConfig(); }
  catch (err) {
    if (err instanceof GoogleNotConfigured) return;   // env pulled out from under us
    throw err;
  }

  const client = await appPool.connect();
  let tenantIds: string[];
  try {
    const r = await client.query<{ id: string }>("SELECT id FROM tenant");
    tenantIds = r.rows.map((x) => x.id);
  } finally {
    client.release();
  }

  for (const tenantId of tenantIds) {
    try {
      await syncTenant(tenantId, cfg.internalDomain);
    } catch (err) {
      console.error(`[gmail-worker] tenant ${tenantId} failed:`, (err as Error).message);
    }
  }
}

async function syncTenant(tenantId: string, internalDomain: string): Promise<void> {
  // Each account gets its own transaction. A poison message in one mailbox
  // must not roll back the successful ingests of another — and withTenant
  // wraps a single transaction, so one big one would do exactly that.
  const accounts = await withTenant(tenantId, async (db) => {
    const r = await db.execute(sql`
      SELECT id, email, refresh_token AS "refreshToken", access_token AS "accessToken",
             expires_at AS "expiresAt", history_id AS "historyId",
             app_user_id AS "appUserId", is_shared AS "isShared"
      FROM gmail_account
      WHERE revoked_at IS NULL
        AND sync_error_count < ${MAX_SYNC_ERRORS}
      ORDER BY last_synced_at ASC NULLS FIRST
    `);
    return r.rows as unknown as GmailAccountRow[];
  });

  for (const account of accounts) {
    try {
      await withTenant(tenantId, async (db) => {
        await syncAccount(db, tenantId, account, internalDomain);
      });
    } catch (err) {
      await recordSyncError(tenantId, account, err);
    }
  }
}

async function syncAccount(
  db: DbExec,
  tenantId: string,
  account: GmailAccountRow,
  internalDomain: string,
): Promise<void> {
  const token = await accessTokenFor(db, account);

  // First sync: seed the cursor and backfill a recent window.
  if (!account.historyId) {
    const profile = await getProfile(token);
    await backfill(db, tenantId, account, internalDomain);
    await db.execute(sql`
      UPDATE gmail_account
      SET history_id = ${profile.historyId},
          last_synced_at = now(),
          sync_error_count = 0,
          sync_error = NULL,
          updated_at = now()
      WHERE id = ${account.id}
    `);
    return;
  }

  // Incremental: everything added since the cursor.
  const ids: string[] = [];
  let pageToken: string | undefined;
  let latestHistoryId = account.historyId;
  do {
    let page;
    try {
      page = await listHistory(token, account.historyId, pageToken);
    } catch (err) {
      // 404 = the cursor is older than Gmail's ~1 week of retained history
      // (an account that went quiet, or the API was down for a long spell).
      // The cursor can't be resumed, so re-seed it and backfill instead of
      // failing forever.
      if (httpStatusOf(err) === 404) {
        console.warn(`[gmail-worker] ${account.email}: history cursor expired, re-seeding`);
        const profile = await getProfile(token);
        await backfill(db, tenantId, account, internalDomain);
        await db.execute(sql`
          UPDATE gmail_account
          SET history_id = ${profile.historyId}, last_synced_at = now(),
              sync_error_count = 0, sync_error = NULL, updated_at = now()
          WHERE id = ${account.id}
        `);
        return;
      }
      throw err;
    }
    for (const h of page.history ?? []) {
      for (const added of h.messagesAdded ?? []) {
        ids.push(added.message.id);
      }
    }
    if (page.historyId) latestHistoryId = page.historyId;
    pageToken = page.nextPageToken;
  } while (pageToken);

  // De-dup within the page set — Gmail lists a message once per label change.
  let inserted = 0;
  for (const id of [...new Set(ids)]) {
    const res = await ingestGmailMessage(db, tenantId, account, id, internalDomain);
    if (res.status === "inserted") inserted++;
  }
  if (inserted > 0) {
    console.log(`[gmail-worker] ${account.email}: +${inserted} message(s)`);
  }

  await db.execute(sql`
    UPDATE gmail_account
    SET history_id = ${latestHistoryId},
        last_synced_at = now(),
        sync_error_count = 0,
        sync_error = NULL,
        updated_at = now()
    WHERE id = ${account.id}
  `);
}

/** Pull a recent window of mail on first connect (or after a cursor expiry). */
async function backfill(
  db: DbExec,
  tenantId: string,
  account: GmailAccountRow,
  internalDomain: string,
): Promise<void> {
  const token = await accessTokenFor(db, account);
  let pageToken: string | undefined;
  let seen = 0;
  let inserted = 0;
  do {
    const page = await listMessages(token, BACKFILL_QUERY, 50, pageToken);
    for (const m of page.messages ?? []) {
      if (seen >= BACKFILL_MAX) break;
      seen++;
      const res = await ingestGmailMessage(db, tenantId, account, m.id, internalDomain);
      if (res.status === "inserted") inserted++;
    }
    pageToken = seen >= BACKFILL_MAX ? undefined : page.nextPageToken;
  } while (pageToken);
  console.log(
    `[gmail-worker] ${account.email}: backfill scanned ${seen} (cap ${BACKFILL_MAX}), imported ${inserted}`,
  );
}

/**
 * Note the failure on the account row. A dead refresh token (invalid_grant —
 * user revoked us in their Google settings, or changed their password) is
 * terminal, so mark it revoked immediately rather than burning through the
 * error budget one tick at a time. The UI then shows "Reconnect Gmail".
 */
async function recordSyncError(tenantId: string, account: GmailAccountRow, err: unknown): Promise<void> {
  const message = (err as Error).message.slice(0, 500);
  const dead = isInvalidGrant(err) || httpStatusOf(err) === 401;
  console.error(`[gmail-worker] ${account.email}: ${message}${dead ? " (revoking)" : ""}`);
  try {
    await withTenant(tenantId, async (db) => {
      await db.execute(sql`
        UPDATE gmail_account
        SET sync_error_count = sync_error_count + 1,
            sync_error       = ${message},
            revoked_at       = ${dead ? sql`now()` : sql`revoked_at`},
            updated_at       = now()
        WHERE id = ${account.id}
      `);
    });
  } catch (e) {
    console.error("[gmail-worker] failed to record sync error:", (e as Error).message);
  }
}
