// Outreach Agent — drafts a personalised follow-up email for one lead and
// queues it for human approval. The "send" itself is a placeholder until
// you wire SMTP/WhatsApp; on approve, the approvals route logs activity.

import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { callClaude } from "../lib/llm.js";
import { runAgent } from "./run.js";

const SYSTEM_PROMPT = `You are an outreach drafting assistant for an EdTech CRM (Digital Edify).
Your job is to draft a single warm, concise follow-up message to a prospective learner.

Hard rules:
- Output ONE message. 3 to 5 short sentences. Plain text body, no greeting block, no signature.
- Reference exactly ONE concrete signal from the lead's recent activity or context.
- Never invent prices, dates, names, scholarship amounts, or commitments.
- Do not be pushy. No urgency theater ("act now", "limited seats").
- Match Indian English. Friendly, professional, never gushing.
- Subject line: under 60 characters, no clickbait, no emoji.

Output JSON: {"subject": string, "body": string}`;

export interface DraftedEmail {
  approvalId: string;
  draft: { subject: string; body: string };
  runWorkItemId: string;
}

interface LeadContext {
  workItemId: string;
  number: string;
  partyId: string;
  name: string;
  program: string | null;
  city: string | null;
  score: number | null;
  heat: string | null;
  scoreReason: string | null;
  stage: string | null;
  stageLabel: string | null;
  signals: { text: string; weight: string; kind: string }[];
  recentActivity: { verb: string; detail: string | null; ts: Date }[];
}

async function loadLeadContext(tenantId: string, idOrNumber: string): Promise<LeadContext | null> {
  return await withTenant(tenantId, async (db) => {
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(idOrNumber);
    const r = await db.execute(
      isUuid
        ? sql`
            SELECT wi.id AS "workItemId", wi.number, wi.party_id AS "partyId",
                   p.name, l.program, l.city, l.score, l.heat,
                   l.score_reason AS "scoreReason", l.stage, l.stage_label AS "stageLabel"
            FROM lead l
            JOIN work_item wi ON wi.id = l.work_item_id
            JOIN party p      ON p.id  = wi.party_id
            WHERE wi.id = ${idOrNumber}
            LIMIT 1`
        : sql`
            SELECT wi.id AS "workItemId", wi.number, wi.party_id AS "partyId",
                   p.name, l.program, l.city, l.score, l.heat,
                   l.score_reason AS "scoreReason", l.stage, l.stage_label AS "stageLabel"
            FROM lead l
            JOIN work_item wi ON wi.id = l.work_item_id
            JOIN party p      ON p.id  = wi.party_id
            WHERE wi.number = ${idOrNumber}
            LIMIT 1`,
    );
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const workItemId = row.workItemId as string;

    const sigs = await db.execute(sql`
      SELECT text, weight, kind FROM lead_score_signal
      WHERE work_item_id = ${workItemId}
      ORDER BY rank
      LIMIT 6
    `);
    const acts = await db.execute(sql`
      SELECT verb, detail, ts FROM activity
      WHERE work_item_id = ${workItemId}
      ORDER BY ts DESC
      LIMIT 5
    `);

    return {
      workItemId,
      number: row.number as string,
      partyId: row.partyId as string,
      name: row.name as string,
      program: (row.program as string | null) ?? null,
      city: (row.city as string | null) ?? null,
      score: (row.score as number | null) ?? null,
      heat: (row.heat as string | null) ?? null,
      scoreReason: (row.scoreReason as string | null) ?? null,
      stage: (row.stage as string | null) ?? null,
      stageLabel: (row.stageLabel as string | null) ?? null,
      signals: sigs.rows as { text: string; weight: string; kind: string }[],
      recentActivity: acts.rows as { verb: string; detail: string | null; ts: Date }[],
    };
  });
}

function buildUserPrompt(c: LeadContext): string {
  const signals = c.signals.length
    ? c.signals.map((s) => `  - [${s.weight}] ${s.text} (${s.kind})`).join("\n")
    : "  (none recorded)";
  const recent = c.recentActivity.length
    ? c.recentActivity
        .map((a) => `  - ${a.verb}${a.detail ? `: ${a.detail.slice(0, 140)}` : ""}`)
        .join("\n")
    : "  (none)";
  return `Lead context:
- Name: ${c.name}
- Program of interest: ${c.program ?? "unspecified"}
- City: ${c.city ?? "unknown"}
- Stage: ${c.stageLabel ?? c.stage ?? "unknown"}
- Score: ${c.score ?? "n/a"} (${c.heat ?? "n/a"})
- Score reason: ${c.scoreReason ?? "n/a"}

Recent signals:
${signals}

Recent activity (most recent first):
${recent}

Task: Draft a follow-up message to advance this lead. Output JSON {"subject","body"}.`;
}

export async function draftFollowup(
  tenantId: string,
  idOrNumber: string,
): Promise<DraftedEmail> {
  const ctx = await loadLeadContext(tenantId, idOrNumber);
  if (!ctx) throw new Error("Lead not found");

  const { result, runWorkItemId } = await runAgent({
    tenantId,
    agentKey: "outreach",
    target: `drafting for ${ctx.name}`,
    steps: [
      { label: "plan", state: "queued" },
      { label: "retrieve_context", state: "queued" },
      { label: "draft", state: "queued" },
      { label: "approval_gate", state: "queued" },
    ],
    body: async ({ beginStep, endStep, db }) => {
      beginStep("plan");
      endStep(`Lead ${ctx.number} · score ${ctx.score ?? "?"}`);

      beginStep("retrieve_context");
      endStep(`${ctx.signals.length} signals, ${ctx.recentActivity.length} recent activities`);

      beginStep("draft");
      const out = await callClaude({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(ctx),
        expectJson: true,
        maxTokens: 600,
      });
      const draft = out.jsonValue as { subject?: unknown; body?: unknown } | undefined;
      const subject = typeof draft?.subject === "string" ? draft.subject.trim() : "";
      const body = typeof draft?.body === "string" ? draft.body.trim() : "";
      if (!subject || !body) {
        throw new Error("Claude returned empty subject or body");
      }
      endStep(`${out.usage.in}+${out.usage.out} tokens`);

      beginStep("approval_gate");
      const proposed = { channel: "email", subject, body };
      const ar = await db.execute(sql`
        INSERT INTO approval (
          tenant_id, work_item_id, action_type, mode, status, proposed, requested_by
        ) VALUES (
          ${tenantId}, ${ctx.workItemId},
          'send_email', 'supervised', 'pending',
          ${JSON.stringify(proposed)}::jsonb,
          'outreach'
        )
        RETURNING id
      `);
      const approvalId = (ar.rows[0] as { id: string }).id;

      // Activity row — visible in feed; payload.approvalId lets the UI render
      // an inline Approve button.
      await db.execute(sql`
        INSERT INTO activity (
          tenant_id, work_item_id, party_id, actor_type, actor_name,
          verb, detail, tag, icon_key, icon_bg, icon_stroke, payload, ts
        ) VALUES (
          ${tenantId}, ${ctx.workItemId}, ${ctx.partyId},
          'agent', 'Outreach Agent',
          'drafted a follow-up email for', ${`"${subject}" — awaiting your approval.`},
          'need', 'spark',
          'rgba(199,25,122,.1)', '#C7197A',
          ${JSON.stringify({ subject: ctx.name, approvalId, runWorkItemId: null })}::jsonb,
          NOW()
        )
      `);

      // Audit log.
      await db.execute(sql`
        INSERT INTO audit_log (tenant_id, actor_type, action, target_type, target_id, context)
        VALUES (
          ${tenantId}, 'agent', 'outreach_drafted', 'approval', ${approvalId},
          ${JSON.stringify({ workItemId: ctx.workItemId, model: out.model, tokensIn: out.usage.in, tokensOut: out.usage.out })}::jsonb
        )
      `);

      endStep("approval pending");
      return { approvalId, draft: { subject, body } };
    },
  });

  return { ...result, runWorkItemId };
}
