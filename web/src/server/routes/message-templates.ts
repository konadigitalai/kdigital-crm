// Saved messages (canned responses) for the inbox composer.
//
// Text only — stored in Postgres, not Vercel Blob (files are binary; a canned
// reply is a title + a short body, and the picker wants to search it). See
// post-0075-message-template.sql.
//
// Mounted at /message-templates. GET needs messaging.read; writes need
// messaging.send — if you can send a message you can manage the saved ones.

import { Router } from "@/server/http";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";
import { requirePermission } from "../middleware/require";
import { resolveActorPartyId } from "../lib/party/resolve";

export const messageTemplatesRouter = Router();

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

function validate(title: unknown, body: unknown): { title: string; body: string } | { error: string } {
  const t = String(title ?? "").trim();
  const b = String(body ?? "").trim();
  if (!t) return { error: "title is required" };
  if (t.length > 120) return { error: "title is too long (max 120)" };
  if (!b) return { error: "body is required" };
  if (b.length > 4000) return { error: "body is too long (max 4000)" };
  return { title: t, body: b };
}

// ─── GET /message-templates ──────────────────────────────────────────────
messageTemplatesRouter.get("/", requirePermission("messaging.read"), async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT id, title, body,
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM message_template
        ORDER BY lower(title) ASC
      `);
      return r.rows;
    });
    return res.json({ templates: rows });
  } catch (err) { next(err); }
});

// ─── POST /message-templates ─────────────────────────────────────────────
messageTemplatesRouter.post("/", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const v = validate(req.body?.title, req.body?.body);
    if ("error" in v) return res.status(400).json({ error: v.error });

    const out = await withTenant(req.tenantId!, async (db) => {
      const actor = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const r = await db.execute(sql`
        INSERT INTO message_template (tenant_id, title, body, created_by_party_id)
        VALUES (current_tenant(), ${v.title}, ${v.body}, ${actor})
        RETURNING id, title, body, created_at AS "createdAt", updated_at AS "updatedAt"
      `);
      return r.rows[0];
    });
    return res.status(201).json({ ok: true, template: out });
  } catch (err) { next(err); }
});

// ─── PATCH /message-templates/:id ────────────────────────────────────────
messageTemplatesRouter.patch("/:id", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "invalid id" });
    const v = validate(req.body?.title, req.body?.body);
    if ("error" in v) return res.status(400).json({ error: v.error });

    const out = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        UPDATE message_template
        SET title = ${v.title}, body = ${v.body}, updated_at = now()
        WHERE id = ${id}
        RETURNING id, title, body, created_at AS "createdAt", updated_at AS "updatedAt"
      `);
      return r.rows[0] ?? null;
    });
    if (!out) return res.status(404).json({ error: "Template not found" });
    return res.json({ ok: true, template: out });
  } catch (err) { next(err); }
});

// ─── DELETE /message-templates/:id ───────────────────────────────────────
messageTemplatesRouter.delete("/:id", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "invalid id" });
    const gone = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`DELETE FROM message_template WHERE id = ${id} RETURNING id`);
      return r.rows.length > 0;
    });
    if (!gone) return res.status(404).json({ error: "Template not found" });
    return res.json({ ok: true });
  } catch (err) { next(err); }
});
