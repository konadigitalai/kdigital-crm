// Phase 4 Party Model — dedup endpoints.
//
//   POST /parties/duplicates/scan           run the scanner now (on-demand)
//   GET  /parties/duplicates                list pending candidates
//   POST /parties/duplicates/:id/dismiss    reject a candidate
//   POST /parties/merge                     merge a pair
//
// Permissions: for now, gate at the auth-middleware level (admins only).
// A dedicated `parties.dedup.run` Auth0 permission is deferred.

import { Router } from "@/server/http";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";
import { scanForDuplicates, mergeParties } from "../lib/party/dedup";
import { partyIdFromAppUserId, resolveActorPartyId } from "../lib/party/resolve";

export const partiesRouter = Router();

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// POST /parties/duplicates/scan — run the scanner now. Returns a summary.
partiesRouter.post("/duplicates/scan", async (req, res, next) => {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "admin only" });
    }
    const summary = await withTenant(req.tenantId!, (db) =>
      scanForDuplicates(db, req.tenantId!));
    res.json({ ok: true, ...summary });
  } catch (err) { next(err); }
});

// GET /parties/duplicates?status=pending&ruleKind=exact_email
partiesRouter.get("/duplicates", async (req, res, next) => {
  try {
    const status = String(req.query.status ?? "pending");
    const ruleKind = req.query.ruleKind ? String(req.query.ruleKind) : null;
    if (!["pending","confirmed","dismissed","merged"].includes(status)) {
      return res.status(400).json({ error: "invalid status" });
    }
    const rows = await withTenant(req.tenantId!, async (db) => {
      const kindFilter = ruleKind ? sql`AND mr.kind = ${ruleKind}` : sql``;
      const r = await db.execute(sql`
        SELECT
          c.id, c.status, c.score, c.evidence, c.detected_at AS "detectedAt",
          c.party_a_id AS "partyAId", pa.name AS "partyAName", pa.email AS "partyAEmail",
          c.party_b_id AS "partyBId", pb.name AS "partyBName", pb.email AS "partyBEmail",
          mr.name AS "ruleName", mr.kind AS "ruleKind"
        FROM party_duplicate_candidate c
        JOIN party pa ON pa.id = c.party_a_id
        JOIN party pb ON pb.id = c.party_b_id
        LEFT JOIN party_match_rule mr ON mr.id = c.matched_by_rule_id
        WHERE c.status = ${status}
          ${kindFilter}
        ORDER BY c.detected_at DESC
        LIMIT 500
      `);
      return r.rows;
    });
    res.json({ candidates: rows });
  } catch (err) { next(err); }
});

// POST /parties/duplicates/:id/dismiss
partiesRouter.post("/duplicates/:id/dismiss", async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "invalid id" });
    await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = req.userId
        ? await partyIdFromAppUserId(db, req.userId) : null;
      await db.execute(sql`
        UPDATE party_duplicate_candidate
        SET status = 'dismissed', resolved_at = NOW(), resolved_by_party_id = ${actorPartyId}
        WHERE id = ${id} AND status = 'pending'
      `);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /parties/merge — body { winnerId, loserId, candidateId?, note? }
partiesRouter.post("/merge", async (req, res, next) => {
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "admin only" });
    }
    const b = req.body ?? {};
    const winnerId = String(b.winnerId ?? "");
    const loserId  = String(b.loserId  ?? "");
    const note     = b.note ? String(b.note) : null;
    if (!UUID_RE.test(winnerId) || !UUID_RE.test(loserId)) {
      return res.status(400).json({ error: "winnerId and loserId must be UUIDs" });
    }
    if (winnerId === loserId) return res.status(400).json({ error: "winner and loser must differ" });

    const result = await withTenant(req.tenantId!, async (db) => {
      const mergedByPartyId = req.userId
        ? await partyIdFromAppUserId(db, req.userId) : null;
      try {
        const r = await mergeParties(db, req.tenantId!, winnerId, loserId, mergedByPartyId, note);
        // Attribute the merge on the winner's timeline.
        const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
        await db.execute(sql`
          INSERT INTO activity (
            tenant_id, party_id, actor_type, actor_party_id, actor_name,
            verb, detail, tag, payload, ts
          ) VALUES (
            current_tenant(), ${winnerId}, 'user', ${actorPartyId},
            ${req.user?.name ?? "You"},
            'Party merged', ${`Merged party ${loserId} into this record.`}, 'you',
            ${sql`${JSON.stringify({ loserId, mergeLogId: r.logId, reparented: r.reparented })}::jsonb`},
            NOW()
          )
        `);
        return { kind: "ok" as const, ...r };
      } catch (err) {
        return { kind: "error" as const, message: (err as Error).message };
      }
    });
    if (result.kind === "error") return res.status(400).json({ error: result.message });
    res.json({ ok: true, logId: result.logId, reparented: result.reparented });
  } catch (err) { next(err); }
});
