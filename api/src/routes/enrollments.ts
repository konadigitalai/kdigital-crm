import { Router } from "express";
import { sql, type SQL } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { resolveActorPartyId } from "../lib/party/resolve.js";

export const enrollmentsRouter = Router();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Exec = { execute: (q: SQL) => Promise<any> };

// The enrolment IS the enrollment record. It persists after conversion — a
// learner keeps their enrolment — so these routes surface both the pre-learner
// ('enrolled' role, status 'pending') and post-conversion ('learner' role,
// status 'active') states. The fee ledger + payment verification live here.

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

// Resolve an enrolment by its uuid (enrolment.id) or its ENR-##### number.
// Returns the enrolment id + owning party id, or null when not found.
async function resolveEnrolment(
  db: Exec,
  idOrNumber: string,
): Promise<{ id: string; partyId: string } | null> {
  const isUuid = UUID_RE.test(idOrNumber);
  const r = await db.execute(
    isUuid
      ? sql`SELECT id, party_id AS "partyId" FROM enrolment WHERE id = ${idOrNumber} LIMIT 1`
      : sql`SELECT id, party_id AS "partyId" FROM enrolment WHERE number = ${idOrNumber} LIMIT 1`,
  );
  return (r.rows[0] as { id: string; partyId: string } | undefined) ?? null;
}

// Payment-health label derived from paid/quoted + due date vs today. Pure
// function so the list route can compute it per-row after the query.
function paymentHealth(
  feeQuoted: string | null,
  feePaid: string | null,
  dueDate: string | null,
): "paid_in_full" | "on_track" | "due_soon" | "overdue" | "critical" {
  const quoted = Number(feeQuoted ?? 0);
  const paid = Number(feePaid ?? 0);
  if (quoted > 0 && paid >= quoted) return "paid_in_full";
  if (!dueDate) return "on_track";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysToDue = Math.floor((due.getTime() - today.getTime()) / msPerDay);
  const pctPaid = quoted > 0 ? paid / quoted : 0;
  if (daysToDue < 0) return pctPaid < 0.2 ? "critical" : "overdue";
  if (daysToDue <= 7) return "due_soon";
  return "on_track";
}

// Human-friendly status label derived from the raw enrolment status plus batch
// state. Kept a pure function so the list route can compute it per-row.
//   active + has an active batch      → "In Training"
//   active + batched, none active yet → "Batched"
//   active + no batch                 → "Active"
//   anything else                     → Title-case of the raw status
const STATUS_TITLE: Record<string, string> = {
  pending: "Pending", active: "Active", on_hold: "On hold",
  completed: "Completed", dropped: "Dropped", deferred: "Deferred",
};
function statusLabel(status: string, activeBatches: number, totalBatches: number): string {
  if (status === "active") {
    if (activeBatches > 0) return "In Training";
    if (totalBatches > 0) return "Batched";
    return "Active";
  }
  return STATUS_TITLE[status] ?? (status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " "));
}

// GET / — every enrollment for parties whose current role is 'enrolled' or
// 'learner'. One row per enrolment, newest first. Carries everything the
// Enrollments board needs to display, filter, group and search: party contact,
// program + stack, course-module chips, batch code, advisor, and the fee ledger
// with its computed payment-health.
enrollmentsRouter.get("/", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          e.id                AS "id",
          e.number            AS "number",
          e.status            AS "status",
          e.fee_quoted        AS "feeQuoted",
          e.fee_paid          AS "feePaid",
          e.due_date          AS "dueDate",
          e.payment_status    AS "paymentStatus",
          e.payment_verified_at AS "paymentVerifiedAt",
          e.created_at        AS "createdAt",
          p.id                AS "partyId",
          p.name              AS "name",
          p.email             AS "email",
          p.phone             AS "phone",
          p.city              AS "city",
          pg.name             AS "programName",
          stk.name            AS "stackName",
          au.id               AS "advisorId",   -- app_user.id (l.advisor_id stores party.id)
          au.name             AS "advisorName",
          e.registered_date   AS "registeredDate",
          -- Course-module chips: the enrolled learner's assigned course names.
          (
            SELECT COALESCE(array_agg(DISTINCT co.name) FILTER (WHERE co.name IS NOT NULL), '{}')
            FROM course_assignment ca
            JOIN course co ON co.id = ca.course_id
            WHERE ca.party_id = p.id
          )                   AS "courseModules",
          -- Primary batch code: prefer an active assignment, else the newest.
          (
            SELECT c.code FROM batch_assignment b
            JOIN cohort c ON c.id = b.cohort_id
            WHERE b.party_id = p.id
            ORDER BY (b.status = 'active') DESC, b.created_at DESC
            LIMIT 1
          )                   AS "batchCode",
          (
            SELECT pr.role FROM party_role pr
            WHERE pr.party_id = p.id AND pr.role IN ('enrolled','learner') AND pr.valid_to IS NULL
            ORDER BY (pr.role = 'learner') DESC LIMIT 1
          )                   AS "role",
          (SELECT COUNT(*)::int FROM batch_assignment b WHERE b.party_id = p.id AND b.status = 'active') AS "activeBatches",
          (SELECT COUNT(*)::int FROM batch_assignment b WHERE b.party_id = p.id)                         AS "totalBatches"
        FROM enrolment e
        JOIN party p         ON p.id  = e.party_id
        LEFT JOIN program pg ON pg.id = e.program_id
        LEFT JOIN stack   stk ON stk.id = pg.stack_id
        LEFT JOIN lead l     ON l.work_item_id = e.deal_id
        LEFT JOIN app_user au ON au.party_id = l.advisor_id
        WHERE EXISTS (
          SELECT 1 FROM party_role pr
          WHERE pr.party_id = p.id AND pr.role IN ('enrolled','learner') AND pr.valid_to IS NULL
        )
        ORDER BY e.created_at DESC
      `);
      return r.rows;
    });

    const enrollments = rows.map((raw) => {
      const row = raw as {
        id: string; number: string | null; status: string;
        feeQuoted: string | null; feePaid: string | null; dueDate: string | null;
        paymentStatus: string | null; paymentVerifiedAt: string | null; createdAt: string;
        partyId: string; name: string; email: string | null; phone: string | null; city: string | null;
        programName: string | null; stackName: string | null;
        advisorId: string | null; advisorName: string | null; registeredDate: string | null;
        courseModules: string[] | null; batchCode: string | null; role: string | null;
        activeBatches: number; totalBatches: number;
      };
      const quoted = row.feeQuoted == null ? null : Number(row.feeQuoted);
      const paid = row.feePaid == null ? null : Number(row.feePaid);
      const feeDue = quoted == null ? null : String(Math.max(0, quoted - (paid ?? 0)));
      const paidPct = quoted != null && quoted > 0 ? Math.round(((paid ?? 0) / quoted) * 100) : null;
      return {
        ...row,
        courseModules: row.courseModules ?? [],
        feeDue,
        paidPct,
        statusLabel: statusLabel(row.status, row.activeBatches, row.totalBatches),
        paymentHealth: paymentHealth(row.feeQuoted, row.feePaid, row.dueDate),
      };
    });

    res.json({ enrollments });
  } catch (err) {
    next(err);
  }
});

// GET /summary — KPI aggregates for the Enrollments stat cards. Same population
// as GET / (parties currently 'enrolled' or 'learner'). One efficient query;
// the roll-ups are computed in JS so the payment-health rules stay in one place.
enrollmentsRouter.get("/summary", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          e.fee_quoted AS "feeQuoted",
          e.fee_paid   AS "feePaid",
          e.due_date   AS "dueDate"
        FROM enrolment e
        JOIN party p ON p.id = e.party_id
        WHERE EXISTS (
          SELECT 1 FROM party_role pr
          WHERE pr.party_id = p.id AND pr.role IN ('enrolled','learner') AND pr.valid_to IS NULL
        )
      `);
      return r.rows as Array<{ feeQuoted: string | null; feePaid: string | null; dueDate: string | null }>;
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const msPerDay = 24 * 60 * 60 * 1000;

    let contractedTotal = 0;
    let collectedTotal = 0;
    let outstandingTotal = 0;
    let overdueTotal = 0;
    let overdueCount = 0;
    let dueSoonTotal = 0;
    let dueSoonCount = 0;

    for (const row of rows) {
      const quoted = row.feeQuoted == null ? 0 : Number(row.feeQuoted);
      const paid = row.feePaid == null ? 0 : Number(row.feePaid);
      contractedTotal += quoted;
      collectedTotal += paid;
      const due = Math.max(0, quoted - paid);
      outstandingTotal += due;
      const paidInFull = quoted > 0 && paid >= quoted;
      if (paidInFull || due <= 0 || !row.dueDate) continue;
      const dueDate = new Date(row.dueDate);
      const daysToDue = Math.floor((dueDate.getTime() - today.getTime()) / msPerDay);
      if (daysToDue < 0) {
        overdueTotal += due;
        overdueCount += 1;
      } else if (daysToDue <= 7) {
        dueSoonTotal += due;
        dueSoonCount += 1;
      }
    }

    res.json({
      summary: {
        contractedTotal,
        collectedTotal,
        collectedPct: contractedTotal > 0 ? Math.round((collectedTotal / contractedTotal) * 100) : 0,
        outstandingTotal,
        overdueTotal,
        overdueCount,
        dueSoonTotal,
        dueSoonCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /:idOrNumber — full enrollment detail: enrolment fields incl. fee ledger
// + payment verification, party, program, batch/course summary, and the
// party-level activity timeline. `role` tells the UI whether the party is
// already a learner.
enrollmentsRouter.get("/:idOrNumber", async (req, res, next) => {
  try {
    const idOrNumber = String(req.params.idOrNumber);

    const data = await withTenant(req.tenantId!, async (db) => {
      const isUuid = UUID_RE.test(idOrNumber);
      const enrR = await db.execute(
        isUuid
          ? sql`
              SELECT e.*, e.payment_verified_at AS "paymentVerifiedAt"
              FROM enrolment e WHERE e.id = ${idOrNumber} LIMIT 1
            `
          : sql`
              SELECT e.*, e.payment_verified_at AS "paymentVerifiedAt"
              FROM enrolment e WHERE e.number = ${idOrNumber} LIMIT 1
            `,
      );
      const enr = enrR.rows[0] as Record<string, unknown> | undefined;
      if (!enr) return null;

      const partyId = enr.party_id as string;

      const partyR = await db.execute(sql`
        SELECT p.id, p.name, p.email, p.phone, p.city, p.attributes,
               pg.name AS "programName",
               pg.id   AS "programId",
               vb.name AS "verifiedByName",
               (
                 SELECT pr.role FROM party_role pr
                 WHERE pr.party_id = p.id AND pr.role IN ('enrolled','learner') AND pr.valid_to IS NULL
                 ORDER BY (pr.role = 'learner') DESC LIMIT 1
               ) AS "role"
        FROM party p
        LEFT JOIN program pg ON pg.id = ${enr.program_id as string}
        LEFT JOIN party vb   ON vb.id = ${(enr.payment_verified_by as string | null) ?? null}
        WHERE p.id = ${partyId}
      `);
      const party = partyR.rows[0] as Record<string, unknown> | undefined;
      if (!party) return null;

      const timeline = await db.execute(sql`
        SELECT
          a.id AS "id", a.actor_type AS "actorType", a.actor_name AS "actorName",
          a.verb AS "verb", a.detail AS "detail", a.tag AS "tag",
          a.payload AS "payload", a.ts AS "ts"
        FROM activity a
        WHERE a.party_id = ${partyId} AND a.tag IN ('ai','you')
        ORDER BY a.ts DESC
      `);

      const originLead = await db.execute(sql`
        SELECT wi.number, wi.id AS "workItemId"
        FROM lead l
        JOIN work_item wi ON wi.id = l.work_item_id
        WHERE wi.party_id = ${partyId}
        ORDER BY wi.created_at
        LIMIT 1
      `);

      const quoted = enr.fee_quoted == null ? null : Number(enr.fee_quoted);
      const paid = enr.fee_paid == null ? null : Number(enr.fee_paid);

      return {
        enrolment: {
          id: enr.id as string,
          number: (enr.number as string | null) ?? null,
          status: enr.status as string,
          feeQuoted: (enr.fee_quoted as string | null) ?? null,
          feePaid: (enr.fee_paid as string | null) ?? null,
          feeDue: quoted == null ? null : String(Math.max(0, quoted - (paid ?? 0))),
          dueDate: (enr.due_date as string | null) ?? null,
          paymentStatus: (enr.payment_status as string | null) ?? null,
          paymentProofUrl: (enr.payment_proof_url as string | null) ?? null,
          paymentProofs: (enr.payment_proofs as string[] | null) ?? [],
          feeNotes: (enr.fee_notes as string | null) ?? null,
          paymentVerifiedAt: (enr.paymentVerifiedAt as string | null) ?? null,
          verifiedByName: (party.verifiedByName as string | null) ?? null,
          paymentHealth: paymentHealth(
            (enr.fee_quoted as string | null) ?? null,
            (enr.fee_paid as string | null) ?? null,
            (enr.due_date as string | null) ?? null,
          ),
        },
        party: {
          id: party.id as string,
          name: party.name as string,
          email: (party.email as string | null) ?? null,
          phone: (party.phone as string | null) ?? null,
          city: (party.city as string | null) ?? null,
          attributes: (party.attributes as { initials?: string } | null) ?? {},
          role: (party.role as string | null) ?? null,
        },
        programName: (party.programName as string | null) ?? null,
        programId: (party.programId as string | null) ?? null,
        timeline: timeline.rows,
        originLead: originLead.rows[0] ?? null,
      };
    });

    if (!data) return res.status(404).json({ error: "Enrollment not found" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /:idOrNumber/verify-payment — finance signs off on the fee. Sets
// payment_verified_at/by; this is the gate Convert-to-Learner requires.
enrollmentsRouter.post("/:idOrNumber/verify-payment", async (req, res, next) => {
  try {
    const idOrNumber = String(req.params.idOrNumber);
    const actorName = req.user?.name?.trim() || "You";

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const enr = await resolveEnrolment(db, idOrNumber);
      if (!enr) return { kind: "not-found" as const };

      const r = await db.execute(sql`
        UPDATE enrolment
        SET payment_verified_at = NOW(), payment_verified_by = ${actorPartyId}
        WHERE id = ${enr.id}
        RETURNING id, number, payment_verified_at AS "paymentVerifiedAt"
      `);

      await db.execute(sql`
        INSERT INTO activity (tenant_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
        VALUES (current_tenant(), ${enr.partyId}, 'user', ${actorPartyId}, ${actorName}, 'Payment verified',
                'Payment verified — cleared for conversion to learner.', 'you',
                ${JSON.stringify({ when: "Just now", quote: null })}::jsonb, NOW())
      `);

      return { kind: "ok" as const, enrolment: r.rows[0] };
    });

    if (result.kind === "not-found") return res.status(404).json({ error: "Enrollment not found" });
    res.json({ ok: true, enrolment: result.enrolment });
  } catch (err) {
    next(err);
  }
});

// POST /:idOrNumber/convert — enrolled → learner. HARD BLOCK unless payment is
// verified. End-dates the 'enrolled' role, inserts 'learner', flips the
// enrolment to 'active', and seeds the learner_profile row.
enrollmentsRouter.post("/:idOrNumber/convert", async (req, res, next) => {
  try {
    const idOrNumber = String(req.params.idOrNumber);
    const actorName = req.user?.name?.trim() || "You";

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);

      const isUuid = UUID_RE.test(idOrNumber);
      const enrR = await db.execute(
        isUuid
          ? sql`
              SELECT e.id, e.party_id AS "partyId", e.program_id AS "programId",
                     e.payment_verified_at AS "paymentVerifiedAt",
                     p.name AS "partyName", pg.name AS "programName"
              FROM enrolment e
              JOIN party p ON p.id = e.party_id
              LEFT JOIN program pg ON pg.id = e.program_id
              WHERE e.id = ${idOrNumber} LIMIT 1
            `
          : sql`
              SELECT e.id, e.party_id AS "partyId", e.program_id AS "programId",
                     e.payment_verified_at AS "paymentVerifiedAt",
                     p.name AS "partyName", pg.name AS "programName"
              FROM enrolment e
              JOIN party p ON p.id = e.party_id
              LEFT JOIN program pg ON pg.id = e.program_id
              WHERE e.number = ${idOrNumber} LIMIT 1
            `,
      );
      const enr = enrR.rows[0] as {
        id: string; partyId: string; programId: string | null;
        paymentVerifiedAt: string | null; partyName: string; programName: string | null;
      } | undefined;
      if (!enr) return { kind: "not-found" as const };

      // Already a learner?
      const learnerExists = await db.execute(sql`
        SELECT 1 FROM party_role
        WHERE party_id = ${enr.partyId} AND role = 'learner' AND valid_to IS NULL LIMIT 1
      `);
      if (learnerExists.rows.length > 0) return { kind: "already-learner" as const };

      // HARD BLOCK — payment must be verified first.
      if (!enr.paymentVerifiedAt) return { kind: "payment-unverified" as const };

      // Role flip: end 'enrolled', insert 'learner'.
      await db.execute(sql`
        UPDATE party_role SET valid_to = current_date - 1
        WHERE party_id = ${enr.partyId} AND role = 'enrolled' AND valid_to IS NULL
      `);
      await db.execute(sql`
        INSERT INTO party_role (tenant_id, party_id, role, valid_from)
        VALUES (current_tenant(), ${enr.partyId}, 'learner', current_date)
        ON CONFLICT (party_id, role, valid_from) DO NOTHING
      `);

      // Enrolment goes live.
      await db.execute(sql`
        UPDATE enrolment SET status = 'active' WHERE id = ${enr.id}
      `);

      // Seed the learner profile row (idempotent).
      //
      // `number` is the LRN-#### the learner sees in the LMS portal header and
      // quotes on support requests. post-0083 added the column and backfilled
      // existing rows; this is where new ones get theirs. Without it every
      // learner converted after that migration would carry a null identifier.
      //
      // COALESCE on conflict so re-running the conversion can't burn a
      // sequence value or renumber someone who already has one.
      await db.execute(sql`
        INSERT INTO learner_profile (party_id, tenant_id, number)
        VALUES (
          ${enr.partyId}, current_tenant(),
          'LRN-' || lpad(nextval('seq_learner')::text, 4, '0')
        )
        ON CONFLICT (party_id) DO UPDATE
          SET number = COALESCE(learner_profile.number, EXCLUDED.number)
      `);

      await db.execute(sql`
        INSERT INTO activity (tenant_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
        VALUES (current_tenant(), ${enr.partyId}, 'user', ${actorPartyId}, ${actorName}, 'Enrolled → Learner',
                ${`Converted ${enr.partyName} to a learner${enr.programName ? ` — ${enr.programName}` : ""}.`}, 'you',
                ${JSON.stringify({ when: "Just now", quote: null, program: enr.programName })}::jsonb, NOW())
      `);
      await db.execute(sql`
        INSERT INTO audit_log (tenant_id, actor_type, actor_party_id, action, target_type, target_id, context)
        VALUES (current_tenant(), 'user', ${actorPartyId}, 'enrolled_to_learner', 'enrolment', ${enr.id},
                ${JSON.stringify({ partyId: enr.partyId, programId: enr.programId })}::jsonb)
      `);

      return { kind: "ok" as const, partyId: enr.partyId };
    });

    if (result.kind === "not-found") return res.status(404).json({ error: "Enrollment not found" });
    if (result.kind === "already-learner") return res.status(409).json({ error: "Already a learner" });
    if (result.kind === "payment-unverified") {
      return res.status(409).json({
        error: "Payment must be verified before converting to a learner.",
        code: "payment_unverified",
      });
    }
    res.json({ ok: true, partyId: result.partyId });
  } catch (err) {
    next(err);
  }
});

// PATCH /:idOrNumber/fee — edit the enrolment fee ledger. Same field set +
// validation + diff-activity as PATCH /learners/:partyId/fee, but targets the
// enrolment directly by id/number (works pre- and post-conversion).
const PAYMENT_STATUSES = ["pending", "paid", "refund", "on_hold"] as const;

const FEE_STATUS_LABEL: Record<string, string> = {
  pending: "Pending", paid: "Paid", refund: "Refund", on_hold: "On hold",
};

function fmtFeeValue(field: string, v: string | number | null): string {
  if (v == null || v === "") return "—";
  if (field === "feeQuoted" || field === "feePaid") return `₹${Number(v).toLocaleString("en-IN")}`;
  if (field === "paymentStatus") return FEE_STATUS_LABEL[String(v)] ?? String(v);
  if (field === "paymentProofs") {
    const n = Number(v);
    return n === 0 ? "none" : `${n} receipt${n === 1 ? "" : "s"}`;
  }
  if (field === "feeNotes") {
    const s = String(v);
    return s.length > 40 ? `${s.slice(0, 37)}…` : s;
  }
  return String(v);
}

const FEE_FIELD_LABEL: Record<string, string> = {
  feeQuoted: "Fee quoted", feePaid: "Fee paid", dueDate: "Due date",
  paymentStatus: "Payment status", paymentProofs: "Payment proof", feeNotes: "Notes",
};

const MAX_PROOF_ENTRY_BYTES = 6_500_000;
const MAX_PROOF_TOTAL_BYTES = 26_000_000;

enrollmentsRouter.patch("/:idOrNumber/fee", async (req, res, next) => {
  try {
    const idOrNumber = String(req.params.idOrNumber);
    const b = req.body ?? {};

    function money(v: unknown): string | null | undefined {
      if (v === undefined) return undefined;
      if (v === null || v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error("fee amount must be a non-negative number");
      return String(n);
    }

    let feeQuoted: string | null | undefined;
    let feePaid: string | null | undefined;
    try {
      feeQuoted = money(b.feeQuoted);
      feePaid = money(b.feePaid);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    const dueDate = b.dueDate !== undefined
      ? (b.dueDate ? String(b.dueDate).trim() : null)
      : undefined;
    if (dueDate !== undefined && dueDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      return res.status(400).json({ error: "dueDate must be YYYY-MM-DD" });
    }

    const paymentStatus = b.paymentStatus !== undefined
      ? (b.paymentStatus ? String(b.paymentStatus).trim() : null)
      : undefined;
    if (paymentStatus !== undefined && paymentStatus !== null
        && !PAYMENT_STATUSES.includes(paymentStatus as typeof PAYMENT_STATUSES[number])) {
      return res.status(400).json({ error: `paymentStatus must be one of ${PAYMENT_STATUSES.join(", ")}` });
    }

    let paymentProofs: string[] | undefined;
    if (b.paymentProofs !== undefined) {
      if (!Array.isArray(b.paymentProofs)) {
        return res.status(400).json({ error: "paymentProofs must be an array" });
      }
      const cleaned: string[] = [];
      let total = 0;
      for (const raw of b.paymentProofs) {
        const s = String(raw ?? "").trim();
        if (!s) continue;
        if (s.length > MAX_PROOF_ENTRY_BYTES) {
          return res.status(413).json({ error: "one payment proof is too large (max ~5 MB)" });
        }
        total += s.length;
        cleaned.push(s);
      }
      if (total > MAX_PROOF_TOTAL_BYTES) {
        return res.status(413).json({ error: "combined payment proofs are too large (max ~20 MB)" });
      }
      paymentProofs = cleaned;
    }

    const feeNotes = b.feeNotes !== undefined
      ? (b.feeNotes ? String(b.feeNotes).trim().slice(0, 2000) : null)
      : undefined;

    const sets: ReturnType<typeof sql>[] = [];
    if (feeQuoted !== undefined) sets.push(sql`fee_quoted     = ${feeQuoted}`);
    if (feePaid !== undefined) sets.push(sql`fee_paid       = ${feePaid}`);
    if (dueDate !== undefined) sets.push(sql`due_date       = ${dueDate}`);
    if (paymentStatus !== undefined) sets.push(sql`payment_status = ${paymentStatus}`);
    if (paymentProofs !== undefined) {
      const arrExpr = paymentProofs.length === 0
        ? sql`ARRAY[]::text[]`
        : sql`ARRAY[${sql.join(paymentProofs.map((p) => sql`${p}`), sql`, `)}]::text[]`;
      sets.push(sql`payment_proofs = ${arrExpr}`);
      sets.push(sql`payment_proof_url = ${paymentProofs[0] ?? null}`);
    }
    if (feeNotes !== undefined) sets.push(sql`fee_notes      = ${feeNotes}`);

    if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });

    const outcome = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const enr = await resolveEnrolment(db, idOrNumber);
      if (!enr) return null;
      const enrolmentId = enr.id;

      const beforeR = await db.execute(sql`
        SELECT
          fee_quoted     AS "feeQuoted", fee_paid AS "feePaid", due_date AS "dueDate",
          payment_status AS "paymentStatus", payment_proofs AS "paymentProofs", fee_notes AS "feeNotes"
        FROM enrolment WHERE id = ${enrolmentId}
      `);
      type LedgerRow = {
        feeQuoted: string | null; feePaid: string | null; dueDate: string | null;
        paymentStatus: string | null; paymentProofs: string[] | null; feeNotes: string | null;
      };
      const before = beforeR.rows[0] as LedgerRow | undefined;

      const setClause = sql.join(sets, sql`, `);
      const r = await db.execute(sql`
        UPDATE enrolment SET ${setClause}
        WHERE id = ${enrolmentId}
        RETURNING
          fee_quoted        AS "feeQuoted", fee_paid AS "feePaid", due_date AS "dueDate",
          payment_status    AS "paymentStatus", payment_proof_url AS "paymentProofUrl",
          payment_proofs    AS "paymentProofs", fee_notes AS "feeNotes"
      `);
      const after = r.rows[0] as (LedgerRow & { paymentProofUrl: string | null }) | undefined;
      if (!after) return null;

      const changes: string[] = [];
      const dueDateStr = (v: string | null): string | null => {
        if (!v) return null;
        return typeof v === "string" ? v.slice(0, 10) : new Date(v as unknown as string).toISOString().slice(0, 10);
      };
      const proofsEqual = (a: string[] | null, bb: string[] | null): boolean => {
        const aa = a ?? []; const b2 = bb ?? [];
        if (aa.length !== b2.length) return false;
        for (let i = 0; i < aa.length; i++) if (aa[i] !== b2[i]) return false;
        return true;
      };
      for (const key of ["feeQuoted","feePaid","dueDate","paymentStatus","paymentProofs","feeNotes"] as const) {
        if (key === "paymentProofs") {
          if (proofsEqual(before?.paymentProofs ?? null, after.paymentProofs ?? null)) continue;
          const bLen = (before?.paymentProofs ?? []).length;
          const aLen = (after.paymentProofs ?? []).length;
          changes.push(`${FEE_FIELD_LABEL[key]}: ${fmtFeeValue(key, bLen)} → ${fmtFeeValue(key, aLen)}`);
          continue;
        }
        const bv = key === "dueDate" ? dueDateStr(before?.[key] ?? null) : (before?.[key] ?? null);
        const av = key === "dueDate" ? dueDateStr(after[key] ?? null) : (after[key] ?? null);
        if (bv === av) continue;
        changes.push(`${FEE_FIELD_LABEL[key]}: ${fmtFeeValue(key, bv)} → ${fmtFeeValue(key, av)}`);
      }

      if (changes.length > 0) {
        const actorName = req.user?.name?.trim() || "You";
        const detail = `Updated fee ledger — ${changes.join("; ")}.`;
        await db.execute(sql`
          INSERT INTO activity (tenant_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
          VALUES (current_tenant(), ${enr.partyId}, 'user', ${actorPartyId}, ${actorName}, 'Fee ledger updated',
                  ${detail}, 'you',
                  ${JSON.stringify({ when: "Just now", quote: null, changes })}::jsonb, NOW())
        `);
      }

      return after;
    });

    if (!outcome) return res.status(404).json({ error: "Enrollment not found" });
    res.json({ ok: true, fee: outcome });
  } catch (err) {
    next(err);
  }
});
