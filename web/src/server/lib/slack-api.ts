// Thin wrapper over Slack's Web API. Everything hits https://slack.com/api/*
// with a bot token in the Authorization header and a JSON body. We don't
// use @slack/web-api because we only need four calls and don't want the
// transitive weight.
//
// Every response has { ok: true, … } or { ok: false, error: "…" }. This
// module normalises errors into a single Error type so callers can
// try/catch cleanly.
//
// Rate-limiting note: Slack returns HTTP 429 with a Retry-After header.
// We surface that as SlackRateLimitedError and let the caller decide
// whether to retry.

import type { SlackPayload } from "./slack";

const SLACK_API = "https://slack.com/api";

export class SlackError extends Error {
  slackErrorCode: string;
  httpStatus: number;
  constructor(code: string, httpStatus: number, message?: string) {
    super(message ?? `Slack error: ${code}`);
    this.slackErrorCode = code;
    this.httpStatus = httpStatus;
  }
}

export class SlackRateLimitedError extends SlackError {
  retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super("ratelimited", 429, `Slack rate-limited; retry after ${retryAfterSec}s`);
    this.retryAfterSec = retryAfterSec;
  }
}

// ─── Core request helper ───────────────────────────────────────────────

interface SlackOk<T> { ok: true; data: T; }
type SlackApiResponse = Record<string, unknown> & { ok: boolean; error?: string };

async function callSlack<T = Record<string, unknown>>(
  method: string,
  botToken: string,
  body: Record<string, unknown> | null,
  opts: { signal?: AbortSignal } = {},
): Promise<SlackOk<T>> {
  const isGet = body === null;
  const url = isGet ? `${SLACK_API}/${method}` : `${SLACK_API}/${method}`;
  const r = await fetch(url, {
    method: isGet ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      ...(isGet ? {} : { "Content-Type": "application/json; charset=utf-8" }),
    },
    body: isGet ? undefined : JSON.stringify(body ?? {}),
    signal: opts.signal,
  });

  if (r.status === 429) {
    const retryAfter = Number(r.headers.get("retry-after") ?? "30");
    throw new SlackRateLimitedError(Number.isFinite(retryAfter) ? retryAfter : 30);
  }

  let payload: SlackApiResponse;
  try {
    payload = (await r.json()) as SlackApiResponse;
  } catch {
    throw new SlackError("invalid_json", r.status, `Slack returned non-JSON (HTTP ${r.status})`);
  }

  if (!payload.ok) {
    throw new SlackError(payload.error ?? "unknown", r.status, `Slack ${method}: ${payload.error ?? "unknown"}`);
  }
  return { ok: true, data: payload as unknown as T };
}

// ─── conversations.list — cursor-paginated ─────────────────────────────

export interface SlackChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_archived: boolean;
  is_member: boolean;
  topic?: { value?: string };
}

// Pull every channel the bot can see. Public + private (needs both
// channels:read and groups:read). Uses cursor pagination — Slack returns
// up to 1000 per page. Practical Slack workspaces have <5000 channels.
export async function listAllChannels(botToken: string): Promise<SlackChannel[]> {
  const all: SlackChannel[] = [];
  let cursor = "";
  for (let i = 0; i < 50; i++) { // hard cap on pagination
    const qs = new URLSearchParams({
      types: "public_channel,private_channel",
      limit: "1000",
      exclude_archived: "true",
    });
    if (cursor) qs.set("cursor", cursor);
    const r = await callSlack<{
      channels: SlackChannel[];
      response_metadata?: { next_cursor?: string };
    }>(`conversations.list?${qs.toString()}`, botToken, null);
    all.push(...r.data.channels);
    cursor = r.data.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return all;
}

// ─── users.list — cursor-paginated ─────────────────────────────────────

export interface SlackUser {
  id: string;
  name: string;             // handle
  real_name?: string;
  is_bot?: boolean;
  deleted?: boolean;
  profile?: {
    real_name?: string;
    display_name?: string;
    email?: string;
    image_72?: string;
    image_192?: string;
  };
}

// Pull every user. Includes bots and deactivated users — filter downstream
// where we care. Slack pagination as above.
export async function listAllUsers(botToken: string): Promise<SlackUser[]> {
  const all: SlackUser[] = [];
  let cursor = "";
  for (let i = 0; i < 50; i++) {
    const qs = new URLSearchParams({ limit: "1000" });
    if (cursor) qs.set("cursor", cursor);
    const r = await callSlack<{
      members: SlackUser[];
      response_metadata?: { next_cursor?: string };
    }>(`users.list?${qs.toString()}`, botToken, null);
    all.push(...r.data.members);
    cursor = r.data.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return all;
}

// ─── conversations.open — get a DM channel id for a user ───────────────
//
// Slack DMs are just channels of type 'im'. To post one, you first call
// conversations.open with the user id, get back a channel id (starting
// with 'D…'), then chat.postMessage into that. We do it inline in
// postToDestination() below.
export async function openDm(botToken: string, userId: string): Promise<string> {
  const r = await callSlack<{ channel: { id: string } }>(
    "conversations.open", botToken, { users: userId },
  );
  return r.data.channel.id;
}

// ─── conversations.join — bot self-joins a public channel ──────────────
//
// Slack refuses chat.postMessage to a channel the bot isn't a member of.
// For public channels we can self-join. Silently succeeds if already in.
export async function joinChannel(botToken: string, channelId: string): Promise<void> {
  try {
    await callSlack("conversations.join", botToken, { channel: channelId });
  } catch (err) {
    // "method_not_supported_for_channel_type" for private channels — the
    // bot has to be invited by a human there. Re-throw with a clearer
    // message so the caller can surface it.
    if (err instanceof SlackError && err.slackErrorCode === "method_not_supported_for_channel_type") {
      throw new SlackError(
        "must_be_invited",
        err.httpStatus,
        "Slack rejected auto-join. Invite the bot to this channel via /invite @<bot> and try again.",
      );
    }
    throw err;
  }
}

// ─── chat.postMessage — the actual posting call ────────────────────────

export interface PostMessageResult {
  ok: true;
  channelId: string;
  ts: string;
}

// Post to a channel OR user. For users, opens a DM first. For channels,
// falls back to auto-join once on "not_in_channel" then retries.
export async function postToDestination(
  botToken: string,
  destination: { kind: "channel" | "user"; id: string },
  payload: SlackPayload,
): Promise<PostMessageResult> {
  const channelId = destination.kind === "user"
    ? await openDm(botToken, destination.id)
    : destination.id;

  const body = { channel: channelId, text: payload.text, blocks: payload.blocks };
  try {
    const r = await callSlack<{ channel: string; ts: string }>(
      "chat.postMessage", botToken, body,
    );
    return { ok: true, channelId: r.data.channel, ts: r.data.ts };
  } catch (err) {
    if (
      destination.kind === "channel"
      && err instanceof SlackError
      && err.slackErrorCode === "not_in_channel"
    ) {
      // Auto-join and retry — once.
      await joinChannel(botToken, channelId);
      const r = await callSlack<{ channel: string; ts: string }>(
        "chat.postMessage", botToken, body,
      );
      return { ok: true, channelId: r.data.channel, ts: r.data.ts };
    }
    throw err;
  }
}

// ─── auth.test — verify a bot token works ──────────────────────────────
//
// Cheapest way to confirm a token is live. Used by the admin's "Test
// connection" button and by the refresh endpoint before it burns any
// pagination budget.
export interface AuthTestResult { team: string; team_id: string; user: string; user_id: string; url: string }
export async function authTest(botToken: string): Promise<AuthTestResult> {
  const r = await callSlack<AuthTestResult>("auth.test", botToken, {});
  return r.data;
}
