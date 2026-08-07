// User-facing "Share to Slack" endpoints.
//
// Mounted at /share — gated per-handler by the surface's read permission
// (anyone who can view the record can share it). The admin-side CRUD for
// share targets lives in routes/integrations.ts under /integrations/slack/share-targets.
//
//   GET  /share/slack/preview/:surface/:recordId   → render preview
//   POST /share/slack/:surface/:recordId           → actually post to Slack

import { Router } from "@/server/http";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";
import { postToSlack } from "../lib/slack";
import { postToDestination, SlackError } from "../lib/slack-api";
import { fetchShareRecord, isShareSurface, renderShare, type ShareSurface } from "../lib/share";
import { loadBotToken, loadShareTarget, loadUserToken } from "./integrations";
import type { Permission } from "../lib/permissions";
import { requirePermission } from "../middleware/require";

export const shareRouter = Router();

// Map each surface to the read perm required to view (and therefore share)
// records of that kind.
const SURFACE_READ_PERM: Record<ShareSurface, Permission> = {
  leads:    "leads.read",
  learners: "learners.read",
  cases:    "cases.read",
};

function gateBySurface(req: import("@/server/http").ApiRequest, res: import("@/server/http").ApiResponse, next: import("@/server/http").NextFunction) {
  const surface = String(req.params.surface ?? "");
  if (!isShareSurface(surface)) return res.status(400).json({ error: "unsupported surface" });
  const perm = SURFACE_READ_PERM[surface];
  return requirePermission(perm)(req, res, next);
}

// ─── GET /share/slack/preview/:surface/:recordId ─────────────────────────
//
// Returns enough info for the dialog to show the user exactly what will be
// sent: target metadata, the rendered Block Kit payload, and the field set.
// Doesn't post anything.
shareRouter.get("/slack/preview/:surface/:recordId", gateBySurface, async (req, res, next) => {
  try {
    const surface = req.params.surface as ShareSurface;
    const recordId = String(req.params.recordId ?? "");

    const target = await loadShareTarget(req.tenantId!, surface);
    if (!target || !target.enabled) {
      return res.status(409).json({ error: `Slack sharing is not configured for ${surface}. Ask an admin to set it up under Admin → Integrations.` });
    }
    if (!target.webhookUrl) {
      return res.status(409).json({ error: `Slack sharing is missing a webhook URL for ${surface}.` });
    }

    const record = await fetchShareRecord(surface, req.tenantId!, recordId);
    if (!record) return res.status(404).json({ error: "Record not found" });

    const sharedByName = await withTenant(req.tenantId!, async (db) => {
      if (!req.userId) return null;
      const u = await db.execute(sql`SELECT name FROM app_user WHERE id = ${req.userId}`);
      return (u.rows[0] as { name: string } | undefined)?.name ?? null;
    });

    const payload = renderShare({
      surface,
      record,
      fieldKeys: target.fieldKeys,
      headerTemplate: target.headerTemplate,
      notes: null, // preview shows the body without notes; user types them in the dialog
      sharedByName,
    });

    res.json({
      target: {
        surface, channel: target.channel, fieldKeys: target.fieldKeys,
      },
      preview: payload,
      record: pickPreviewFields(record),
    });
  } catch (err) { next(err); }
});

// ─── POST /share/slack/:surface/:recordId ────────────────────────────────
//
// Body: {
//   notes?: string,
//   destination?: { kind: "channel"|"user", id: string, name?: string }
// }
//
// When `destination` is present we post via the bot token (chat.postMessage)
// to that specific channel or DM. When absent, we fall back to the legacy
// webhook target for the surface — keeps old admin config working during
// rollout.
//
// Pulls fresh data + surface config (so a stale preview doesn't smuggle
// in dropped fields), renders, posts, logs the attempt.
shareRouter.post("/slack/:surface/:recordId", gateBySurface, async (req, res, next) => {
  try {
    const surface = req.params.surface as ShareSurface;
    const recordId = String(req.params.recordId ?? "");
    const notes = req.body?.notes != null ? String(req.body.notes).slice(0, 4000) : null;
    const destRaw = req.body?.destination;
    const destination = parseDestination(destRaw);
    if (destRaw && !destination) {
      return res.status(400).json({ error: "destination must be { kind: 'channel'|'user', id: string }" });
    }

    const target = await loadShareTarget(req.tenantId!, surface);
    if (!target || !target.enabled) return res.status(409).json({ error: `Slack sharing is not configured for ${surface}.` });

    const record = await fetchShareRecord(surface, req.tenantId!, recordId);
    if (!record) return res.status(404).json({ error: "Record not found" });

    const sharedByName = await withTenant(req.tenantId!, async (db) => {
      if (!req.userId) return null;
      const u = await db.execute(sql`SELECT name FROM app_user WHERE id = ${req.userId}`);
      return (u.rows[0] as { name: string } | undefined)?.name ?? null;
    });

    const payload = renderShare({
      surface,
      record,
      fieldKeys: target.fieldKeys,
      headerTemplate: target.headerTemplate,
      notes,
      sharedByName,
    });

    // Dispatch precedence:
    //   1. destination + current user has "Connect Slack"  → user token (xoxp-)
    //   2. destination + no user link                       → bot token  (xoxb-)
    //   3. no destination                                   → legacy webhook
    //
    // Case 1 is the ideal path — posts appear as the actual person.
    let mode: "user" | "bot" | "webhook";
    let deliveryStatus: "ok" | "error";
    let httpStatus: number | null;
    let response: string;
    let deliveryDestination: Record<string, unknown> = {};
    if (destination) {
      const userLink = req.userId ? await loadUserToken(req.tenantId!, req.userId) : null;
      const token = userLink?.token ?? await loadBotToken(req.tenantId!);
      mode = userLink ? "user" : "bot";
      if (!token) {
        return res.status(409).json({ error: "Slack is not configured. Ask an admin to connect a bot workspace, or click Connect Slack on the record page." });
      }
      try {
        const r = await postToDestination(token, destination, payload);
        deliveryStatus = "ok"; httpStatus = 200; response = `ok (ts=${r.ts})`;
        deliveryDestination = { kind: destination.kind, id: destination.id, name: destRaw?.name ?? null, as: mode };
      } catch (err) {
        if (err instanceof SlackError) {
          deliveryStatus = "error"; httpStatus = err.httpStatus;
          response = `${err.slackErrorCode}: ${err.message}`;
          deliveryDestination = { kind: destination.kind, id: destination.id, name: destRaw?.name ?? null, as: mode };
        } else throw err;
      }
    } else {
      mode = "webhook";
      if (!target.webhookUrl) {
        return res.status(409).json({ error: `Slack sharing has no webhook URL for ${surface} and no destination was picked.` });
      }
      const result = await postToSlack(target.webhookUrl, payload);
      deliveryStatus = result.ok ? "ok" : "error";
      httpStatus = result.httpStatus;
      response = result.response;
      deliveryDestination = { kind: "webhook", channel: target.channel };
    }

    // Log to the same delivery_log used by automated rules. event_type is a
    // synthetic "share.<surface>" so admins can tell shares from automated
    // posts in the recent-activity panel. Include mode + destination in
    // the context payload so admins can see WHERE it went.
    await withTenant(req.tenantId!, async (db) => {
      await db.execute(sql`
        INSERT INTO slack_delivery_log (tenant_id, rule_id, event_type, status, http_status, response, context)
        VALUES (
          current_tenant(), NULL,
          ${`share.${surface}`},
          ${deliveryStatus},
          ${httpStatus}, ${response},
          ${JSON.stringify({ surface, recordId, sharedBy: sharedByName, notes, mode, destination: deliveryDestination })}::jsonb
        )
      `);
    });

    if (deliveryStatus !== "ok") {
      return res.status(502).json({ error: `Slack rejected the message: ${response}` });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Best-effort parse of the destination object off the request body.
// Returns null for malformed input; caller emits a 400.
function parseDestination(raw: unknown): { kind: "channel" | "user"; id: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { kind?: unknown; id?: unknown };
  if (r.kind !== "channel" && r.kind !== "user") return null;
  if (typeof r.id !== "string" || !r.id.trim()) return null;
  return { kind: r.kind, id: r.id.trim() };
}

// Trim the record we send back to the client to just the fields we render —
// the dialog doesn't need the full row, and some fields (description) are
// long enough to be wasteful.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickPreviewFields(record: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string" && v.length > 200) {
      out[k] = v.slice(0, 200) + "…";
    } else {
      out[k] = v;
    }
  }
  return out;
}
