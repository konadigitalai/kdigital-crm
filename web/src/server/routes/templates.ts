// WhatsApp templates route — cache Twilio Content Builder templates locally
// and expose them to the CRM.
//
// Mounted at /templates behind authMiddleware (see api/src/index.ts).
//
// Design notes:
//   - We keep wa_template as a read-through cache (see post-0068). Twilio is
//     the source of truth. Every list-request refreshes the cache if the
//     newest row is older than STALE_MS; force-refresh is exposed via
//     POST /templates/sync.
//   - Approval status is fetched separately per template because Twilio's
//     /Content endpoint doesn't include it. We only refresh approvals for
//     templates that aren't `approved` yet, or that are stale.
//   - RLS handles the per-tenant scoping — no explicit tenant filter here.

import { Router } from "@/server/http";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";
import { requirePermission } from "../middleware/require";
import {
  listTemplates as twListTemplates,
  fetchTemplate as twFetchTemplate,
  fetchApproval as twFetchApproval,
  createTemplate as twCreateTemplate,
  submitForApproval as twSubmitForApproval,
  extractVariableNames,
  type TwilioTemplate,
  type TwilioApproval,
} from "../lib/twilio/templates";
import { TwilioNotConfigured } from "../lib/twilio/client";
import type { DbExec } from "../lib/twilio/inbox";

export const templatesRouter = Router();

const STALE_MS = 60 * 60 * 1000;         // 1 hour — after which /templates re-syncs on read
const APPROVAL_REFRESH_MS = 15 * 60_000;  // 15 min — pending templates polled this often

// ─── Sync helpers ─────────────────────────────────────────────────────────

/** Upsert a Twilio template into wa_template. */
async function upsertTemplate(
  db: DbExec,
  t: TwilioTemplate,
  approval: TwilioApproval | null,
): Promise<void> {
  // Twilio's approval enum → our approval_status column.
  const status = approval
    ? mapApprovalStatus(approval.status)
    : "unknown";
  const note = approval?.rejectionReason ?? null;
  const variables = extractVariableNames(t);

  await db.execute(sql`
    INSERT INTO wa_template (
      tenant_id, content_sid, friendly_name, language, category,
      variables, types, approval_status, approval_note, synced_at
    )
    VALUES (
      current_tenant(), ${t.sid}, ${t.friendlyName}, ${t.language},
      ${approval?.category || null},
      ${JSON.stringify({ names: variables, samples: t.variables })}::jsonb,
      ${JSON.stringify(t.types)}::jsonb,
      ${status}, ${note}, now()
    )
    ON CONFLICT (tenant_id, content_sid) DO UPDATE SET
      friendly_name   = EXCLUDED.friendly_name,
      language        = EXCLUDED.language,
      category        = EXCLUDED.category,
      variables       = EXCLUDED.variables,
      types           = EXCLUDED.types,
      approval_status = EXCLUDED.approval_status,
      approval_note   = EXCLUDED.approval_note,
      synced_at       = now()
  `);
}

function mapApprovalStatus(twilioStatus: string): string {
  switch (twilioStatus) {
    case "unsubmitted": return "draft";
    case "submitted":   return "pending";
    case "approved":    return "approved";
    case "rejected":    return "rejected";
    case "paused":      return "paused";
    default:            return "unknown";
  }
}

/** Full sync from Twilio → wa_template. */
async function syncAllTemplates(
  db: DbExec,
): Promise<{ count: number; errors: number }> {
  let count = 0;
  let errors = 0;
  const list = await twListTemplates();
  for (const t of list) {
    try {
      const approval = await twFetchApproval(t.sid).catch(() => null);
      await upsertTemplate(db, t, approval);
      count++;
    } catch (e) {
      errors++;
      console.error("[templates.sync] failed", t.sid, (e as Error).message);
    }
  }
  return { count, errors };
}

/** Determine if we need to hit Twilio for a fresh list — if the newest
 *  cached template is older than STALE_MS, resync. */
async function isCacheStale(db: DbExec): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT MAX(synced_at)::text AS "maxSynced" FROM wa_template
  `);
  const maxSynced = (r.rows[0] as { maxSynced?: string | null } | undefined)?.maxSynced ?? null;
  if (!maxSynced) return true;
  return Date.now() - new Date(maxSynced).getTime() > STALE_MS;
}

// ─── GET /templates ───────────────────────────────────────────────────────
// Returns the cached list, syncing from Twilio first if stale.
// Query: ?refresh=1 forces a resync. ?status=approved filters to approved only.

templatesRouter.get("/", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const forceRefresh = String(req.query.refresh ?? "") === "1";
    const statusFilter = String(req.query.status ?? "").trim();

    const rows = await withTenant(req.tenantId!, async (db) => {
      if (forceRefresh || await isCacheStale(db)) {
        try {
          await syncAllTemplates(db);
        } catch (e) {
          if (e instanceof TwilioNotConfigured) {
            // Fall through — serve whatever is cached.
            console.warn("[templates] sync skipped — Twilio not configured");
          } else {
            throw e;
          }
        }
      }
      const r = statusFilter
        ? await db.execute(sql`
            SELECT id, content_sid AS "contentSid", friendly_name AS "friendlyName",
                   language, category, variables, types,
                   approval_status AS "approvalStatus", approval_note AS "approvalNote",
                   synced_at AS "syncedAt"
            FROM wa_template
            WHERE approval_status = ${statusFilter}
            ORDER BY approval_status = 'approved' DESC, friendly_name ASC
          `)
        : await db.execute(sql`
            SELECT id, content_sid AS "contentSid", friendly_name AS "friendlyName",
                   language, category, variables, types,
                   approval_status AS "approvalStatus", approval_note AS "approvalNote",
                   synced_at AS "syncedAt"
            FROM wa_template
            ORDER BY approval_status = 'approved' DESC, friendly_name ASC
          `);
      return r.rows;
    });
    res.json({ templates: rows });
  } catch (err) { next(err); }
});

// ─── POST /templates/sync ─────────────────────────────────────────────────
// Force a resync from Twilio. Also refreshes approval status for every
// non-approved / non-rejected template.

templatesRouter.post("/sync", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const summary = await withTenant(req.tenantId!, async (db) => {
      return syncAllTemplates(db);
    });
    res.json({ ok: true, ...summary });
  } catch (err) {
    if (err instanceof TwilioNotConfigured) {
      return res.status(503).json({ error: err.message });
    }
    next(err);
  }
});

// ─── GET /templates/:contentSid ───────────────────────────────────────────
// One template, refreshed from Twilio if stale or approval is still pending.

templatesRouter.get("/:contentSid", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const sid = String(req.params.contentSid ?? "");
    if (!sid) return res.status(400).json({ error: "contentSid is required" });
    const row = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT id, content_sid AS "contentSid", friendly_name AS "friendlyName",
               language, category, variables, types,
               approval_status AS "approvalStatus", approval_note AS "approvalNote",
               synced_at AS "syncedAt"
        FROM wa_template
        WHERE content_sid = ${sid}
        LIMIT 1
      `);
      let existing = r.rows[0] as Record<string, unknown> | undefined;

      const shouldRefresh = !existing
        || Date.now() - new Date(String(existing.syncedAt)).getTime() > STALE_MS
        || (existing.approvalStatus === "pending"
            && Date.now() - new Date(String(existing.syncedAt)).getTime() > APPROVAL_REFRESH_MS);

      if (shouldRefresh) {
        try {
          const fresh = await twFetchTemplate(sid);
          if (fresh) {
            const approval = await twFetchApproval(sid).catch(() => null);
            await upsertTemplate(db, fresh, approval);
            const r2 = await db.execute(sql`
              SELECT id, content_sid AS "contentSid", friendly_name AS "friendlyName",
                     language, category, variables, types,
                     approval_status AS "approvalStatus", approval_note AS "approvalNote",
                     synced_at AS "syncedAt"
              FROM wa_template
              WHERE content_sid = ${sid}
              LIMIT 1
            `);
            existing = r2.rows[0] as Record<string, unknown>;
          }
        } catch (e) {
          if (!(e instanceof TwilioNotConfigured)) throw e;
          // No Twilio config — serve whatever's cached (or return 404).
        }
      }

      return existing ?? null;
    });
    if (!row) return res.status(404).json({ error: "template not found" });
    res.json({ template: row });
  } catch (err) { next(err); }
});

// ─── POST /templates (draft on Twilio + cache locally) ────────────────────
// Body: { friendlyName, language, types, variables? }
//
// This creates a template on Twilio's Content Builder (draft state) and
// stores it locally with approval_status='draft'. To go live, follow up with
// POST /templates/:sid/submit which sends it to Meta for approval.

templatesRouter.post("/", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const b = req.body as {
      friendlyName?: string;
      language?: string;
      types?: Record<string, unknown>;
      variables?: Record<string, string>;
    };
    const friendlyName = String(b.friendlyName ?? "").trim();
    const language = String(b.language ?? "en").trim();
    if (!friendlyName) return res.status(400).json({ error: "friendlyName is required" });
    if (!b.types || typeof b.types !== "object" || Object.keys(b.types).length === 0) {
      return res.status(400).json({ error: "types is required (at least one Twilio content-type block)" });
    }

    let created;
    try {
      created = await twCreateTemplate({
        friendly_name: friendlyName,
        language,
        types: b.types,
        variables: b.variables ?? {},
      });
    } catch (e) {
      if (e instanceof TwilioNotConfigured) return res.status(503).json({ error: e.message });
      return res.status(502).json({ error: (e as Error).message });
    }

    // Cache locally as draft. Meta approval status defaults to unsubmitted.
    const row = await withTenant(req.tenantId!, async (db) => {
      await upsertTemplate(db, created!, null);
      const r = await db.execute(sql`
        SELECT id, content_sid AS "contentSid", friendly_name AS "friendlyName",
               language, category, variables, types,
               approval_status AS "approvalStatus", approval_note AS "approvalNote",
               synced_at AS "syncedAt"
        FROM wa_template WHERE content_sid = ${created!.sid} LIMIT 1
      `);
      return r.rows[0];
    });
    res.json({ template: row });
  } catch (err) { next(err); }
});

// ─── POST /templates/:sid/submit ──────────────────────────────────────────
// Body: { category: "MARKETING" | "UTILITY" | "AUTHENTICATION", name: string }
//
// Sends the template to Meta for approval. The FE should poll GET
// /templates/:sid every few minutes to observe status changes.

templatesRouter.post("/:contentSid/submit", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const sid = String(req.params.contentSid ?? "");
    if (!sid) return res.status(400).json({ error: "contentSid is required" });
    const b = req.body as { category?: string; name?: string };
    const rawCategory = String(b.category ?? "").toUpperCase();
    if (!["MARKETING","UTILITY","AUTHENTICATION"].includes(rawCategory)) {
      return res.status(400).json({ error: "category must be MARKETING, UTILITY, or AUTHENTICATION" });
    }
    const category = rawCategory as "MARKETING" | "UTILITY" | "AUTHENTICATION";
    const name = String(b.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "name is required (shown to end users in WhatsApp)" });

    let approval: TwilioApproval;
    try {
      approval = await twSubmitForApproval(sid, category, name);
    } catch (e) {
      if (e instanceof TwilioNotConfigured) return res.status(503).json({ error: e.message });
      return res.status(502).json({ error: (e as Error).message });
    }

    // Reflect on our cache immediately — the FE shouldn't have to wait
    // for the next stale-read to see status change to `pending`.
    const row = await withTenant(req.tenantId!, async (db) => {
      const fresh = await twFetchTemplate(sid);
      if (fresh) await upsertTemplate(db, fresh, approval);
      const r = await db.execute(sql`
        SELECT id, content_sid AS "contentSid", friendly_name AS "friendlyName",
               language, category, variables, types,
               approval_status AS "approvalStatus", approval_note AS "approvalNote",
               synced_at AS "syncedAt"
        FROM wa_template WHERE content_sid = ${sid} LIMIT 1
      `);
      return r.rows[0];
    });
    res.json({ template: row, approval });
  } catch (err) { next(err); }
});
