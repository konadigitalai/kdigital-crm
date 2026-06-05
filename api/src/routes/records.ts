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
                p.id               AS "partyId",
                p.name             AS name,
                p.email            AS "partyEmail",
                p.phone            AS "partyPhone",
                p.city             AS "partyCity",
                l.initials, l.city, l.program, l.program_id AS "programId", l.value,
                l.description     AS "description",
                l.fee_paid        AS "feePaid",
                l.fee_due         AS "feeDue",
                l.due_date        AS "dueDate",
                l.registered_date AS "registeredDate",
                l.payment_proof_url AS "paymentProofUrl",
                l.stage, l.stage_label AS "stageLabel",
                l.source           AS "leadSource",
                l.source_label     AS "sourceLabel",
                l.score, l.heat, l.avatar,
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
              LEFT JOIN app_user u ON u.id = l.advisor_id
              WHERE wi.id = ${idOrNumber}
              LIMIT 1
            `
          : sql`
              SELECT
                wi.id              AS id,
                wi.number          AS number,
                p.id               AS "partyId",
                p.name             AS name,
                p.email            AS "partyEmail",
                p.phone            AS "partyPhone",
                p.city             AS "partyCity",
                l.initials, l.city, l.program, l.program_id AS "programId", l.value,
                l.description     AS "description",
                l.fee_paid        AS "feePaid",
                l.fee_due         AS "feeDue",
                l.due_date        AS "dueDate",
                l.registered_date AS "registeredDate",
                l.payment_proof_url AS "paymentProofUrl",
                l.stage, l.stage_label AS "stageLabel",
                l.source           AS "leadSource",
                l.source_label     AS "sourceLabel",
                l.score, l.heat, l.avatar,
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
              LEFT JOIN app_user u ON u.id = l.advisor_id
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

      // Timeline — only ai/you rows; auto/sent/need are home-page feed entries
      const timeline = await db.execute(sql`
        SELECT
          a.id         AS "id",
          a.actor_type AS "actorType",
          a.actor_name AS "actorName",
          a.verb       AS "verb",
          a.detail     AS "detail",
          a.tag        AS "tag",
          a.payload    AS "payload",
          a.ts         AS "ts"
        FROM activity a
        WHERE a.work_item_id = ${wiId}
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
          city:    row.partyCity,
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

      return { lead, timeline: timeline.rows, approval: approval.rows[0] ?? null, isLearner };
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
