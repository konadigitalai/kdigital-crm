import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { resolveActorPartyId } from "../lib/party/resolve.js";

export const convertRouter = Router();

// POST /leads/:idOrNumber/convert  { programId? }
//
// Atomic transition:
//   - If programId omitted, default to lead.program_id (the program they were a lead for).
//   - End-date the 'lead' party_role; insert 'learner' party_role.
//   - Insert program-level enrolment (no batches yet — assigned on learner page).
//   - Bump lead.stage = 'won', stage_label = 'Enrolled'.
//   - Activity + audit log.
convertRouter.post("/:idOrNumber/convert", async (req, res, next) => {
  try {
    const { idOrNumber } = req.params;
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(idOrNumber);
    const programIdInput = req.body?.programId ? String(req.body.programId).trim() : null;

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const leadR = await db.execute(
        isUuid
          ? sql`
              SELECT wi.id AS "workItemId", wi.party_id AS "partyId",
                     l.program_id AS "programId", l.stage,
                     l.value    AS "feeQuoted",
                     l.fee_paid AS "feePaid", l.fee_due AS "feeDue",
                     l.due_date AS "dueDate", l.registered_date AS "registeredDate",
                     l.payment_proof_url AS "paymentProofUrl",
                     p.name AS "partyName"
              FROM lead l
              JOIN work_item wi ON wi.id = l.work_item_id
              JOIN party p      ON p.id  = wi.party_id
              WHERE wi.id = ${idOrNumber}
            `
          : sql`
              SELECT wi.id AS "workItemId", wi.party_id AS "partyId",
                     l.program_id AS "programId", l.stage,
                     l.value    AS "feeQuoted",
                     l.fee_paid AS "feePaid", l.fee_due AS "feeDue",
                     l.due_date AS "dueDate", l.registered_date AS "registeredDate",
                     l.payment_proof_url AS "paymentProofUrl",
                     p.name AS "partyName"
              FROM lead l
              JOIN work_item wi ON wi.id = l.work_item_id
              JOIN party p      ON p.id  = wi.party_id
              WHERE wi.number = ${idOrNumber}
            `,
      );
      if (!leadR.rows[0]) return { kind: "not-found" as const };
      const lead = leadR.rows[0] as {
        workItemId: string; partyId: string; programId: string | null; stage: string; partyName: string;
        feeQuoted: string | null;
        feePaid: string | null; feeDue: string | null; dueDate: string | null;
        registeredDate: string | null; paymentProofUrl: string | null;
      };

      const programId = programIdInput ?? lead.programId;
      if (!programId) return { kind: "no-program" as const };

      // Verify program exists + enabled
      const progR = await db.execute(sql`
        SELECT id, name, price, enabled FROM program WHERE id = ${programId}
      `);
      if (!progR.rows[0]) return { kind: "program-missing" as const };
      const prog = progR.rows[0] as { id: string; name: string; price: string | null; enabled: boolean };
      if (!prog.enabled) return { kind: "program-inactive" as const };

      // Already converted?
      const learnerExists = await db.execute(sql`
        SELECT 1 FROM party_role
        WHERE party_id = ${lead.partyId} AND role = 'learner' AND valid_to IS NULL
      `);
      if (learnerExists.rows.length > 0) return { kind: "already-converted" as const };

      // Roles
      await db.execute(sql`
        UPDATE party_role SET valid_to = current_date - 1
        WHERE party_id = ${lead.partyId} AND role = 'lead' AND valid_to IS NULL
      `);
      await db.execute(sql`
        INSERT INTO party_role (tenant_id, party_id, role, valid_from)
        VALUES (current_tenant(), ${lead.partyId}, 'learner', current_date)
        ON CONFLICT (party_id, role, valid_from) DO NOTHING
      `);

      // Program enrolment — the fee ledger now lives HERE (post-0077), seeded
      // from the lead at convert time. price_paid/fee_due are legacy snapshot
      // columns kept for reporting; the live ledger is fee_quoted/fee_paid/etc.
      // payment_proofs seeds from the lead's single proof URL when present.
      const pricePaid = lead.feePaid ?? prog.price;
      const enrR = await db.execute(sql`
        INSERT INTO enrolment (
          tenant_id, number, party_id, program_id, deal_id, status,
          price_paid, fee_due, due_date, registered_date, payment_proof_url,
          fee_quoted, fee_paid, payment_status, payment_proofs
        )
        VALUES (
          current_tenant(), 'ENR-' || lpad(nextval('seq_enrolment')::text, 5, '0'),
          ${lead.partyId}, ${prog.id}, ${lead.workItemId}, 'active',
          ${pricePaid}, ${lead.feeDue}, ${lead.dueDate}, ${lead.registeredDate}, ${lead.paymentProofUrl},
          ${lead.feeQuoted}, ${lead.feePaid}, 'pending',
          CASE WHEN ${lead.paymentProofUrl}::text IS NOT NULL
               THEN ARRAY[${lead.paymentProofUrl}::text] ELSE ARRAY[]::text[] END
        )
        RETURNING id
      `);

      // Lead state
      await db.execute(sql`
        UPDATE lead SET stage = 'won', stage_label = 'Enrolled' WHERE work_item_id = ${lead.workItemId}
      `);
      await db.execute(sql`
        UPDATE work_item SET state = 'closed_won' WHERE id = ${lead.workItemId}
      `);

      // Activity + audit
      await db.execute(sql`
        INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
        VALUES (current_tenant(), ${lead.workItemId}, ${lead.partyId},
                'user', ${actorPartyId}, 'Conversion', 'Lead → Learner',
                ${`Converted ${lead.partyName} to a learner — enrolled into ${prog.name}.`},
                'you',
                ${JSON.stringify({ when: "Just now", quote: null, program: prog.name })}::jsonb,
                NOW())
      `);
      await db.execute(sql`
        INSERT INTO audit_log (tenant_id, actor_type, actor_party_id, action, target_type, target_id, context)
        VALUES (current_tenant(), 'user', ${actorPartyId}, 'lead_to_learner', 'work_item', ${lead.workItemId},
                ${JSON.stringify({ partyId: lead.partyId, programId: prog.id })}::jsonb)
      `);

      return {
        kind: "ok" as const,
        partyId: lead.partyId,
        partyName: lead.partyName,
        enrolmentId: (enrR.rows[0] as { id: string }).id,
        program: prog,
      };
    });

    if (result.kind === "not-found")          return res.status(404).json({ error: "Lead not found" });
    if (result.kind === "no-program")         return res.status(400).json({ error: "Lead has no program — set one before converting" });
    if (result.kind === "program-missing")    return res.status(404).json({ error: "Program not found" });
    if (result.kind === "program-inactive")   return res.status(409).json({ error: "Program is inactive" });
    if (result.kind === "already-converted")  return res.status(409).json({ error: "Lead is already a learner" });

    return res.json({
      ok: true,
      partyId: result.partyId,
      enrolmentId: result.enrolmentId,
      program: result.program,
    });
  } catch (err) {
    next(err);
  }
});

// POST /leads/:idOrNumber/enroll  { programId? }
//
// Step 1 of the two-step lead → enrolled → learner workflow. Mirrors /convert
// but stops at the 'enrolled' role: it creates the enrolment with
// status='pending' (payment not yet verified) and does NOT create the
// 'learner' role or learner_profile — that happens later in the enrollment's
// "Convert to Learner" step, gated on payment verification.
convertRouter.post("/:idOrNumber/enroll", async (req, res, next) => {
  try {
    const { idOrNumber } = req.params;
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(idOrNumber);
    const programIdInput = req.body?.programId ? String(req.body.programId).trim() : null;

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const leadR = await db.execute(
        isUuid
          ? sql`
              SELECT wi.id AS "workItemId", wi.party_id AS "partyId",
                     l.program_id AS "programId", l.stage,
                     l.value    AS "feeQuoted",
                     l.fee_paid AS "feePaid", l.fee_due AS "feeDue",
                     l.due_date AS "dueDate", l.registered_date AS "registeredDate",
                     l.payment_proof_url AS "paymentProofUrl",
                     p.name AS "partyName"
              FROM lead l
              JOIN work_item wi ON wi.id = l.work_item_id
              JOIN party p      ON p.id  = wi.party_id
              WHERE wi.id = ${idOrNumber}
            `
          : sql`
              SELECT wi.id AS "workItemId", wi.party_id AS "partyId",
                     l.program_id AS "programId", l.stage,
                     l.value    AS "feeQuoted",
                     l.fee_paid AS "feePaid", l.fee_due AS "feeDue",
                     l.due_date AS "dueDate", l.registered_date AS "registeredDate",
                     l.payment_proof_url AS "paymentProofUrl",
                     p.name AS "partyName"
              FROM lead l
              JOIN work_item wi ON wi.id = l.work_item_id
              JOIN party p      ON p.id  = wi.party_id
              WHERE wi.number = ${idOrNumber}
            `,
      );
      if (!leadR.rows[0]) return { kind: "not-found" as const };
      const lead = leadR.rows[0] as {
        workItemId: string; partyId: string; programId: string | null; stage: string; partyName: string;
        feeQuoted: string | null;
        feePaid: string | null; feeDue: string | null; dueDate: string | null;
        registeredDate: string | null; paymentProofUrl: string | null;
      };

      const programId = programIdInput ?? lead.programId;
      if (!programId) return { kind: "no-program" as const };

      const progR = await db.execute(sql`
        SELECT id, name, price, enabled FROM program WHERE id = ${programId}
      `);
      if (!progR.rows[0]) return { kind: "program-missing" as const };
      const prog = progR.rows[0] as { id: string; name: string; price: string | null; enabled: boolean };
      if (!prog.enabled) return { kind: "program-inactive" as const };

      // Already enrolled or converted?
      const roleExists = await db.execute(sql`
        SELECT role FROM party_role
        WHERE party_id = ${lead.partyId} AND role IN ('enrolled','learner') AND valid_to IS NULL
        LIMIT 1
      `);
      if (roleExists.rows.length > 0) {
        const role = (roleExists.rows[0] as { role: string }).role;
        return { kind: role === "learner" ? "already-learner" as const : "already-enrolled" as const };
      }

      // Roles: end 'lead', insert 'enrolled' (NOT 'learner').
      await db.execute(sql`
        UPDATE party_role SET valid_to = current_date - 1
        WHERE party_id = ${lead.partyId} AND role = 'lead' AND valid_to IS NULL
      `);
      await db.execute(sql`
        INSERT INTO party_role (tenant_id, party_id, role, valid_from)
        VALUES (current_tenant(), ${lead.partyId}, 'enrolled', current_date)
        ON CONFLICT (party_id, role, valid_from) DO NOTHING
      `);

      // Program enrolment — status 'pending' (payment not yet verified). Same
      // ENR-##### number generation + fee-ledger seeding as /convert.
      const pricePaid = lead.feePaid ?? prog.price;
      const enrR = await db.execute(sql`
        INSERT INTO enrolment (
          tenant_id, number, party_id, program_id, deal_id, status,
          price_paid, fee_due, due_date, registered_date, payment_proof_url,
          fee_quoted, fee_paid, payment_status, payment_proofs
        )
        VALUES (
          current_tenant(), 'ENR-' || lpad(nextval('seq_enrolment')::text, 5, '0'),
          ${lead.partyId}, ${prog.id}, ${lead.workItemId}, 'pending',
          ${pricePaid}, ${lead.feeDue}, ${lead.dueDate}, ${lead.registeredDate}, ${lead.paymentProofUrl},
          ${lead.feeQuoted}, ${lead.feePaid}, 'pending',
          CASE WHEN ${lead.paymentProofUrl}::text IS NOT NULL
               THEN ARRAY[${lead.paymentProofUrl}::text] ELSE ARRAY[]::text[] END
        )
        RETURNING id
      `);

      // Lead state — same close-won transition as /convert.
      await db.execute(sql`
        UPDATE lead SET stage = 'won', stage_label = 'Enrolled' WHERE work_item_id = ${lead.workItemId}
      `);
      await db.execute(sql`
        UPDATE work_item SET state = 'closed_won' WHERE id = ${lead.workItemId}
      `);

      await db.execute(sql`
        INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
        VALUES (current_tenant(), ${lead.workItemId}, ${lead.partyId},
                'user', ${actorPartyId}, 'Enrolment', 'Lead → Enrolled',
                ${`Enrolled ${lead.partyName} into ${prog.name} — pending payment verification.`},
                'you',
                ${JSON.stringify({ when: "Just now", quote: null, program: prog.name })}::jsonb,
                NOW())
      `);
      await db.execute(sql`
        INSERT INTO audit_log (tenant_id, actor_type, actor_party_id, action, target_type, target_id, context)
        VALUES (current_tenant(), 'user', ${actorPartyId}, 'lead_to_enrolled', 'work_item', ${lead.workItemId},
                ${JSON.stringify({ partyId: lead.partyId, programId: prog.id })}::jsonb)
      `);

      return {
        kind: "ok" as const,
        partyId: lead.partyId,
        partyName: lead.partyName,
        enrolmentId: (enrR.rows[0] as { id: string }).id,
        program: prog,
      };
    });

    if (result.kind === "not-found")         return res.status(404).json({ error: "Lead not found" });
    if (result.kind === "no-program")        return res.status(400).json({ error: "Lead has no program — set one before enrolling" });
    if (result.kind === "program-missing")   return res.status(404).json({ error: "Program not found" });
    if (result.kind === "program-inactive")  return res.status(409).json({ error: "Program is inactive" });
    if (result.kind === "already-enrolled")  return res.status(409).json({ error: "Lead is already enrolled" });
    if (result.kind === "already-learner")   return res.status(409).json({ error: "Lead is already a learner" });

    return res.json({
      ok: true,
      partyId: result.partyId,
      enrolmentId: result.enrolmentId,
      program: result.program,
    });
  } catch (err) {
    next(err);
  }
});
