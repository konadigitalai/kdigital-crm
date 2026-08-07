import { Router } from "@/server/http";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app";
import { requirePermission } from "../middleware/require";
import { resolveActorPartyId } from "../lib/party/resolve";

export const approvalsRouter = Router();

// POST /approvals/:id/decide  { decision: 'approve' | 'reject', proposed?: object }
//
// approve: status='approved', writes activity (Sent), audit log entry.
// reject:  status='rejected', writes activity.
// If `proposed` is included on approve, the body is replaced before sending —
// covers the "Edit draft" UX.
//
// Permission: agents.run — approving an agent's queued action is conceptually
// "running the agent," and rejecting also requires the same authority.
approvalsRouter.post("/:id/decide", requirePermission("agents.run"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "invalid id" });

    const decision = String(req.body?.decision ?? "");
    if (!["approve", "reject"].includes(decision)) {
      return res.status(400).json({ error: "decision must be approve|reject" });
    }
    const proposed = req.body?.proposed && typeof req.body.proposed === "object" ? req.body.proposed : null;

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const a = await db.execute(sql`
        SELECT a.id, a.status, a.work_item_id AS "workItemId", a.action_type AS "actionType",
               wi.party_id AS "partyId", p.name AS "partyName"
        FROM approval a
        LEFT JOIN work_item wi ON wi.id = a.work_item_id
        LEFT JOIN party p      ON p.id  = wi.party_id
        WHERE a.id = ${id}
      `);
      if (!a.rows[0]) return { kind: "not-found" as const };
      const row = a.rows[0] as {
        id: string; status: string; workItemId: string | null; actionType: string;
        partyId: string | null; partyName: string | null;
      };
      if (row.status !== "pending") return { kind: "not-pending" as const };

      const newStatus = decision === "approve" ? "approved" : "rejected";

      // If editing draft, persist the new proposed payload
      if (proposed) {
        await db.execute(sql`UPDATE approval SET proposed = ${JSON.stringify(proposed)}::jsonb WHERE id = ${id}`);
      }

      await db.execute(sql`
        UPDATE approval SET status = ${newStatus}, decided_at = NOW()
        WHERE id = ${id}
      `);

      // Activity row
      const verb = decision === "approve" ? "Sent" : "Rejected";
      const detail = decision === "approve"
        ? `Approved & sent the ${row.actionType.replace(/_/g, " ")} draft${row.partyName ? ` to ${row.partyName}` : ""}.`
        : `Rejected the ${row.actionType.replace(/_/g, " ")} draft.`;
      const tag = decision === "approve" ? "sent" : "you";

      if (row.workItemId) {
        await db.execute(sql`
          INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
          VALUES (current_tenant(), ${row.workItemId}, ${row.partyId}, 'user', ${actorPartyId}, 'You',
                  ${verb}, ${detail}, ${tag},
                  ${JSON.stringify({ when: "Just now", quote: null, approvalId: id })}::jsonb, NOW())
        `);
      }

      // Audit log
      await db.execute(sql`
        INSERT INTO audit_log (tenant_id, actor_type, actor_party_id, action, target_type, target_id, context)
        VALUES (current_tenant(), 'user', ${actorPartyId}, ${decision === "approve" ? "approval_approved" : "approval_rejected"},
                'approval', ${id},
                ${JSON.stringify({ workItemId: row.workItemId, actionType: row.actionType })}::jsonb)
      `);

      return { kind: "ok" as const, status: newStatus };
    });

    if (result.kind === "not-found")   return res.status(404).json({ error: "Approval not found" });
    if (result.kind === "not-pending") return res.status(409).json({ error: "Approval is no longer pending" });
    res.json({ ok: true, status: result.status });
  } catch (err) {
    next(err);
  }
});
