// Phase 4 Party Model — consent endpoints.
//
// Mounted at /party. Routes carry the partyId in their own path pattern so
// each handler owns its params (no mergeParams needed).

import { Router } from "@/server/http";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";
import { setConsent, type Channel } from "../lib/party/consent";
import { resolveActorPartyId } from "../lib/party/resolve";

export const partyConsentRouter = Router();

const CHANNELS: readonly Channel[] = ["whatsapp", "email", "sms", "calls"] as const;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// GET /party/:partyId/consent — current + historical consent rows.
partyConsentRouter.get("/:partyId/consent", async (req, res, next) => {
  try {
    const partyId = String(req.params.partyId ?? "");
    if (!UUID_RE.test(partyId)) return res.status(400).json({ error: "invalid partyId" });
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT id, channel, opt_in AS "optIn", source, evidence_url AS "evidenceUrl",
               valid_from AS "validFrom", valid_to AS "validTo",
               created_at AS "createdAt", updated_at AS "updatedAt"
        FROM party_consent
        WHERE party_id = ${partyId}
        ORDER BY channel, valid_from DESC
      `);
      return r.rows;
    });
    res.json({ consent: rows });
  } catch (err) { next(err); }
});

// PUT /party/:partyId/consent/:channel — set or update consent.
// Body: { optIn: boolean, source: string, evidenceUrl?: string }.
partyConsentRouter.put("/:partyId/consent/:channel", async (req, res, next) => {
  try {
    const partyId = String(req.params.partyId ?? "");
    const channel = String(req.params.channel ?? "") as Channel;
    if (!UUID_RE.test(partyId)) return res.status(400).json({ error: "invalid partyId" });
    if (!CHANNELS.includes(channel)) {
      return res.status(400).json({ error: `channel must be one of ${CHANNELS.join(", ")}` });
    }
    const b = req.body ?? {};
    if (typeof b.optIn !== "boolean") return res.status(400).json({ error: "optIn boolean required" });
    const source = String(b.source ?? "").trim();
    if (!source) return res.status(400).json({ error: "source required (e.g. 'signup' or 'unsubscribe')" });
    const evidenceUrl = b.evidenceUrl ? String(b.evidenceUrl).trim() : null;

    await withTenant(req.tenantId!, async (db) => {
      // Verify the party exists and belongs to this tenant.
      const check = await db.execute(sql`SELECT 1 FROM party WHERE id = ${partyId}`);
      if (!check.rows[0]) return; // RLS filters; treat as 404 below.
      await setConsent(db, partyId, channel, b.optIn, source, evidenceUrl);
      // Activity row so the party's timeline shows the change.
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      await db.execute(sql`
        INSERT INTO activity (
          tenant_id, party_id, actor_type, actor_party_id, actor_name,
          verb, detail, tag, payload, ts
        ) VALUES (
          current_tenant(), ${partyId}, 'user', ${actorPartyId},
          ${req.user?.name ?? "You"},
          ${b.optIn ? "Consent granted" : "Consent withdrawn"},
          ${`${channel}: ${b.optIn ? "opt-in" : "opt-out"} (source: ${source})`},
          'you',
          ${sql`${JSON.stringify({ channel, optIn: b.optIn, source, evidenceUrl })}::jsonb`},
          NOW()
        )
      `);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
