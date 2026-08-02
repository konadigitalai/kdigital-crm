import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

export const recordsRouter = Router();

// GET /records/:idOrNumber — full lead record. Every value comes from a row.
recordsRouter.get("/:idOrNumber", async (req, res, next) => {
  try {
    const { idOrNumber } = req.params;
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(idOrNumber);

    const data = await withTenant(req.tenantId!, async (db) => {
      // Lead + party + advisor join. Every field that the UI shows is a column.
      const leadRow = await db.execute(
        isUuid
          ? sql`
              SELECT
                wi.id              AS id,
                wi.number          AS number,
                wi.created_at      AS "createdAt",
                p.id               AS "partyId",
                p.name             AS name,
                p.email            AS "partyEmail",
                p.phone            AS "partyPhone",
                p.phone_country_code AS "partyPhoneCountryCode",
                p.city             AS "partyCity",
                l.initials, l.program, l.program_id AS "programId", l.value,  -- Phase 3: l.city dropped (use p.city)
                -- Stack is derived from the program (program.stack_id is NOT NULL),
                -- never stored on the lead — see the note in routes/leads.ts.
                stk.name AS stack, prg.stack_id AS "stackId",
                l.description     AS "description",
                l.fee_paid        AS "feePaid",
                l.fee_due         AS "feeDue",
                l.due_date        AS "dueDate",
                l.registered_date AS "registeredDate",
                l.next_followup_at AS "nextFollowupAt",
                l.demo_attended_at AS "demoAttendedAt",
                l.visited_date     AS "visitedDate",
                l.visiting_date    AS "visitingDate",
                l.time_zone        AS "timeZone",
                l.delivery_mode    AS "deliveryMode",
                l.lead_status      AS "leadStatus",
                l.working_status   AS "workingStatus",
                l.year_of_passout  AS "yearOfPassout",
                l.current_company  AS "currentCompany",
                l.payment_proof_url AS "paymentProofUrl",
                l.stage, l.stage_label AS "stageLabel",
                l.source           AS "leadSource",
                l.source_label     AS "sourceLabel",
                l.score, l.heat, l.rating, l.avatar,
                l.nba_icon         AS "nbaIcon",
                l.nba_label        AS "nbaLabel",
                l.nba_ghost        AS "nbaGhost",
                l.nba_confidence   AS "nbaConfidence",
                l.nba_headline     AS "nbaHeadline",
                l.nba_why          AS "nbaWhy",
                l.score_label      AS "scoreLabel",
                l.score_desc       AS "scoreDesc",
                l.score_reason     AS "scoreReason",
                u.id               AS "advisorId",
                u.name             AS "advisorName",
                u.email            AS "advisorEmail"
              FROM lead l
              JOIN work_item wi ON wi.id = l.work_item_id
              JOIN party p      ON p.id  = wi.party_id
              LEFT JOIN app_user u ON u.party_id = l.advisor_id
              LEFT JOIN program prg ON prg.id = l.program_id
              LEFT JOIN stack   stk ON stk.id = prg.stack_id
              WHERE wi.id = ${idOrNumber}
              LIMIT 1
            `
          : sql`
              SELECT
                wi.id              AS id,
                wi.number          AS number,
                wi.created_at      AS "createdAt",
                p.id               AS "partyId",
                p.name             AS name,
                p.email            AS "partyEmail",
                p.phone            AS "partyPhone",
                p.phone_country_code AS "partyPhoneCountryCode",
                p.city             AS "partyCity",
                l.initials, l.program, l.program_id AS "programId", l.value,  -- Phase 3: l.city dropped (use p.city)
                -- Stack is derived from the program (program.stack_id is NOT NULL),
                -- never stored on the lead — see the note in routes/leads.ts.
                stk.name AS stack, prg.stack_id AS "stackId",
                l.description     AS "description",
                l.fee_paid        AS "feePaid",
                l.fee_due         AS "feeDue",
                l.due_date        AS "dueDate",
                l.registered_date AS "registeredDate",
                l.next_followup_at AS "nextFollowupAt",
                l.demo_attended_at AS "demoAttendedAt",
                l.visited_date     AS "visitedDate",
                l.visiting_date    AS "visitingDate",
                l.time_zone        AS "timeZone",
                l.delivery_mode    AS "deliveryMode",
                l.lead_status      AS "leadStatus",
                l.working_status   AS "workingStatus",
                l.year_of_passout  AS "yearOfPassout",
                l.current_company  AS "currentCompany",
                l.payment_proof_url AS "paymentProofUrl",
                l.stage, l.stage_label AS "stageLabel",
                l.source           AS "leadSource",
                l.source_label     AS "sourceLabel",
                l.score, l.heat, l.rating, l.avatar,
                l.nba_icon         AS "nbaIcon",
                l.nba_label        AS "nbaLabel",
                l.nba_ghost        AS "nbaGhost",
                l.nba_confidence   AS "nbaConfidence",
                l.nba_headline     AS "nbaHeadline",
                l.nba_why          AS "nbaWhy",
                l.score_label      AS "scoreLabel",
                l.score_desc       AS "scoreDesc",
                l.score_reason     AS "scoreReason",
                u.id               AS "advisorId",
                u.name             AS "advisorName",
                u.email            AS "advisorEmail"
              FROM lead l
              JOIN work_item wi ON wi.id = l.work_item_id
              JOIN party p      ON p.id  = wi.party_id
              LEFT JOIN app_user u ON u.party_id = l.advisor_id
              LEFT JOIN program prg ON prg.id = l.program_id
              LEFT JOIN stack   stk ON stk.id = prg.stack_id
              WHERE wi.number = ${idOrNumber}
              LIMIT 1
            `,
      );
      if (!leadRow.rows[0]) return null;
      const row = leadRow.rows[0] as Record<string, unknown>;
      const wiId = row.id as string;

      // Signals — real rows
      const signals = await db.execute(sql`
        SELECT text, weight, kind
        FROM lead_score_signal
        WHERE work_item_id = ${wiId}
        ORDER BY rank
      `);

      // Agents on this lead — real rows joined to agent catalog
      const agentsOnLead = await db.execute(sql`
        SELECT
          a.key                   AS "key",
          a.name                  AS "name",
          aa.status               AS "status",
          aa.badge_label          AS "badgeLabel",
          aa.badge_kind           AS "badgeKind"
        FROM agent_assignment aa
        JOIN agent a ON a.id = aa.agent_id
        WHERE aa.work_item_id = ${wiId}
        ORDER BY aa.rank
      `);

      // Timeline — only ai/you rows; auto/sent/need are home-page feed entries.
      // Includes activity attached either directly to this lead's work_item
      // OR to any work_item that shares this party (so cases opened against
      // the same person appear in their unified history).
      const timeline = await db.execute(sql`
        SELECT
          a.id         AS "id",
          a.actor_type AS "actorType",
          a.actor_name AS "actorName",
          a.verb       AS "verb",
          a.detail     AS "detail",
          a.tag        AS "tag",
          a.payload    AS "payload",
          a.ts         AS "ts",
          wi.number    AS "originNumber",
          wi.type      AS "originType"
        FROM activity a
        LEFT JOIN work_item wi ON wi.id = a.work_item_id
        WHERE (a.work_item_id = ${wiId} OR a.party_id = ${row.partyId as string})
          AND a.tag IN ('ai','you')
        ORDER BY a.ts DESC
      `);

      // Pending approval, if any
      const approval = await db.execute(sql`
        SELECT id, action_type AS "actionType", mode, status, proposed
        FROM approval
        WHERE work_item_id = ${wiId} AND status = 'pending'
        LIMIT 1
      `);

      // Is this party already a learner? (controls "Convert" button visibility)
      const learnerCheck = await db.execute(sql`
        SELECT 1 FROM party_role
        WHERE party_id = ${row.partyId as string} AND role = 'learner' AND valid_to IS NULL
        LIMIT 1
      `);
      const isLearner = learnerCheck.rows.length > 0;

      // Is this party currently 'enrolled' (post-Enroll, pre-learner)? If so
      // the lead record swaps its "Enroll" button for a link to the pending
      // enrolment record instead of offering to enroll again.
      const enrolmentCheck = await db.execute(sql`
        SELECT e.id, e.number
        FROM party_role pr
        JOIN enrolment e ON e.party_id = pr.party_id
        WHERE pr.party_id = ${row.partyId as string} AND pr.role = 'enrolled' AND pr.valid_to IS NULL
        ORDER BY e.created_at DESC
        LIMIT 1
      `);
      const enrollment = (enrolmentCheck.rows[0] as { id: string; number: string | null } | undefined) ?? null;

      // Map agent.key → glyph/icon for the UI (presentation, not data — kept here
      // so the UI doesn't need to repeat the lookup).
      const AGENT_VISUAL: Record<string, { glyph: string; icon: string }> = {
        outreach:   { glyph: "magenta", icon: "spark" },
        scoring:    { glyph: "violet",  icon: "star"  },
        scheduler:  { glyph: "blue",    icon: "clock" },
        forecast:   { glyph: "ochre",   icon: "chart" },
        triage:     { glyph: "magenta", icon: "spark" },
        onboarding: { glyph: "ok",      icon: "spark" },
      };

      // Re-shape into the structure the existing UI expects. Nothing here is
      // hardcoded data — these are renames + presentation lookups.
      const lead = {
        ...row,
        attributes: {
          stageLabel: row.stageLabel,
          email:   row.partyEmail,
          phone:   row.partyPhone,
          phoneCountryCode: row.partyPhoneCountryCode ?? null,
          city:    row.partyCity,
          timeZone: row.timeZone ?? null,
          deliveryMode: row.deliveryMode ?? null,
          leadStatus: row.leadStatus ?? null,
          workingStatus: row.workingStatus ?? null,
          yearOfPassout: row.yearOfPassout ?? null,
          currentCompany: row.currentCompany ?? null,
          source:  row.sourceLabel,
          advisor: row.advisorName ?? null,
          scoreLabel: row.scoreLabel,
          scoreDesc:  row.scoreDesc,
          // Phase E: payment trail + description
          description:     row.description,
          feePaid:         row.feePaid,
          feeDue:          row.feeDue,
          dueDate:         row.dueDate,
          registeredDate:  row.registeredDate,
          nextFollowupAt:  row.nextFollowupAt,
          demoAttendedAt:  row.demoAttendedAt,
          visitedDate:     row.visitedDate,
          visitingDate:    row.visitingDate,
          paymentProofUrl: row.paymentProofUrl,
          signals: signals.rows,
          nbaCard: row.nbaHeadline
            ? { confidence: row.nbaConfidence, headline: row.nbaHeadline, why: row.nbaWhy }
            : null,
          agentsOnLead: agentsOnLead.rows.map((a) => {
            const r = a as Record<string, unknown>;
            const v = AGENT_VISUAL[r.key as string] ?? { glyph: "violet", icon: "star" };
            return {
              name: r.name,
              status: r.status,
              glyph: v.glyph,
              icon: v.icon,
              badge: { label: r.badgeLabel, kind: r.badgeKind },
            };
          }),
        },
      };

      return { lead, timeline: timeline.rows, approval: approval.rows[0] ?? null, isLearner, enrollment };
    });

    if (!data) {
      res.status(404).json({ error: "Record not found" });
      return;
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});
