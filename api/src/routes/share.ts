// User-facing "Share to Slack" endpoints.
//
// Mounted at /share — gated per-handler by the surface's read permission
// (anyone who can view the record can share it). The admin-side CRUD for
// share targets lives in routes/integrations.ts under /integrations/slack/share-targets.
//
//   GET  /share/slack/preview/:surface/:recordId   → render preview
//   POST /share/slack/:surface/:recordId           → actually post to Slack

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { postToSlack } from "../lib/slack.js";
import { fetchShareRecord, isShareSurface, renderShare, type ShareSurface } from "../lib/share.js";
import { loadShareTarget } from "./integrations.js";
import type { Permission } from "../lib/permissions.js";
import { requirePermission } from "../middleware/require.js";

export const shareRouter = Router();

// Map each surface to the read perm required to view (and therefore share)
// records of that kind.
const SURFACE_READ_PERM: Record<ShareSurface, Permission> = {
  leads:    "leads.read",
  learners: "learners.read",
  cases:    "cases.read",
};

function gateBySurface(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) {
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
// Body: { notes?: string }
// Pulls fresh data + target config (so a stale preview doesn't smuggle in
// dropped fields), renders, posts, logs the attempt.
shareRouter.post("/slack/:surface/:recordId", gateBySurface, async (req, res, next) => {
  try {
    const surface = req.params.surface as ShareSurface;
    const recordId = String(req.params.recordId ?? "");
    const notes = req.body?.notes != null ? String(req.body.notes).slice(0, 4000) : null;

    const target = await loadShareTarget(req.tenantId!, surface);
    if (!target || !target.enabled) return res.status(409).json({ error: `Slack sharing is not configured for ${surface}.` });
    if (!target.webhookUrl)         return res.status(409).json({ error: `Slack sharing is missing a webhook URL for ${surface}.` });

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

    const result = await postToSlack(target.webhookUrl, payload);

    // Log to the same delivery_log used by automated rules. event_type is a
    // synthetic "share.<surface>" so admins can tell shares from automated
    // posts in the recent-activity panel.
    await withTenant(req.tenantId!, async (db) => {
      await db.execute(sql`
        INSERT INTO slack_delivery_log (tenant_id, rule_id, event_type, status, http_status, response, context)
        VALUES (
          current_tenant(), NULL,
          ${`share.${surface}`},
          ${result.ok ? "ok" : "error"},
          ${result.httpStatus}, ${result.response},
          ${JSON.stringify({ surface, recordId, sharedBy: sharedByName, notes })}::jsonb
        )
      `);
    });

    if (!result.ok) {
      return res.status(502).json({ error: `Slack rejected the message (HTTP ${result.httpStatus}). ${result.response}` });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

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
